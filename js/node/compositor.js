/**
 * Compositor — stacks multiple track canvases vertically into a single output
 * image, optionally prepending a Y-axis strip on the left.
 */

// Lazy-loaded modules (cached after first import)
let _canvasModule = null
let _fsModule = null
let _pathModule = null

async function getCanvasModule() {
    if (!_canvasModule) {
        _canvasModule = await import('canvas')
    }
    return _canvasModule
}

async function getFsModule() {
    if (!_fsModule) {
        _fsModule = await import('fs')
    }
    return _fsModule
}

async function getPathModule() {
    if (!_pathModule) {
        _pathModule = await import('path')
    }
    return _pathModule
}

class Compositor {

    /**
     * @param {number}  width   - Total output image width in pixels
     * @param {object}  [options]
     * @param {string}  [options.backgroundColor] - Background fill (default 'white')
     * @param {number}  [options.trackGap]        - Vertical gap before each track (default 0)
     */
    constructor(width, options = {}) {
        this.width = width
        this.backgroundColor = options.backgroundColor || 'white'
        this.trackGap = options.trackGap || 0
        this.entries = []    // {trackCanvas, height, axisCanvas}
        this.totalHeight = 0
        this.navbarCanvas = null
        this.navbarHeight = 0
    }

    /**
     * Add a rendered track canvas to the stack.
     *
     * @param {object}          trackCanvas - A node-canvas Canvas for the track
     * @param {number}          height      - Height in pixels consumed by this track
     * @param {object|undefined} axisCanvas - Optional Y-axis canvas
     * @param {string|undefined} label      - Optional track label (drawn as badge)
     */
    /**
     * Set a navbar canvas to render above all tracks.
     *
     * @param {object} canvas - A node-canvas Canvas for the navbar
     * @param {number} height - Height of the navbar in pixels
     */
    setNavbar(canvas, height) {
        this.navbarCanvas = canvas
        this.navbarHeight = height
    }

    addTrack(trackCanvas, height, axisCanvas, label) {
        this.entries.push({trackCanvas, height, axisCanvas, label})
        this.totalHeight += height + this.trackGap
    }

    /**
     * Compose all added tracks into a single Canvas.
     *
     * @returns {Promise<object>} A node-canvas Canvas
     */
    async compose() {

        const {createCanvas} = await getCanvasModule()
        const navHeight = this.navbarCanvas ? this.navbarHeight : 0
        const canvas = createCanvas(this.width, navHeight + this.totalHeight)
        const ctx = canvas.getContext('2d')

        // Fill background
        ctx.fillStyle = this.backgroundColor
        ctx.fillRect(0, 0, canvas.width, canvas.height)

        let y = 0

        // Draw navbar if present
        if (this.navbarCanvas) {
            ctx.drawImage(this.navbarCanvas, 0, 0)
            y = this.navbarHeight
        }
        for (const {trackCanvas, height, axisCanvas, label} of this.entries) {

            // Add gap before each track (matching igv.js CSS margin-top)
            y += this.trackGap

            if (axisCanvas) {
                // Axis goes on the left, track to the right
                ctx.drawImage(axisCanvas, 0, y)
                ctx.drawImage(trackCanvas, axisCanvas.width, y)
            } else {
                ctx.drawImage(trackCanvas, 0, y)
            }

            // Draw track label badge (overlaid at top-left, matching igv.js style)
            if (label) {
                const fontSize = 11
                const paddingX = 4
                const paddingY = 2
                const badgeX = 2
                const badgeY = y + 2

                ctx.font = `bold ${fontSize}px Arial, Helvetica, sans-serif`
                const textMetrics = ctx.measureText(label)
                const badgeW = textMetrics.width + paddingX * 2
                const badgeH = fontSize + paddingY * 2

                // Badge background with border
                ctx.fillStyle = 'rgba(255, 255, 255, 0.85)'
                ctx.fillRect(badgeX, badgeY, badgeW, badgeH)
                ctx.strokeStyle = 'rgb(200, 200, 200)'
                ctx.lineWidth = 1
                ctx.strokeRect(badgeX, badgeY, badgeW, badgeH)

                // Label text
                ctx.fillStyle = '#333'
                ctx.textBaseline = 'top'
                ctx.fillText(label, badgeX + paddingX, badgeY + paddingY)
            }

            y += height
        }

        return canvas
    }

    /**
     * Compose and return a Buffer in the requested format.
     *
     * @param {string} [format='jpeg'] - 'jpeg' or 'png'
     * @param {number} [quality=85]    - JPEG quality (0-100)
     * @returns {Promise<Buffer>}
     */
    async toBuffer(format = 'jpeg', quality = 85) {
        const canvas = await this.compose()
        if (format === 'jpeg' || format === 'jpg') {
            return canvas.toBuffer('image/jpeg', {quality: quality / 100})
        }
        return canvas.toBuffer('image/png')
    }

    /**
     * Compose and write the result to a file.
     *
     * @param {string} filePath        - Output file path
     * @param {string} [format='jpeg'] - 'jpeg' or 'png'
     * @param {number} [quality=85]    - JPEG quality (0-100)
     * @returns {Promise<void>}
     */
    async toFile(filePath, format = 'jpeg', quality = 85) {
        const fs = await getFsModule()
        const path = await getPathModule()

        const dir = path.dirname(filePath)
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, {recursive: true})
        }

        const buffer = await this.toBuffer(format, quality)
        fs.writeFileSync(filePath, buffer)
    }
}

export default Compositor
