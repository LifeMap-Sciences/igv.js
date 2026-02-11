
import * as DOMUtils from "../ui/utils/dom-utils.js"

class CursorGuide {

    constructor(columnContainer, browser) {
        this.browser = browser
        this.columnContainer = columnContainer

        this._visible = false
        this._wasVisibleBeforeWGV = false

        this.horizontalGuide = DOMUtils.div({class: 'igv-cursor-guide-horizontal'})
        columnContainer.appendChild(this.horizontalGuide)

        this.verticalGuide = DOMUtils.div({class: 'igv-cursor-guide-vertical'})
        columnContainer.appendChild(this.verticalGuide)

        this.addMouseHandler(browser)

        this.setVisibility(browser.config.showCursorGuide)

        browser.on('columnlayoutchange', () => this.moveGuidesToEnd())
    }

    get visible() {
        return this._visible
    }

    moveGuidesToEnd() {
        if (this.horizontalGuide?.parentNode === this.columnContainer) {
            this.columnContainer.appendChild(this.horizontalGuide)
        }
        if (this.verticalGuide?.parentNode === this.columnContainer) {
            this.columnContainer.appendChild(this.verticalGuide)
        }
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
        this.browser.off('columnlayoutchange')
        this.horizontalGuide.remove()
        this.verticalGuide.remove()
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
