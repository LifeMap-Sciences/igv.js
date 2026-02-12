# PROJECT: igv.js (LifeMap-Sciences fork)

Fork of [igvteam/igv.js](https://github.com/igvteam/igv.js) with Node.js offline rendering support for GeneCards IGV image generation.

Branch: `feature/offline-rendering`

## Architecture

The fork adds a **headless rendering pipeline** under `js/node/` that reuses igv.js's existing track drawing code but replaces the browser DOM with lightweight canvas shims. This allows server-side rendering of genomic visualizations without Chromium/Playwright.

### Key Files

| File | Purpose |
|------|---------|
| `js/node/environment.js` | Node.js environment shims (window, document, canvas stubs) |
| `js/node/offlineBrowser.js` | Headless `Browser` replacement — manages genome, tracks, reference frames, and rendering |
| `js/node/offlineViewport.js` | Headless viewport — renders a single track to a canvas buffer |
| `js/node/compositor.js` | Stacks track canvases vertically into a single output image (with optional navbar, axis, labels) |
| `js/node/index.js` | Public entry point — exports `OfflineBrowser`, `installShims`, etc. |
| `rollup.config.node.js` | Rollup config producing `dist/igv-node.esm.js` and `dist/igv-node.cjs` |
| `package.node.json` | Companion package.json shipped with the bundle (has runtime native deps) |

### Canvas Library

Uses [`@napi-rs/canvas`](https://github.com/Brooooooklyn/canvas) (Skia-based) instead of `node-canvas` (Cairo-based):
- **Prebuilt binaries** for all platforms — no C++ compiler or node-gyp needed at deploy time
- `npm install` takes seconds, not minutes
- The rollup banner registers Arial as the `sans-serif` font family (Skia doesn't map CSS generic families to system fonts like browsers do)

### How Rendering Works (End-to-End)

```
C# (GeneCards.RenderIGVImages)
  |
  |-- Spawns N Node.js workers (default 8)
  |     each runs: node render-genecards.mjs --config worker-N.json
  |
  v
Node.js worker (render-genecards.mjs)
  |
  |-- Starts local HTTP file server (serves genome files, BED tracks)
  |-- Imports igv-node.esm.js bundle
  |-- Creates OfflineBrowser with hg38 genome + 4 tracks:
  |     1. GeneCards Genes (BED annotation)
  |     2. Canonical Transcripts (GFF)
  |     3. Other Transcripts (GFF)
  |     4. GeneHancer Regulation (in-memory, per-gene)
  |
  |-- For each gene in batch:
  |     1. Compute locus with 25% flanking
  |     2. OfflineBrowser.renderToFile(locus, width, outputPath)
  |        |
  |        |-- goto(locus) -> creates ReferenceFrame
  |        |-- For each track:
  |        |     loadFeatures() -> OfflineViewport.render() -> Canvas
  |        |-- Compositor stacks all track canvases
  |        |-- canvas.toBuffer('image/jpeg', quality) -> file
  |     3. Report progress as JSON to stdout
  |
  v
C# reads stdout JSON messages, tracks progress, logs results
```

### Build

```bash
npm run build:node    # produces dist/igv-node.esm.js and dist/igv-node.cjs
```

### Release (GitHub Actions)

Tag-based releases via `.github/workflows/release-node-bundle.yml`:

```bash
git tag node-v1.0.0
git push lifemap node-v1.0.0
```

This triggers a GitHub Actions workflow that:
1. Builds the Node bundle
2. Updates the version in `package.node.json` to match the tag
3. Creates a GitHub Release with `igv-node.esm.js` and `package.json` as assets

### Deploy

Use `deploy-igv-bundle.ps1` (in the C# project) to download a release and install deps:

```powershell
.\deploy-igv-bundle.ps1 -StaticIGVPath "D:\data\generation\v6.0\static\IGV"
.\deploy-igv-bundle.ps1 -StaticIGVPath "..." -Tag "node-v1.0.0"
```

### Important: Browser Build Is Unaffected

All offline rendering code lives in `js/node/`. The browser builds (`dist/igv.esm.js`, `dist/igv.js`) use `rollup.config.js` which does not reference any `js/node/` files or `@napi-rs/canvas`. The `@napi-rs/canvas` dependency is optional (peer dependency) and only needed for the Node bundle.
