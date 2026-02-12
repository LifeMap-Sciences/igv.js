/**
 * PreloadedFeatureSource — an in-memory feature source that serves pre-parsed
 * features from a file that was fully decompressed and parsed at startup.
 *
 * Eliminates all per-query HTTP, BGZF decompression, and text parsing overhead.
 * Features are stored per-chromosome in sorted arrays and looked up via binary search.
 */

import {packFeatures} from '../feature/featureUtils.js'

class PreloadedFeatureSource {

    /**
     * @param {Map<string, Array>} featuresByChromosome - Features grouped by chromosome name, sorted by start
     * @param {object} header - Parsed header from the file
     */
    constructor(featuresByChromosome, header) {
        this.featuresByChromosome = featuresByChromosome
        this.header = header || {}
        this.searchable = false
    }

    async getHeader() {
        return this.header
    }

    /**
     * Return features overlapping the requested region.
     * Uses binary search to efficiently find the start of overlapping features.
     */
    async getFeatures({chr, start, end, bpPerPixel, visibilityWindow}) {

        const chrFeatures = this.featuresByChromosome.get(chr)
        if (!chrFeatures || chrFeatures.length === 0) return []

        start = start || 0
        end = end || Number.MAX_SAFE_INTEGER

        // Binary search for first feature whose end >= start (could overlap)
        let lo = 0, hi = chrFeatures.length
        while (lo < hi) {
            const mid = (lo + hi) >> 1
            if (chrFeatures[mid].end < start) {
                lo = mid + 1
            } else {
                hi = mid
            }
        }

        // Collect all features overlapping [start, end]
        const result = []
        for (let i = lo; i < chrFeatures.length; i++) {
            const f = chrFeatures[i]
            if (f.start > end) break
            if (f.end >= start) {
                result.push(f)
            }
        }

        // Pack features for row assignment (needed for rendering)
        if (result.length > 0) {
            packFeatures(result, Number.MAX_SAFE_INTEGER)
        }

        return result
    }
}

export default PreloadedFeatureSource
