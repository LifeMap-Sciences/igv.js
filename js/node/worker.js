/**
 * Worker thread script for BatchRenderer.
 *
 * Each worker initializes its own OfflineBrowser instance (with genome +
 * tracks already loaded) and processes jobs from the parent thread.
 *
 * Communication protocol (via parentPort):
 *   Parent → Worker:
 *     { type: 'init',   config }           — initialize browser
 *     { type: 'render', job }              — render a single job
 *     { type: 'exit' }                     — clean up and exit
 *
 *   Worker → Parent:
 *     { type: 'ready' }                    — init complete
 *     { type: 'done',  job }               — job rendered successfully
 *     { type: 'error', job, message }      — job failed
 *     { type: 'exited' }                   — cleanup complete
 */

import {parentPort, workerData} from 'worker_threads'

let browser = null

parentPort.on('message', async (msg) => {

    switch (msg.type) {

        case 'init': {
            try {
                // Dynamic import so environment shims are installed first
                const {default: OfflineBrowser} = await import('./offlineBrowser.js')
                browser = new OfflineBrowser(msg.config)
                await browser.init()
                parentPort.postMessage({type: 'ready'})
            } catch (e) {
                parentPort.postMessage({type: 'error', job: null, message: e.message || String(e)})
            }
            break
        }

        case 'render': {
            const job = msg.job
            try {
                if (!browser) {
                    throw new Error('Worker not initialized')
                }

                const options = {
                    format: job.format || 'jpeg',
                    quality: job.quality ?? 85,
                    axis: job.axis || false,
                    axisWidth: job.axisWidth || 50,
                    trackHeights: job.trackHeights,
                    backgroundColor: job.backgroundColor,
                }

                await browser.renderToFile(
                    job.locus,
                    job.width,
                    job.outputPath,
                    options
                )

                parentPort.postMessage({type: 'done', job})
            } catch (e) {
                parentPort.postMessage({
                    type: 'error',
                    job,
                    message: e.message || String(e)
                })
            }
            break
        }

        case 'exit': {
            if (browser) {
                browser.dispose()
                browser = null
            }
            parentPort.postMessage({type: 'exited'})
            break
        }
    }
})
