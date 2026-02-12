/**
 * Minimal Node.js environment shims for igv.js offline rendering.
 *
 * These shims provide just enough browser-API surface for igv.js track
 * drawing code to run in Node.js without jsdom. They are intentionally
 * minimal — only the APIs actually referenced by drawing / data-loading
 * code paths are shimmed.
 *
 * Call `installShims()` once before importing any igv.js modules.
 */

let installed = false

// Lazy-loaded canvas module — shared singleton across all node/ modules.
// Use getCanvasModule() instead of importing 'canvas' directly.
let _canvasModule = null

async function getCanvasModule() {
    if (!_canvasModule) {
        _canvasModule = await import('@napi-rs/canvas')
    }
    return _canvasModule
}

function installShims(options = {}) {

    if (installed) return
    installed = true

    const devicePixelRatio = options.devicePixelRatio ?? 1

    // ── window / globalThis ─────────────────────────────────────────────
    if (typeof globalThis.window === 'undefined') {
        globalThis.window = globalThis
    }

    if (typeof globalThis.window.devicePixelRatio === 'undefined') {
        globalThis.window.devicePixelRatio = devicePixelRatio
    }

    // ── document shim (minimal) ─────────────────────────────────────────
    if (typeof globalThis.document === 'undefined') {
        globalThis.document = createDocumentShim()
    }

    // Note: DOMParser, HTMLCanvasElement, performance, XMLHttpRequest,
    // atob, and btoa shims are installed by the rollup bundle banner
    // (which runs synchronously at load time before any module code).
    // This function only needs to handle shims that depend on runtime
    // options (like devicePixelRatio) or that the banner doesn't cover.
}

// ── Minimal document shim ───────────────────────────────────────────────
function createDocumentShim() {

    const noop = () => {}

    // Minimal element stub returned by createElement for non-canvas elements
    function createElementStub(tag) {
        const el = {
            tagName: tag.toUpperCase(),
            style: {},
            className: '',
            children: [],
            childNodes: [],
            innerHTML: '',
            innerText: '',
            textContent: '',
            setAttribute: noop,
            getAttribute: () => null,
            appendChild(child) { this.children.push(child); return child },
            removeChild(child) {
                const i = this.children.indexOf(child)
                if (i >= 0) this.children.splice(i, 1)
                return child
            },
            addEventListener: noop,
            removeEventListener: noop,
            getBoundingClientRect: () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0 }),
            querySelector: () => null,
            querySelectorAll: () => [],
            get firstElementChild() { return this.children[0] || null },
            classList: {
                add: noop,
                remove: noop,
                contains: () => false,
                toggle: noop,
            },
            cloneNode() { return createElementStub(tag) },
            contains: () => false,
            dispatchEvent: noop,
            remove: noop,
            insertBefore(newNode) { this.children.unshift(newNode); return newNode },
        }
        return el
    }

    const head = createElementStub('head')
    const body = createElementStub('body')
    const documentElement = createElementStub('html')
    // Ensure documentElement.firstElementChild returns head
    // (vanilla-picker does: document.documentElement.firstElementChild.appendChild(style))
    documentElement.children.push(head)

    const doc = {
        createElement(tag) {
            if (tag.toLowerCase() === 'canvas') {
                try {
                    const { createCanvas } = require('@napi-rs/canvas')
                    return createCanvas(1, 1)
                } catch (e) {
                    return createElementStub(tag)
                }
            }
            return createElementStub(tag)
        },

        createElementNS(ns, tag) {
            return doc.createElement(tag)
        },

        createDocumentFragment() {
            return createElementStub('fragment')
        },

        createTextNode(text) {
            return { textContent: text, nodeType: 3 }
        },

        getElementById: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener: noop,
        removeEventListener: noop,
        styleSheets: [],

        body,
        documentElement,
        head,
    }

    return doc
}

function uninstallShims() {
    installed = false
}

export { installShims, uninstallShims, getCanvasModule }
export default installShims
