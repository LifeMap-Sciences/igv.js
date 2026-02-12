import strip from '@rollup/plugin-strip';

// Standalone rollup config for the Node.js headless rendering build.
// Run with:  npm run build:node  (or)  npx rollup --config rollup.config.node.js

const nodeShimCode = `
    if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
    if (typeof globalThis.window.devicePixelRatio === 'undefined') globalThis.window.devicePixelRatio = 1;
    if (typeof globalThis.atob === 'undefined') globalThis.atob = function(s) { return Buffer.from(s, 'base64').toString('binary'); };
    if (typeof globalThis.btoa === 'undefined') globalThis.btoa = function(s) { return Buffer.from(s, 'binary').toString('base64'); };
    if (typeof globalThis.XMLHttpRequest === 'undefined') {
        try { globalThis.XMLHttpRequest = __nodeRequire('w3c-xmlhttprequest').XMLHttpRequest; } catch(e) {}
    }
    if (typeof globalThis.performance === 'undefined') {
        try { globalThis.performance = __nodeRequire('perf_hooks').performance; } catch(e) {}
    }
    if (typeof globalThis.document === 'undefined') {
        var noop = function(){};
        function stub(tag) {
            return {
                tagName: (tag||'').toUpperCase(), style: {}, className: '',
                children: [], childNodes: [], innerHTML: '', textContent: '',
                setAttribute: noop, getAttribute: function(){ return null; },
                appendChild: function(c) { this.children.push(c); return c; },
                removeChild: function(c) { var i=this.children.indexOf(c); if(i>=0) this.children.splice(i,1); return c; },
                addEventListener: noop, removeEventListener: noop,
                getBoundingClientRect: function(){ return {x:0,y:0,width:0,height:0,top:0,right:0,bottom:0,left:0}; },
                querySelector: function(){return null;}, querySelectorAll: function(){return [];},
                get firstElementChild() { return this.children[0] || null; },
                classList: { add:noop, remove:noop, contains:function(){return false;}, toggle:noop },
                cloneNode: function(){ return stub(tag); },
                contains: function(){return false;}, dispatchEvent:noop, remove:noop,
                insertBefore: function(n){ this.children.unshift(n); return n; },
            };
        }
        var head = stub('head'), body = stub('body'), docEl = stub('html');
        docEl.children.push(head);
        globalThis.document = {
            createElement: function(tag) {
                if (tag.toLowerCase() === 'canvas') {
                    try { return __nodeRequire('canvas').createCanvas(1,1); } catch(e) { return stub(tag); }
                }
                return stub(tag);
            },
            createElementNS: function(ns,tag) { return this.createElement(tag); },
            createDocumentFragment: function() { return stub('fragment'); },
            createTextNode: function(t) { return {textContent:t, nodeType:3}; },
            getElementById: function(){return null;}, querySelector: function(){return null;},
            querySelectorAll: function(){return [];}, styleSheets: [],
            addEventListener: noop, removeEventListener: noop,
            body: body, documentElement: docEl, head: head
        };
    }
    if (typeof globalThis.DOMParser === 'undefined') {
        try { globalThis.DOMParser = __nodeRequire('@xmldom/xmldom').DOMParser; } catch(e) {}
    }
    if (typeof globalThis.HTMLCanvasElement === 'undefined') {
        try { globalThis.HTMLCanvasElement = __nodeRequire('canvas').Canvas; } catch(e) {
            globalThis.HTMLCanvasElement = function HTMLCanvasElement(){};
        }
    }
`;

const esmBanner = `
// --- Node.js environment shims ---
import { createRequire as __igvCreateRequire } from 'module';
var __nodeRequire = __igvCreateRequire(import.meta.url);
(function() {${nodeShimCode}})();
// --- End shims ---
`;

const cjsBanner = `
// --- Node.js environment shims ---
var __nodeRequire = require;
(function() {${nodeShimCode}})();
// Rollup converts import.meta.url to a document.baseURI-based check in CJS;
// provide baseURI so that resolution works correctly.
if (typeof globalThis.document !== 'undefined' && !globalThis.document.baseURI) {
    globalThis.document.baseURI = 'file:///' + __filename.replace(/\\\\/g, '/');
}
// --- End shims ---
`;

const external = [
    'canvas',
    'worker_threads',
    'module',
    'fs',
    'path',
    'url',
    'perf_hooks',
    '@xmldom/xmldom',
    'w3c-xmlhttprequest',
];

const plugins = [
    strip({
        debugger: true,
        functions: [/*'console.log', */'assert.*', 'debug']
    })
];

export default [
    {
        input: 'js/node/index.js',
        output: {
            file: 'dist/igv-node.esm.js',
            format: 'es',
            banner: esmBanner,
            inlineDynamicImports: true,
        },
        external,
        plugins,
    },
    {
        input: 'js/node/index.js',
        output: {
            file: 'dist/igv-node.cjs',
            format: 'cjs',
            exports: 'named',
            banner: cjsBanner,
            inlineDynamicImports: true,
        },
        external,
        plugins,
    }
];
