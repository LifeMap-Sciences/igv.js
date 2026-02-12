/**
 * OfflineBrowser — a headless replacement for Browser that manages genome,
 * tracks and reference frames without any DOM, UI components, or event wiring.
 *
 * It exposes just enough of the Browser interface so that existing Track
 * classes (FeatureTrack, WigTrack, BAMTrack, etc.) work unchanged when they
 * reference `this.browser.*`.
 */

import {installShims, getCanvasModule, initNativeZlib} from './environment.js'
import OfflineViewport from './offlineViewport.js'
import Compositor from './compositor.js'
import PreloadedFeatureSource from './preloadedFeatureSource.js'

import GenomeUtils from '../genome/genomeUtils.js'
import Genome from '../genome/genome.js'
import {createReferenceFrameList} from '../referenceFrame.js'
import {parseLocusString} from '../search.js'
import * as TrackUtils from '../util/trackUtils.js'
import {StringUtils, URIUtils} from '../../node_modules/igv-utils/src/index.js'
import IdeogramTrack from '../ideogramTrack.js'
import RulerTrack from '../rulerTrack.js'

// Track factory and feature source are loaded lazily to avoid the circular
// dependency chain (featureSource→textFeatureSource→wigTrack→featureSource)
// that causes class initialization order issues in bundled output.
let _trackFactory = null
let _FeatureSource = null

async function getTrackFactory() {
    if (!_trackFactory) {
        _trackFactory = await import('../trackFactory.js')
    }
    return _trackFactory
}

async function getFeatureSourceModule() {
    if (!_FeatureSource) {
        const mod = await import('../feature/featureSource.js')
        _FeatureSource = mod.default
    }
    return _FeatureSource
}

class OfflineBrowser {

    /**
     * @param {object} config - igv.js-compatible browser configuration
     *   Required: `genome` (string id or config object)
     *   Optional: `tracks`, `flanking`, `minimumBases`, `trackDefaults`,
     *             `showIdeogram`, `showRuler` (default false)
     */
    constructor(config) {
        // Install Node.js shims (idempotent)
        installShims({devicePixelRatio: config.devicePixelRatio ?? 1})

        this.config = Object.assign({}, defaultConfig, config)
        this.genome = null
        this.tracks = []
        this.referenceFrameList = []
        this.roiSets = []
        this.flanking = this.config.flanking
        this.trackDefaults = this.config.trackDefaults || {}
        this.nucleotideColors = this.config.nucleotideColors
        this.qtlSelections = emptyQtlSelections
        this._initialized = false

        /** @type {RenderProfiler|null} Set to a RenderProfiler instance to enable profiling */
        this.profiler = null
    }

    // ── Initialization ─────────────────────────────────────────────────

    /**
     * Async initialization — loads genome and any tracks specified in config.
     * Must be called before rendering.
     */
    async init() {
        if (this._initialized) return

        // Use native zlib for ~5-10x faster BGZF decompression
        await initNativeZlib()

        // Initialize known genome definitions (shared cache)
        if (!GenomeUtils.KNOWN_GENOMES) {
            await GenomeUtils.initializeGenomes(this.config)
        }

        // Resolve genome config
        const genomeOrRef = this.config.reference || this.config.genome
        if (!genomeOrRef) {
            throw new Error('OfflineBrowser: no genome or reference specified in config')
        }

        let genomeConfig
        if (StringUtils.isString(genomeOrRef)) {
            genomeConfig = await GenomeUtils.expandReference(noopAlert, genomeOrRef)
        } else {
            genomeConfig = genomeOrRef
        }

        // Create genome
        this.genome = await Genome.createGenome(genomeConfig, this)

        // Create built-in tracks (ideogram and ruler) if requested
        if (this.config.showIdeogram && this.genome.cytobandSource) {
            const ideogramTrack = new IdeogramTrack(this)
            this.tracks.push(ideogramTrack)
        }

        if (this.config.showRuler) {
            const rulerTrack = new RulerTrack(this)
            this.tracks.push(rulerTrack)
        }

        // Load configured tracks (skip ideogram, ruler, sequence from genome config)
        const trackConfigs = [
            ...(genomeConfig.tracks || []),
            ...(this.config.tracks || [])
        ].filter(c => !isUIOnlyTrack(c))

        for (const tc of trackConfigs) {
            await this.loadTrack(tc)
        }

        this._initialized = true
    }

