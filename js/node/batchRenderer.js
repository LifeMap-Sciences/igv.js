/**
 * BatchRenderer — processes many loci efficiently using worker_threads
 * parallelism.  Each worker gets its own OfflineBrowser with a fully
 * loaded genome and track set, then renders assigned jobs independently.
 *
 * Usage:
 *
 *   const renderer = new BatchRenderer({
 *     genome: 'hg38',
 *     tracks: [...],
 *     output: { width: 1560, height: 600, format: 'jpeg', quality: 85 },
 *     concurrency: 8,
 *   })
 *   await renderer.init()
 *
 *   await renderer.renderBatch(jobs, { onProgress })
 *
 *   renderer.dispose()
 */

import {Worker} from 'worker_threads'
import {fileURLToPath} from 'url'
import path from 'path'
import {installShims} from './environment.js'
import RenderProfiler from './profiler.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const WORKER_PATH = path.join(__dirname, 'worker.js')

class BatchRenderer {

    /**
     * @param {object} config
     * @param {string|object} config.genome      - Genome id or config
     * @param {Array}         config.tracks      - Track configuration array
     * @param {object}        [config.output]    - Default output settings
     * @param {number}        [config.output.width=1560]
     * @param {number}        [config.output.height=600]
     * @param {string}        [config.output.format='jpeg']
     * @param {number}        [config.output.quality=85]
     * @param {number}        [config.concurrency=4] - Number of worker threads
     */
    constructor(config) {
        this.config = config
        this.output = Object.assign(
            {width: 1560, height: 600, format: 'jpeg', quality: 85},
            config.output || {}
        )
        this.concurrency = config.concurrency || 4
        this._workers = []
        this._initialized = false

        /** @type {RenderProfiler|null} Aggregated profiler (populated after collectProfile()) */
        this.profiler = config.profiling ? new RenderProfiler() : null
    }

    /**
     * Spawn worker threads and wait for each to initialize (load genome + tracks).
     */
    async init() {
        if (this._initialized) return

        // Install shims in main thread too (needed for any main-thread igv imports)
        installShims({devicePixelRatio: this.config.devicePixelRatio ?? 1})

        const browserConfig = {
            genome: this.config.genome,
            reference: this.config.reference,
            tracks: this.config.tracks || [],
            flanking: this.config.flanking,
            minimumBases: this.config.minimumBases,
            trackDefaults: this.config.trackDefaults,
            loadDefaultGenomes: this.config.loadDefaultGenomes ?? true,
            profiling: !!this.config.profiling,
        }

        const initPromises = []
        for (let i = 0; i < this.concurrency; i++) {
            initPromises.push(this._spawnWorker(browserConfig))
        }

        this._workers = await Promise.all(initPromises)
        this._initialized = true
    }

    /**
     * Spawn a single worker thread and wait for it to become ready.
     *
     * @param {object} browserConfig
     * @returns {Promise<Worker>}
     */
    _spawnWorker(browserConfig) {

        return new Promise((resolve, reject) => {
            const worker = new Worker(WORKER_PATH, {
                // Pass __dirname so the worker can resolve relative imports
                workerData: {baseDir: __dirname},
            })

            const onMessage = (msg) => {
                if (msg.type === 'ready') {
                    worker.removeListener('message', onMessage)
                    resolve(worker)
                } else if (msg.type === 'error' && msg.job === null) {
                    worker.removeListener('message', onMessage)
                    reject(new Error(`Worker init failed: ${msg.message}`))
                }
            }

            worker.on('message', onMessage)
            worker.on('error', reject)

            worker.postMessage({type: 'init', config: browserConfig})
        })
    }

    /**
     * Process an array of rendering jobs in parallel across workers.
     *
     * @param {Array<object>} jobs - Array of job objects:
     *   { locus: string, outputPath: string, width?, height?, format?, quality?, meta? }
     *
     * @param {object}   [options]
     * @param {Function} [options.onProgress]  - Called as (completed, total, job)
     * @param {Function} [options.onError]     - Called as (job, errorMessage)
     * @param {boolean}  [options.groupByChromosome=true] - Sort jobs by chromosome for locality
     *
     * @returns {Promise<{completed: number, failed: number, errors: Array}>}
     */
    async renderBatch(jobs, options = {}) {

        if (!this._initialized) {
            throw new Error('BatchRenderer not initialized. Call init() first.')
        }

        const groupByChromosome = options.groupByChromosome !== false
        const onProgress = options.onProgress || (() => {})
        const onError = options.onError || (() => {})

        // Optionally sort by chromosome for better data locality
        const sortedJobs = groupByChromosome ? sortByChromosome(jobs) : [...jobs]

        const total = sortedJobs.length
        let completed = 0
        let failed = 0
        const errors = []

        // Job queue — each worker pulls the next job when done
        const queue = [...sortedJobs]

        const workerPromises = this._workers.map((worker) => {
            return this._runWorkerLoop(worker, queue, (job) => {
                completed++
                onProgress(completed, total, job)
            }, (job, message) => {
                failed++
                errors.push({job, message})
                onError(job, message)
            })
        })

        await Promise.all(workerPromises)

        return {completed: completed - failed, failed, errors}
    }

