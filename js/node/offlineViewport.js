/**
 * Lightweight headless viewport that renders a single track to a node-canvas
 * buffer. Mirrors the rendering logic of TrackViewport.repaint() without any
 * DOM, event listeners, or UI components.
 */

import {getCanvasModule} from './environment.js'

class OfflineViewport {

    /**
     * @param {object}         track          - An igv.js Track instance (FeatureTrack, WigTrack, etc.)
     * @param {ReferenceFrame} referenceFrame - The ReferenceFrame defining the genomic region
     * @param {number}         width          - Pixel width of the canvas
     * @param {number}         height         - Pixel height of the canvas
     */
    constructor(track, referenceFrame, width, height) {
        this.track = track
        this.referenceFrame = referenceFrame
        this.width = width
        this.height = height
        this.contentTop = 0
        this.featureCache = null
        this.cachedFeatures = null
    }

    /**
     * Load features for the current genomic region from the track's data source.
     *
     * @param {object} genome - The Genome instance (needed for chromosome length look-ups)
     * @returns {Promise<Array|undefined>}
     */
    async loadFeatures(genome) {

        const chr = this.referenceFrame.chr
        const chromosome = genome ? await genome.loadChromosome(chr) : undefined
        const chrLength = chromosome ? chromosome.bpLength : Number.MAX_SAFE_INTEGER

        // Expand range a bit (same as TrackViewport) so edge features aren't clipped
        const bpWidth = this.width * this.referenceFrame.bpPerPixel
        const bpStart = Math.floor(Math.max(0, this.referenceFrame.start - bpWidth))
        const bpEnd = Math.ceil(Math.min(chrLength, this.referenceFrame.end + bpWidth))
        const bpPerPixel = this.referenceFrame.bpPerPixel

        if (typeof this.track.getFeatures === 'function') {
            const features = await this.track.getFeatures(chr, bpStart, bpEnd, bpPerPixel, this)
            this.cachedFeatures = features
            return features
        }

        return undefined
    }

    /**
     * Render the track onto a new node-canvas and return the canvas.
     *
     * @param {object} [features] - Pre-loaded features (if omitted uses this.cachedFeatures)
     * @returns {Promise<object>} A node-canvas Canvas instance
     */
    async render(features) {

        const {createCanvas} = await getCanvasModule()
        const canvas = createCanvas(this.width, this.height)
        const ctx = canvas.getContext('2d')

        features = features || this.cachedFeatures

        const drawConfiguration = {
            context: ctx,
            pixelWidth: this.width,
            pixelHeight: this.height,
            pixelTop: 0,
            bpStart: this.referenceFrame.start,
            bpEnd: this.referenceFrame.end,
            bpPerPixel: this.referenceFrame.bpPerPixel,
            referenceFrame: this.referenceFrame,
            viewport: this,
            viewportWidth: this.width,
            contentTop: this.contentTop,
            pixelXOffset: 0,
            pixelShift: 0,
            features: features,
        }

        if (features) {
            try {
                this.track.draw(drawConfiguration)
            } catch (e) {
                console.error(`[OfflineViewport] Error drawing track "${this.track.type || this.track.name}":`, e.message)
            }
        }

        return canvas
    }

    /**
     * Render the Y-axis decoration for this track.
     *
     * @param {number} axisWidth - Width in pixels for the axis canvas
     * @returns {Promise<object|undefined>} A node-canvas Canvas or undefined if the track has no paintAxis
     */
    async renderAxis(axisWidth) {

        if (typeof this.track.paintAxis !== 'function') {
            return undefined
        }

        const {createCanvas} = await getCanvasModule()
        const canvas = createCanvas(axisWidth, this.height)
        const ctx = canvas.getContext('2d')

        this.track.paintAxis(ctx, axisWidth, this.height)

        return canvas
    }

    // ── Stub methods expected by some track implementations ─────────────

    getWidth() {
        return this.width
    }

    isVisible() {
        return true
    }

    // Needed by some feature packing code that checks viewport.contentTop
    get pixelTop() {
        return 0
    }
}

export default OfflineViewport