    /**
     * Configure all track feature sources for optimal offline batch rendering.
     * Sets a large query expansion factor so consecutive renders on the same
     * chromosome reuse cached features instead of re-fetching.
     *
     * @param {number} [expandFactor=100] - Expansion multiplier for query intervals
     */
    configureForBatchRendering(expandFactor = 10) {
        for (const track of this.tracks) {
            const source = track.featureSource
            if (source && source.config) {
                source.config.expandQueryFactor = expandFactor
            }
        }
    }

    /**
     * Monkey-patch feature sources on loaded tracks to instrument the internal
     * sub-phases of feature loading: fetch (HTTP + decompress + parse) vs pack
     * (feature row assignment). Only active when this.profiler is set.
     *
     * Call after init() and after setting this.profiler.
     */
    instrumentFeatureSources() {
        const p = this.profiler
        if (!p) return

        for (const track of this.tracks) {
            const source = track.featureSource
            if (!source || typeof source.loadFeatures !== 'function') continue

            const trackName = track.config?.name || track.name || track.type || 'unknown'

            // Wrap TextFeatureSource.loadFeatures to time sub-phases
            const origLoadFeatures = source.loadFeatures.bind(source)
            source.loadFeatures = async function (chr, start, end, visibilityWindow) {
                // Time the reader.readFeatures call (HTTP + decompress + parse)
                const reader = source.reader
                let fetchMs = 0
                if (reader && typeof reader.readFeatures === 'function') {
                    const origReadFeatures = reader.readFeatures.bind(reader)
                    reader.readFeatures = async function (...args) {
                        const endFetch = p.time('fetch')
                        const result = await origReadFeatures(...args)
                        fetchMs = endFetch()
                        p.trackDetail('fetch', trackName, fetchMs)
                        if (result) p.count('featuresFetched', result.length)
                        // Restore original to avoid double-wrapping
                        reader.readFeatures = origReadFeatures
                        return result
                    }
                }

                const endTotal = p.time('_sourceLoadFeatures')
                await origLoadFeatures(chr, start, end, visibilityWindow)
                const totalMs = endTotal()

                // packFeatures time ≈ total - fetch
                const packMs = totalMs - fetchMs
                if (packMs > 0) {
                    p._record('pack', packMs)
                    p.trackDetail('pack', trackName, packMs)
                }
            }
        }
    }

    // ── Pre-loading ───────────────────────────────────────────────────

    /**
     * Pre-load an entire compressed file (BGZF .gz or plain .gz) into memory,
     * decompress, parse, and replace the track's feature source with an in-memory
     * version. This eliminates all per-query HTTP, decompression, and parsing.
     *
     * @param {object} track - A loaded Track instance (must have featureSource)
     * @param {string} filePath - Absolute path to the .gz file on disk
     * @returns {Promise<void>}
     */
    async preloadTrackFromFile(track, filePath) {

        const fs = await import('fs')
        const zlib = await import('zlib')
        const getDataWrapper = (await import('../feature/dataWrapper.js')).default
        const FeatureParser = (await import('../feature/featureParser.js')).default

        // Read and decompress the entire file into a Buffer (not a string,
        // which would fail for files >512MB due to V8's string length limit)
        const compressed = fs.readFileSync(filePath)
        const decompressed = zlib.gunzipSync(compressed)

        // Create parser matching the track's format
        const parser = new FeatureParser(track.config)

        // Parse header (consumes directive/comment lines)
        const headerWrapper = getDataWrapper(decompressed)
        const header = await parser.parseHeader(headerWrapper)

        // Parse all features (re-wraps same buffer — parseFeatures skips header lines)
        const dataWrapper = getDataWrapper(decompressed)
        const features = await parser.parseFeatures(dataWrapper)

        // Build chromosome alias map: feature chr name → canonical genome name
        // e.g. "1" → "chr1", "MT" → "chrM"
        const chrAliasMap = new Map()
        if (this.genome) {
            const featureChrNames = new Set(features.map(f => f.chr))
            for (const name of featureChrNames) {
                const chromosome = await this.genome.loadChromosome(name)
                if (chromosome) {
                    chrAliasMap.set(name, chromosome.name)
                }
            }
        }

        // Group features by canonical chromosome name, sorted by start
        const featuresByChromosome = new Map()
        for (const f of features) {
            const canonicalChr = chrAliasMap.get(f.chr) || f.chr
            // Update the feature's chr to canonical name for consistent lookups
            f.chr = canonicalChr
            let list = featuresByChromosome.get(canonicalChr)
            if (!list) {
                list = []
                featuresByChromosome.set(canonicalChr, list)
            }
            list.push(f)
        }
        for (const [, list] of featuresByChromosome) {
            list.sort((a, b) => a.start - b.start)
        }

        // Replace the track's feature source with the in-memory version
        track.featureSource = new PreloadedFeatureSource(featuresByChromosome, header)

        const totalFeatures = features.length
        const chrCount = featuresByChromosome.size
        console.error(`[preload] ${track.name || track.type}: ${totalFeatures} features across ${chrCount} chromosomes`)
    }

