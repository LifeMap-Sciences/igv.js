/**
 * RenderProfiler — lightweight performance profiler for offline rendering.
 *
 * Tracks per-render timing broken down by phase:
 *   goto, loadFeatures, computeHeight, render, compose, encode, write, total
 *
 * Sub-phases within loadFeatures (when instrumentFeatureSources is called):
 *   fetch (HTTP + decompress + parse), pack (feature row assignment)
 *
 * Sub-phases within render:
 *   createCanvas, draw
 *
 * Also tracks non-timing counters (feature counts, HTTP requests, etc.)
 *
 * Usage:
 *   const profiler = new RenderProfiler()
 *   browser.profiler = profiler
 *
 *   // ... render many genes ...
 *
 *   profiler.report()  // prints summary to stderr
 *   const stats = profiler.summary()  // returns structured data
 */

class RenderProfiler {

    constructor() {
        /** @type {Map<string, number[]>} phase name → array of durations (ms) */
        this.timings = new Map()

        /** @type {Map<string, number[]>} counter name → array of values */
        this.counters = new Map()

        /** @type {Array<object>} per-render detail records */
        this.renders = []

        /** @private current render being recorded */
        this._current = null
    }

    /**
     * Start recording a new render operation.
     * @param {string} locus - the locus being rendered
     */
    startRender(locus) {
        this._current = {
            locus,
            phases: {},
            counters: {},
            trackDetails: [],
            startTime: performance.now(),
        }
    }

    /**
     * Record the start of a phase within the current render.
     * @param {string} phase - phase name (e.g. 'goto', 'compose', 'encode')
     * @returns {function} call to end the phase and record its duration
     */
    time(phase) {
        const start = performance.now()
        return () => {
            const duration = performance.now() - start
            if (this._current) {
                this._current.phases[phase] = (this._current.phases[phase] || 0) + duration
            }
            this._record(phase, duration)
            return duration
        }
    }

    /**
     * Record a per-track timing within the current render.
     * @param {string} phase - e.g. 'loadFeatures', 'render', 'fetch', 'pack'
     * @param {string} trackName - track identifier
     * @param {number} duration - milliseconds
     */
    trackDetail(phase, trackName, duration) {
        if (this._current) {
            this._current.trackDetails.push({phase, track: trackName, duration})
        }
        // Also record under a composite key for aggregate stats
        this._record(`${phase}:${trackName}`, duration)
    }

    /**
     * Record a non-timing counter value (e.g. feature count, HTTP request count).
     * @param {string} name - counter name (e.g. 'featureCount', 'httpRequests')
     * @param {number} value - the value to record
     */
    count(name, value) {
        if (this._current) {
            this._current.counters[name] = (this._current.counters[name] || 0) + value
        }
        let arr = this.counters.get(name)
        if (!arr) {
            arr = []
            this.counters.set(name, arr)
        }
        arr.push(value)
    }

    /**
     * End recording the current render operation.
     */
    endRender() {
        if (!this._current) return

        const total = performance.now() - this._current.startTime
        this._current.phases.total = total
        this._record('total', total)

        this.renders.push(this._current)
        this._current = null
    }

    /** @private */
    _record(key, value) {
        let arr = this.timings.get(key)
        if (!arr) {
            arr = []
            this.timings.set(key, arr)
        }
        arr.push(value)
    }

    /**
     * Compute summary statistics for all phases.
     * @returns {object} Map of phase → {count, total, mean, median, p95, max, min}
     */
    summary() {
        const result = {}
        for (const [phase, values] of this.timings) {
            result[phase] = computeStats(values)
        }
        return result
    }

    /**
     * Compute summary statistics for all counters.
     * @returns {object} Map of counter → {count, total, mean, median, p95, max, min}
     */
    counterSummary() {
        const result = {}
        for (const [name, values] of this.counters) {
            result[name] = computeStats(values)
        }
        return result
    }

    /**
     * Find the N slowest renders.
     * @param {number} [n=10]
     * @returns {Array<object>} sorted slowest-first
     */
    slowest(n = 10) {
        return [...this.renders]
            .sort((a, b) => b.phases.total - a.phases.total)
            .slice(0, n)
            .map(r => ({
                locus: r.locus,
                total: r.phases.total,
                phases: r.phases,
                counters: r.counters,
                trackDetails: r.trackDetails,
            }))
    }

