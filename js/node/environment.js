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

    // ── DOMParser shim (for SVG/XML parsing in some tracks) ─────────────
    if (typeof globalThis.DOMParser === 'undefined') {
        try {
            const { DOMParser } = require('@xmldom/xmldom')
            globalThis.DOMParser = DOMParser
        } catch (e) {
            // Optional dependency — only needed if tracks parse XML
        }
    }

    // ── HTMLCanvasElement shim (for instanceof checks) ──────────────────
    if (typeof globalThis.HTMLCanvasElement === 'undefined') {
        try {
            const { Canvas } = require('canvas')
            globalThis.HTMLCanvasElement = Canvas
        } catch (e) {
            // Provide a dummy so `instanceof` checks don't throw
            globalThis.HTMLCanvasElement = class HTMLCanvasElement {}
        }
    }

    // ── Performance / timing (used by some logging paths) ───────────────
    if (typeof globalThis.performance === 'undefined') {
        const { performance } = require('perf_hooks')
        globalThis.performance = performance
    }

    // ── XMLHttpRequest (used by igv-utils for HTTP requests) ────────────
    if (typeof globalThis.XMLHttpRequest === 'undefined') {
        try {
            const { XMLHttpRequest } = require('w3c-xmlhttprequest')
            globalThis.XMLHttpRequest = XMLHttpRequest
        } catch (e) {
            // w3c-xmlhttprequest not installed — HTTP requests will fail
            // unless native fetch is available
        }
    }

    // ── atob / btoa (base64, used by some data loading paths) ───────────
    if (typeof globalThis.atob === 'undefined') {
        globalThis.atob = (str) => Buffer.from(str, 'base64').toString('binary')
    }
    if (typeof globalThis.btoa === 'undefined') {
        globalThis.btoa = (str) => Buffer.from(str, 'binary').toString('base64')
    }
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
                    const { createCanvas } = require('canvas')
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

export { installShims, uninstallShims }
export default installShims