    // ── Track management ───────────────────────────────────────────────

    /**
     * Create and add a track from its configuration.
     *
     * @param {object} config - igv.js track configuration
     * @returns {Promise<object>} The created Track instance
     */
    async loadTrack(config) {

        if (StringUtils.isString(config)) {
            config = JSON.parse(config)
        }

        // Offline rendering never needs feature search — skip the expensive
        // addFeaturesToDB() call that re-parses GFF attribute strings.
        if (config.searchable === undefined) {
            config.searchable = false
        }

        const track = await this.createTrack(config)
        if (track) {
            if (typeof track.postInit === 'function') {
                await track.postInit()
            }
            if (track.order === undefined) {
                track.order = this.tracks.length
            }
            this.tracks.push(track)
        }
        return track
    }

    /**
     * Low-level track creation — mirrors Browser.createTrack() but without DOM.
     */
    async createTrack(config) {

        // Resolve URLs
        let url = await URIUtils.resolveURL(config.url || config.fastaURL)
        if (StringUtils.isString(url)) {
            url = url.trim()
        }

        if (url) {
            if (config.format) {
                config.format = config.format.toLowerCase()
            } else if (config.fastaURL) {
                config.format = 'fasta'
            } else if (!config.sourceType) {
                const {inferFileFormat} = await import('../util/fileFormatUtils.js')
                const format = await inferFileFormat(config)
                if (format) config.format = format
            }
        }

        if (config.type) {
            TrackUtils.translateDeprecatedTypes(config)
        }

        let type = config.type ? config.type.toLowerCase() : undefined

        const factory = await getTrackFactory()

        if (!type) {
            if (!config.format) {
                throw new Error(`Unrecognized track: ${config.name || config.url || '(unknown)'}`)
            }
            type = TrackUtils.inferTrackType(config.format)
            if ('bedtype' === type) {
                const FeatureSource = await getFeatureSourceModule()
                const featureSource = FeatureSource(config, this.genome)
                config._featureSource = featureSource
                const trackType = await featureSource.trackType()
                type = (trackType && factory.knownTrackTypes().has(trackType)) ? trackType : 'annotation'
            }
            config.type = type
        }

        // Apply track defaults
        if (this.trackDefaults && type) {
            const settings = this.trackDefaults[type]
            if (settings) {
                for (const prop in settings) {
                    if (settings.hasOwnProperty(prop) && config[prop] === undefined) {
                        config[prop] = settings[prop]
                    }
                }
            }
        }

        const track = factory.getTrack(type, config, this)
        if (!track) {
            console.warn(`Could not create track of type "${type}" for: ${config.url || JSON.stringify(config)}`)
        }
        return track
    }

    // ── Locus navigation ───────────────────────────────────────────────