    /**
     * Print a formatted summary report to stderr.
     */
    report() {
        const summary = this.summary()
        const counterSummary = this.counterSummary()
        const renderCount = this.timings.get('total')?.length || 0

        const lines = []
        lines.push('')
        lines.push('=== Render Performance Profile ===')
        lines.push(`Total renders: ${renderCount}`)
        if (renderCount === 0) {
            console.error(lines.join('\n'))
            return
        }

        const totalStats = summary['total']
        lines.push(`Wall time (total phase): ${fmt(totalStats.total)}`)
        lines.push('')

        // Main phases table
        lines.push('Phase Breakdown (ms):')
        lines.push(padRow('Phase', 'Count', 'Total', 'Mean', 'Median', 'P95', 'Max'))
        lines.push('-'.repeat(95))

        const mainPhases = ['total', 'goto', 'loadFeatures', 'fetch', 'pack', 'computeHeight',
            'render', 'createCanvas', 'draw', 'navbar', 'compose', 'encode', 'write']
        for (const phase of mainPhases) {
            const s = summary[phase]
            if (s) {
                lines.push(padRow(phase, s.count, fmt(s.total), fmt(s.mean), fmt(s.median), fmt(s.p95), fmt(s.max)))
            }
        }

        // Per-track breakdowns
        const trackPhases = Object.keys(summary)
            .filter(k => k.includes(':'))
            .sort()

        if (trackPhases.length > 0) {
            lines.push('')
            lines.push('Per-Track Breakdown (ms):')
            lines.push(padRow('Phase:Track', 'Count', 'Total', 'Mean', 'Median', 'P95', 'Max'))
            lines.push('-'.repeat(95))

            for (const key of trackPhases) {
                const s = summary[key]
                lines.push(padRow(key, s.count, fmt(s.total), fmt(s.mean), fmt(s.median), fmt(s.p95), fmt(s.max)))
            }
        }

        // Counters
        const counterNames = Object.keys(counterSummary)
        if (counterNames.length > 0) {
            lines.push('')
            lines.push('Counters:')
            lines.push(padRow('Counter', 'Count', 'Total', 'Mean', 'Median', 'P95', 'Max'))
            lines.push('-'.repeat(95))

            for (const name of counterNames.sort()) {
                const s = counterSummary[name]
                lines.push(padRow(name, s.count, fmtInt(s.total), fmtInt(s.mean), fmtInt(s.median), fmtInt(s.p95), fmtInt(s.max)))
            }
        }

        // Slowest renders
        const slowest = this.slowest(5)
        if (slowest.length > 0) {
            lines.push('')
            lines.push('Top 5 Slowest Renders:')
            for (let i = 0; i < slowest.length; i++) {
                const r = slowest[i]
                const breakdown = Object.entries(r.phases)
                    .filter(([k]) => k !== 'total')
                    .map(([k, v]) => `${k}=${fmt(v)}`)
                    .join(', ')
                const counters = Object.entries(r.counters || {})
                    .map(([k, v]) => `${k}=${v}`)
                    .join(', ')
                let line = `  ${i + 1}. ${r.locus} — ${fmt(r.total)} (${breakdown})`
                if (counters) line += ` [${counters}]`
                lines.push(line)
            }
        }

        lines.push('')
        console.error(lines.join('\n'))
    }

    /**
     * Merge timings from another profiler (e.g. from a worker thread).
     * @param {object} data - serialized profiler data {timings, counters, renders}
     */
    merge(data) {
        if (data.timings) {
            for (const [key, values] of Object.entries(data.timings)) {
                let arr = this.timings.get(key)
                if (!arr) {
                    arr = []
                    this.timings.set(key, arr)
                }
                arr.push(...values)
            }
        }
        if (data.counters) {
            for (const [key, values] of Object.entries(data.counters)) {
                let arr = this.counters.get(key)
                if (!arr) {
                    arr = []
                    this.counters.set(key, arr)
                }
                arr.push(...values)
            }
        }
        if (data.renders) {
            this.renders.push(...data.renders)
        }
    }

    /**
     * Serialize profiler data for transfer (e.g. from worker to main thread).
     * @returns {object}
     */
    serialize() {
        const timings = {}
        for (const [key, values] of this.timings) {
            timings[key] = values
        }
        const counters = {}
        for (const [key, values] of this.counters) {
            counters[key] = values
        }
        return {
            timings,
            counters,
            renders: this.renders.map(r => ({
                locus: r.locus,
                phases: r.phases,
                counters: r.counters,
                trackDetails: r.trackDetails,
            })),
        }
    }

    /**
     * Reset all collected data.
     */
    reset() {
        this.timings.clear()
        this.counters.clear()
        this.renders = []
        this._current = null
    }
}

// ── Statistics helpers ──────────────────────────────────────────────────────

function computeStats(values) {
    const sorted = [...values].sort((a, b) => a - b)
    const n = sorted.length
    return {
        count: n,
        total: values.reduce((s, v) => s + v, 0),
        mean: values.reduce((s, v) => s + v, 0) / n,
        median: n % 2 === 0
            ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2
            : sorted[Math.floor(n / 2)],
        p95: sorted[Math.min(Math.ceil(n * 0.95) - 1, n - 1)],
        max: sorted[n - 1],
        min: sorted[0],
    }
}

function fmt(ms) {
    if (ms >= 1000) return (ms / 1000).toFixed(2) + 's'
    return ms.toFixed(1) + 'ms'
}

function fmtInt(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M'
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k'
    return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

function padRow(...cols) {
    const widths = [25, 7, 12, 12, 12, 12, 12]
    return cols.map((c, i) => String(c).padEnd(widths[i] || 12)).join('')
}

export default RenderProfiler
