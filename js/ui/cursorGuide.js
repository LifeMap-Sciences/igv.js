
import * as DOMUtils from "../ui/utils/dom-utils.js"
import {lerp} from "../util/igvUtils.js"

class CursorGuide {

    constructor(columnContainer, browser) {
        this.browser = browser
        this.columnContainer = columnContainer

        this._visible = false
        this._wasVisibleBeforeWGV = false

        this.overlay = DOMUtils.div({
            class: 'igv-cursor-guide-overlay',
            style: {
                position: 'absolute',
                top: '0',
                left: '0',
                width: '0',
                height: '0',
                pointerEvents: 'none',
                zIndex: '99999'
            }
        })
        this.horizontalGuide = DOMUtils.div({class: 'igv-cursor-guide-horizontal'})
        this.overlay.appendChild(this.horizontalGuide)

        this.verticalGuide = DOMUtils.div({class: 'igv-cursor-guide-vertical'})
        this.overlay.appendChild(this.verticalGuide)

        browser.root.appendChild(this.overlay)

        this.addMouseHandler(browser)

        this.setVisibility(browser.config.showCursorGuide)

        this._boundUpdateOverlay = () => this._updateOverlayPosition()
        browser.on('columnlayoutchange', this._boundUpdateOverlay)
        this._updateOverlayPosition()
    }

    get visible() {
        return this._visible
    }

    _updateOverlayPosition() {
        const rootRect = this.browser.root.getBoundingClientRect()
        const colRect = this.columnContainer.getBoundingClientRect()
        this.overlay.style.top = `${colRect.top - rootRect.top}px`
        this.overlay.style.left = `${colRect.left - rootRect.left}px`
        this.overlay.style.width = `${colRect.width}px`
        this.overlay.style.height = `${colRect.height}px`
    }

    addMouseHandler(browser) {

        this.boundMouseMoveHandler = mouseMoveHandler.bind(this)
        this.columnContainer.addEventListener('mousemove', this.boundMouseMoveHandler)

        function mouseMoveHandler(event) {

            if (!this._visible) return

            const {x, y} = DOMUtils.translateMouseCoordinates(event, this.columnContainer)
            this.horizontalGuide.style.top = `${y}px`
            this.verticalGuide.style.left = `${x}px`

            if (this.customMouseHandler && 'CANVAS' === event.target.tagName) {
                this._computeGenomicCoordinates(event)
            }

        }
    }

    removeMouseHandler() {
        this.columnContainer.removeEventListener('mousemove', this.boundMouseMoveHandler)
    }

    updateWithInterpolant(interpolant) {
        const {x: xc} = this.columnContainer.getBoundingClientRect()
        const rulerTrackView = this.browser.getRulerTrackView()
        if (!rulerTrackView || !rulerTrackView.viewports || rulerTrackView.viewports.length === 0) return
        const viewport = rulerTrackView.viewports[0].viewportElement
        const {x, width} = viewport.getBoundingClientRect()
        const left = x - xc
        const pixel = Math.floor(lerp(left, width + left, interpolant))
        this.verticalGuide.style.left = `${pixel}px`
    }

    _computeGenomicCoordinates(event) {

        const viewport = findAncestorOfClass(event.target, 'igv-viewport')

        if (viewport && this.browser.getRulerTrackView()) {

            const columns = this.browser.root.querySelectorAll('.igv-column')
            let index = undefined
            const viewportParent = viewport.parentElement
            for (let i = 0; i < columns.length; i++) {
                if (undefined === index && viewportParent === columns[i]) {
                    index = i
                }
            }

            if (undefined !== index) {

                const rulerViewport = this.browser.getRulerTrackView().viewports[index]
                const result = rulerViewport.mouseMove(event)

                if (result) {

                    const {start, bp, end} = result
                    const interpolant = (bp - start) / (end - start)

                    if (this.customMouseHandler) {
                        this.customMouseHandler({start, bp, end, interpolant})
                    }
                }

            }

        }

    }

    setVisibility(visible) {
        if (true === visible) {
            this.show()
        } else {
            this.hide()
        }
        this._wasVisibleBeforeWGV = this._visible
    }

    show() {
        this._visible = true
        this.verticalGuide.style.display = 'block'
        this.horizontalGuide.style.display = 'block'
    }

    hide() {
        this._visible = false
        this.verticalGuide.style.display = 'none'
        this.horizontalGuide.style.display = 'none'

        if (this.browser.getRulerTrackView()) {
            for (let viewport of this.browser.getRulerTrackView().viewports) {
                viewport.tooltip.style.display = 'none'
            }
        }
    }

    enterWholeGenomeView() {
        this._wasVisibleBeforeWGV = this._visible
        if (this._visible) this.hide()
    }

    leaveWholeGenomeView() {
        if (this._wasVisibleBeforeWGV) this.show()
    }

    dispose() {
        this.removeMouseHandler()
        this.browser.off('columnlayoutchange', this._boundUpdateOverlay)
        this.overlay?.remove()
        this.customMouseHandler = undefined
    }

}

/**
 * Walk up the tree until a parent is found with the given classname.  If no ancestor is found return undefined.
 * @param target
 * @param classname
 * @returns {*}
 */
function findAncestorOfClass(target, classname) {

    while (target.parentElement) {
        if (target.parentElement.classList.contains(classname)) {
            return target.parentElement
        } else {
            target = target.parentElement
        }
    }
    return undefined

}


export default CursorGuide
