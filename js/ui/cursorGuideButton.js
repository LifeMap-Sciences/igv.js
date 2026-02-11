import NavbarButton from "./navbarButton.js"
import {cursorImage, cursorImageHover} from "./navbarIcons/cursor.js"
import { buttonLabel } from "./navbarIcons/buttonLabel.js"

class CursorGuideButton extends NavbarButton {

    constructor(parent, browser) {

        super(parent, browser, 'Crosshairs', buttonLabel, cursorImage, cursorImageHover, browser.cursorGuide.visible)

        this.button.addEventListener('mouseenter', () => {
            if (false === browser.cursorGuide.visible) {
                this.setState(true)
            }
        })

        this.button.addEventListener('mouseleave', () => {
            if (false === browser.cursorGuide.visible) {
                this.setState(false)
            }
        })

        this.button.addEventListener('click', () => {
            browser.cursorGuide.setVisibility(!browser.cursorGuide.visible)
            this.setState(browser.cursorGuide.visible)
        })

        this.setVisibility(browser.config.showCursorTrackingGuideButton)

    }

}

export default CursorGuideButton