    /**
     * Parse a locus string and build reference frames for it.
     *
     * @param {string} locusString - e.g. "chr14:104762747-104802361"
     * @param {number} viewportWidth - Pixel width of the viewport
     * @returns {Promise<Array>} Array of ReferenceFrame objects
     */
    async goto(locusString, viewportWidth) {

        const loci = await this._parseLocus(locusString)
        if (!loci || loci.length === 0) {
            throw new Error(`Cannot parse locus: "${locusString}"`)
        }

        this.referenceFrameList = createReferenceFrameList(
            loci,
            this.genome,
            this.flanking,
            this.minimumBases(),
            viewportWidth,
            false  // isSoftclipped
        )

        return this.referenceFrameList
    }

    /**
     * Internal helper — parses a locus string into [{chr, start, end}] using
     * the same logic as the browser search() function.
     */
    async _parseLocus(locusString) {

        if (!locusString) return undefined

        const loci = locusString.split(' ')
        const results = []

        for (const locus of loci) {
            let locusObject

            if (locus.includes(':')) {
                locusObject = parseLocusString(locus, false)
                if (locusObject) {
                    const chromosome = await this.genome.loadChromosome(locusObject.chr)
                    if (chromosome) {
                        locusObject.chr = chromosome.name
                    } else {
                        locusObject = undefined
                    }
                }
            }

            if (!locusObject) {
                // Try as chromosome name
                const chromosome = await this.genome.loadChromosome(locus)
                if (chromosome) {
                    locusObject = {chr: chromosome.name, start: 0, end: chromosome.bpLength}
                }
            }

            if (locusObject) {
                if (locusObject.start === undefined) locusObject.start = 0
                if (locusObject.end === undefined) {
                    const chr = await this.genome.loadChromosome(locusObject.chr)
                    locusObject.end = chr ? chr.bpLength : locusObject.start + 1000
                }
                results.push(locusObject)
            }
        }

        return results.length > 0 ? results : undefined
    }

    // ── Rendering ──────────────────────────────────────────────────────