    /**
     * Run a single worker's processing loop — grab jobs from the shared queue
     * until empty.
     */
    _runWorkerLoop(worker, queue, onDone, onError) {

        return new Promise((resolve) => {

            const sendNext = () => {
                if (queue.length === 0) {
                    worker.removeListener('message', messageHandler)
                    resolve()
                    return
                }

                const job = queue.shift()
                // Merge default output settings with job-level overrides
                const fullJob = Object.assign(
                    {},
                    {
                        width: this.output.width,
                        height: this.output.height,
                        format: this.output.format,
                        quality: this.output.quality,
                    },
                    job
                )

                worker.postMessage({type: 'render', job: fullJob})
            }

            const messageHandler = (msg) => {
                if (msg.type === 'done') {
                    onDone(msg.job)
                    sendNext()
                } else if (msg.type === 'error') {
                    onError(msg.job, msg.message)
                    sendNext()
                }
            }

            worker.on('message', messageHandler)

            // Kick off the first job
            sendNext()
        })
    }

    /**
     * Collect profiling data from all worker threads and merge into this.profiler.
     * Call after renderBatch() completes and before dispose().
     *
     * @returns {Promise<RenderProfiler|null>} The merged profiler, or null if profiling is disabled
     */
    async collectProfile() {
        if (!this.profiler) return null

        const profilePromises = this._workers.map((worker) => {
            return new Promise((resolve) => {
                const handler = (msg) => {
                    if (msg.type === 'profile') {
                        worker.removeListener('message', handler)
                        resolve(msg.data)
                    }
                }
                worker.on('message', handler)
                worker.postMessage({type: 'getProfile'})
            })
        })

        const profiles = await Promise.all(profilePromises)
        for (const data of profiles) {
            if (data) {
                this.profiler.merge(data)
            }
        }

        return this.profiler
    }

    /**
     * Shut down all worker threads and release resources.
     */
    dispose() {
        for (const worker of this._workers) {
            try {
                worker.postMessage({type: 'exit'})
                // Give a short grace period, then force-terminate
                setTimeout(() => worker.terminate(), 2000)
            } catch (e) {
                // Worker may already be terminated
            }
        }
        this._workers = []
        this._initialized = false
    }
}

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Sort jobs by chromosome for better data locality — processing all genes on
 * the same chromosome together avoids expensive chromosome switching.
 */
function sortByChromosome(jobs) {

    return [...jobs].sort((a, b) => {
        const chrA = extractChromosome(a.locus)
        const chrB = extractChromosome(b.locus)

        const numA = chrToSortKey(chrA)
        const numB = chrToSortKey(chrB)

        if (numA !== numB) return numA - numB

        // Same chromosome — sort by start position
        const startA = extractStart(a.locus)
        const startB = extractStart(b.locus)
        return startA - startB
    })
}

function extractChromosome(locus) {
    if (!locus) return ''
    const colonIdx = locus.indexOf(':')
    return colonIdx > 0 ? locus.substring(0, colonIdx) : locus
}

function extractStart(locus) {
    if (!locus) return 0
    const colonIdx = locus.indexOf(':')
    if (colonIdx < 0) return 0
    const rest = locus.substring(colonIdx + 1)
    const dashIdx = rest.indexOf('-')
    const numStr = dashIdx > 0 ? rest.substring(0, dashIdx) : rest
    return parseInt(numStr.replace(/,/g, ''), 10) || 0
}

function chrToSortKey(chr) {
    const name = chr.replace(/^chr/i, '')
    const num = parseInt(name, 10)
    if (!isNaN(num)) return num
    if (name === 'X') return 23
    if (name === 'Y') return 24
    if (name === 'M' || name === 'MT') return 25
    return 100  // Unknown chromosomes sort last
}

export default BatchRenderer
