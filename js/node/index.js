/**
 * igv.js Node.js entry point — exports the offline / headless rendering API.
 *
 * Usage:
 *   import { OfflineBrowser, BatchRenderer, Compositor } from 'igv/node'
 *
 * IMPORTANT: Environment shims are installed immediately as a side-effect
 * when this module is imported. This is necessary because some bundled code
 * (e.g. vanilla-picker CSS injection) accesses `document` at module load time.
 */

// Install shims FIRST — this must be the first import so it runs before
// any igv.js code that accesses browser globals at module load time.
import {installShims, uninstallShims, getCanvasModule} from './environment.js'
installShims()

export {installShims, uninstallShims, getCanvasModule}
export {default as OfflineBrowser} from './offlineBrowser.js'
export {default as OfflineViewport} from './offlineViewport.js'
export {default as Compositor} from './compositor.js'
export {default as BatchRenderer} from './batchRenderer.js'

// Re-export TrackBase (no circular dependency issues)
export {default as TrackBase} from '../trackBase.js'

/**
 * Register a custom track class. This function lazily loads the track factory
 * to avoid circular dependency issues at bundle initialization time.
 *
 * @param {string} type       - Track type key (e.g. 'genehancer')
 * @param {Function} trackClass - Track class constructor
 */
export async function registerTrackClass(type, trackClass) {
    const {registerTrackClass: _register} = await import('../trackFactory.js')
    _register(type, trackClass)
}