    /**
     * Render all tracks at the given locus and return a composite Canvas.
     *
     * Track heights are computed dynamically based on features (using each
     * track's computePixelHeight method) rather than dividing a fixed total
     * height.  The output image height is the sum of all track heights.
     *
     * @param {string} locus   - Genomic locus, e.g. "chr14:104762747-104802361"
     * @param {number} width   - Output image width in pixels
     * @param {object} [options]
     * @param {number[]} [options.trackHeights] - Explicit per-track heights (overrides dynamic)
     * @param {boolean}  [options.axis]         - Include Y-axis strip (default false)
     * @param {number}   [options.axisWidth]    - Width of axis strip (default 50)
     * @param {boolean}  [options.trackLabels]  - Draw track label badges (default false)
     * @param {boolean}  [options.showNavbar]   - Draw igv.js navigation bar at top (default false)
     * @returns {Promise<object>} A node-canvas Canvas instance
     */
    async renderLocus(locus, width, options = {}) {

        const p = this.profiler
        // Start a render record if one isn't already active (renderToFile starts its own)
        const ownRecord = p && !p._current
        if (ownRecord) p.startRender(locus)

        const axisEnabled = options.axis || false
        const axisWidth = options.axisWidth || 50
        const trackLabels = options.trackLabels || false
        const showNavbar = options.showNavbar || false
        const trackWidth = axisEnabled ? width - axisWidth : width

        // Navigate to the locus
        const endGoto = p?.time('goto')
        await this.goto(locus, trackWidth)
        endGoto?.()
        const referenceFrame = this.referenceFrameList[0]

        const visibleTracks = this.tracks

        // Phase 1: Load features for all tracks and compute dynamic heights
        const trackData = []

        for (const track of visibleTracks) {
            const trackName = track.config?.name || track.name || track.type || 'unknown'
            let features

            const endLoad = p?.time('loadFeatures')
            if (track.type === 'ideogram') {
                // Ideogram track needs cytobands from the genome, not track.getFeatures()
                features = await this.genome.getCytobands(referenceFrame.chr)
            } else if (track.type === 'ruler') {
                // Ruler track has no features — it only uses the reference frame
                features = []
            } else {
                // Standard track — load features through the normal pipeline
                const tempVp = new OfflineViewport(track, referenceFrame, trackWidth, 1)
                features = await tempVp.loadFeatures(this.genome)
            }
            const loadMs = endLoad?.()
            if (p && loadMs !== undefined) p.trackDetail('loadFeatures', trackName, loadMs)

            // Record feature count
            if (p && features) {
                const count = Array.isArray(features) ? features.length : 0
                p.count('featureCount', count)
                p.count(`featureCount:${trackName}`, count)
            }

            // Use track.height as the viewport height (matching browser behavior
            // where the track viewport clips at this height).  Fall back to
            // computePixelHeight for tracks without an explicit height (e.g.
            // ideogram, ruler).
            const endHeight = p?.time('computeHeight')
            let trackHeight
            if (options.trackHeights) {
                trackHeight = options.trackHeights[trackData.length] || 50
            } else if (track.height) {
                trackHeight = track.height
            } else if (typeof track.computePixelHeight === 'function' && features) {
                trackHeight = track.computePixelHeight(features)
            } else {
                trackHeight = 50
            }
            endHeight?.()

            trackData.push({track, features, height: trackHeight})
        }

        // Phase 2: Render each track with its correct height
        // trackGap matches the igv.js CSS $igv-column-item-margin-top spacing between tracks
        const trackGap = options.trackGap ?? 10
        const compositor = new Compositor(width, {backgroundColor: options.backgroundColor || 'white', trackGap})

        // Optional navbar at the top
        if (showNavbar) {
            const endNavbar = p?.time('navbar')
            const navbarCanvas = await renderNavbar(width, {
                genome: this.config.genome?.id || this.config.genome?.name || 'hg38',
                chr: referenceFrame.chr,
                start: Math.floor(referenceFrame.start),
                end: Math.floor(referenceFrame.end),
            })
            endNavbar?.()
            compositor.setNavbar(navbarCanvas, NAVBAR_HEIGHT)
        }

        for (const {track, features, height: trackHeight} of trackData) {
            const trackName = track.config?.name || track.name || track.type || 'unknown'
            const endRender = p?.time('render')
            const viewport = new OfflineViewport(track, referenceFrame, trackWidth, trackHeight)
            viewport.cachedFeatures = features
            const trackCanvas = await viewport.render(undefined, p)

            let axisCanvas
            if (axisEnabled) {
                axisCanvas = await viewport.renderAxis(axisWidth)
            }
            const renderMs = endRender?.()
            if (p && renderMs !== undefined) p.trackDetail('render', trackName, renderMs)

            const label = trackLabels ? (track.config?.name || track.name) : undefined
            compositor.addTrack(trackCanvas, trackHeight, axisCanvas, label)
        }

        const endCompose = p?.time('compose')
        const canvas = await compositor.compose()
        endCompose?.()

        // Finalize the render record if we own it (not called from renderToFile)
        if (ownRecord) p.endRender()

        return canvas
    }

    /**
     * Render a locus and write the result to a file.
     *
     * @param {string} locus      - Genomic locus
     * @param {number} width      - Output width in pixels
     * @param {string} outputPath - File path for the output image
     * @param {object} [options]
     * @param {string} [options.format]  - 'jpeg' or 'png' (default 'jpeg')
     * @param {number} [options.quality] - JPEG quality 0-100 (default 85)
     * @returns {Promise<void>}
     */
    async renderToFile(locus, width, outputPath, options = {}) {

        const p = this.profiler
        p?.startRender(locus)
        const format = options.format || 'jpeg'
        const quality = options.quality ?? 85

        const canvas = await this.renderLocus(locus, width, options)

        const fs = await import('fs')
        const path = await import('path')

        // Ensure output directory exists
        const dir = path.dirname(outputPath)
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, {recursive: true})
        }

        const endEncode = p?.time('encode')
        let buffer
        if (format === 'jpeg' || format === 'jpg') {
            buffer = canvas.toBuffer('image/jpeg', quality)
        } else {
            buffer = canvas.toBuffer('image/png')
        }
        endEncode?.()

        const endWrite = p?.time('write')
        fs.writeFileSync(outputPath, buffer)
        endWrite?.()

        p?.endRender()
    }

    // ── Browser interface stubs ────────────────────────────────────────
    // These are referenced by Track classes via `this.browser.*`

    minimumBases() {
        return this.config.minimumBases ?? 40
    }

    isSoftclipped() {
        return false
    }

    getSequenceTrack() {
        return null
    }

    fireEvent(eventName, args) {
        // No-op in offline mode; tracks sometimes call browser.fireEvent
    }

    on(eventName, fn) {}
    off(eventName, fn) {}
    un(eventName, fn) {}

    updateViews() {
        // No-op — there are no live views to update
    }

    get roiManager() {
        return {roiSets: this.roiSets, clearROIs() {}, loadROI() {}, reset() {}}
    }

    // ── Cleanup ────────────────────────────────────────────────────────

    dispose() {
        for (const track of this.tracks) {
            if (typeof track.dispose === 'function') {
                track.dispose()
            }
        }
        this.tracks = []
        this.genome = null
        this.referenceFrameList = []
    }
}

// ── Helpers ─────────────────────────────────────────────────────────────

const defaultConfig = {
    minimumBases: 40,
    flanking: 1000,
    loadDefaultGenomes: true,
    showIdeogram: false,
    showRuler: false,
}

// Stub for QTLSelections — tracks check browser.qtlSelections.hasPhenotype() during draw
const emptyQtlSelections = {
    hasPhenotype() { return false },
    hasSnp() { return false },
    colorForGene() { return 'black' },
    isEmpty() { return true },
    phenotypeColors: new Map(),
    snps: new Set(),
    qtl: null,
}

function noopAlert(message) {
    console.warn('[OfflineBrowser]', message)
}
noopAlert.present = noopAlert

function isUIOnlyTrack(config) {
    const type = (config.type || '').toLowerCase()
    return type === 'ideogram' || type === 'ruler' || type === 'sequence'
}

// ── Navbar rendering ─────────────────────────────────────────────────────
// Static rendering of the igv.js navigation toolbar.
// Styling matches _navbar.scss: 32px height, #f3f3f3 background, #bfbfbf border.

const NAVBAR_HEIGHT = 32

/** Format a number with commas: 1234567 → "1,234,567" */
function formatNumber(n) {
    return n.toLocaleString('en-US')
}

/** Format window size: bp, kb, or Mb */
function formatWindowSize(bp) {
    if (bp < 1000) return `${bp} bp`
    if (bp < 1000000) return `${Math.round(bp / 1000)} kb`
    return `${(bp / 1000000).toFixed(1)} Mb`
}

/**
 * Render a static igv.js-style navigation bar to a canvas.
 *
 * @param {number} width - Canvas width in pixels
 * @param {object} info  - Locus information
 * @param {string} info.genome - Genome ID (e.g. "hg38")
 * @param {string} info.chr    - Chromosome (e.g. "chr17")
 * @param {number} info.start  - Locus start (0-based)
 * @param {number} info.end    - Locus end
 * @returns {object} A node-canvas Canvas
 */
async function renderNavbar(width, info) {

    const {createCanvas} = await getCanvasModule()

    const canvas = createCanvas(width, NAVBAR_HEIGHT)
    const ctx = canvas.getContext('2d')
    const h = NAVBAR_HEIGHT

    // Background
    ctx.fillStyle = '#f3f3f3'
    ctx.fillRect(0, 0, width, h)

    // Border
    ctx.strokeStyle = '#bfbfbf'
    ctx.lineWidth = 1
    ctx.strokeRect(0.5, 0.5, width - 1, h - 1)

    const fontFamily = 'Arial, Helvetica, sans-serif'
    const textY = h / 2  // vertical center

    let x = 8  // left padding

    // ── "IGV" logo text ──
    ctx.font = `bold 16px ${fontFamily}`
    ctx.fillStyle = '#666'
    ctx.textBaseline = 'middle'
    ctx.fillText('IGV', x, textY)
    x += ctx.measureText('IGV').width + 10

    // ── Genome name ──
    ctx.font = `12px ${fontFamily}`
    ctx.fillStyle = '#444'
    ctx.fillText(info.genome, x, textY)
    x += ctx.measureText(info.genome).width + 8

    // ── Chromosome box ──
    const chrText = info.chr
    ctx.font = `12px ${fontFamily}`
    const chrTextWidth = ctx.measureText(chrText).width
    const chrBoxW = chrTextWidth + 16
    const chrBoxH = 22
    const chrBoxY = (h - chrBoxH) / 2

    // Box background and border
    ctx.fillStyle = 'white'
    roundRect(ctx, x, chrBoxY, chrBoxW, chrBoxH, 3)
    ctx.fill()
    ctx.strokeStyle = '#bfbfbf'
    ctx.lineWidth = 1
    roundRect(ctx, x, chrBoxY, chrBoxW, chrBoxH, 3)
    ctx.stroke()

    // Chromosome text
    ctx.fillStyle = '#444'
    ctx.fillText(chrText, x + 8, textY)
    x += chrBoxW + 8

    // ── Locus input box ──
    const locusStart = Math.max(0, info.start)
    const locusEnd = info.end
    const locusText = `${info.chr}:${formatNumber(locusStart)}-${formatNumber(locusEnd)}`
    ctx.font = `12px ${fontFamily}`
    const locusTextWidth = ctx.measureText(locusText).width
    const locusBoxW = Math.max(locusTextWidth + 24, 240)
    const locusBoxH = 22
    const locusBoxY = (h - locusBoxH) / 2

    // Box background and border
    ctx.fillStyle = 'white'
    roundRect(ctx, x, locusBoxY, locusBoxW, locusBoxH, 3)
    ctx.fill()
    ctx.strokeStyle = '#bfbfbf'
    ctx.lineWidth = 1
    roundRect(ctx, x, locusBoxY, locusBoxW, locusBoxH, 3)
    ctx.stroke()

    // Locus text
    ctx.fillStyle = '#444'
    ctx.fillText(locusText, x + 8, textY)
    x += locusBoxW + 4

    // ── Search icon (magnifying glass) ──
    drawSearchIcon(ctx, x + 2, textY, 12)
    x += 20

    // ── Window size ──
    const windowSize = formatWindowSize(locusEnd - locusStart)
    ctx.font = `12px ${fontFamily}`
    ctx.fillStyle = '#444'
    ctx.fillText(windowSize, x, textY)
    x += ctx.measureText(windowSize).width + 8

    // ── Right side: "Track Labels" button (active state) ──
    const btnText = 'Track Labels'
    ctx.font = `200 11px ${fontFamily}`
    const btnTextWidth = ctx.measureText(btnText).width
    const btnW = btnTextWidth + 12
    const btnH = 18
    const btnX = width - btnW - 8
    const btnY = (h - btnH) / 2

    // Active button: filled background
    ctx.fillStyle = '#737373'
    roundRect(ctx, btnX, btnY, btnW, btnH, 6)
    ctx.fill()

    // Button text (white for active)
    ctx.fillStyle = 'white'
    ctx.textBaseline = 'middle'
    ctx.fillText(btnText, btnX + 6, textY)

    return canvas
}

/** Draw a rounded rectangle path */
function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath()
    ctx.moveTo(x + r, y)
    ctx.lineTo(x + w - r, y)
    ctx.arcTo(x + w, y, x + w, y + r, r)
    ctx.lineTo(x + w, y + h - r)
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r)
    ctx.lineTo(x + r, y + h)
    ctx.arcTo(x, y + h, x, y + h - r, r)
    ctx.lineTo(x, y + r)
    ctx.arcTo(x, y, x + r, y, r)
    ctx.closePath()
}

/** Draw a simple magnifying glass icon */
function drawSearchIcon(ctx, cx, cy, size) {
    const r = size * 0.35
    ctx.strokeStyle = '#737373'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.arc(cx, cy - 1, r, 0, Math.PI * 2)
    ctx.stroke()
    // Handle
    const angle = Math.PI * 0.25
    ctx.beginPath()
    ctx.moveTo(cx + r * Math.cos(angle), cy - 1 + r * Math.sin(angle))
    ctx.lineTo(cx + size * 0.5, cy - 1 + size * 0.5)
    ctx.stroke()
}

export default OfflineBrowser
