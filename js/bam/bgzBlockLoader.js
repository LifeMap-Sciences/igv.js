import {BGZip, igvxhr} from "../../node_modules/igv-utils/src/index.js"
import {buildOptions} from "../util/igvUtils.js"
import {concatenateArrayBuffers} from "../util/bufferUtils.js"

const FEXTRA = 4  // gzip spec F.EXTRA flag

/**
 * Return the block size for the data buffer.
 * @param data
 * @returns {number}
 */
const bgzBlockSize = (data) => {
    const ba = ArrayBuffer.isView(data) ? data : new Uint8Array(data)
    const bsize = (ba[17] << 8 | ba[16]) + 1
    return bsize
}

class BGZBlockLoader {

    constructor(config) {
        this.config = config
        this.cacheBlocks = false != config.cacheBlocks   // Default to true
        this.cache = undefined
        this.inflatedBlockCache = new Map()  // filePosition -> inflated Uint8Array
    }

    /**
     * Return inflated data from startBlock through endBlock as an UInt8Array
     *
     * @param minv minimum virtual pointer  {block, offset}
     * @param maxv maximum virtual pointer  {block, offset}
     * @returns {Promise<Uint8Array>}
     */
    async getData(minv, maxv) {

        const startBlock = minv.block
        const endBlock = maxv.block
        const skipEnd = maxv.offset === 0

        const blocks = await this.getInflatedBlocks(startBlock, endBlock, skipEnd)
        if (blocks.length === 1) {
            return blocks[0]
        }

        let len = 0
        for (const b of blocks) {
            len += b.byteLength
        }
        const c = new Uint8Array(len)
        let offset = 0
        for (const b of blocks) {
            c.set(b, offset)
            offset += b.byteLength
        }
        return c
    }

    /**
     * Return the inflated data for the specified blocks as an array of Uint8Arrays.  This method is public so
     * it can be unit tested. *
     * @param startBlock
     * @param endBlock
     * @returns {Promise<*[Uint8Array]>}
     */
    async getInflatedBlocks(startBlock, endBlock, skipEnd) {

        const ibc = this.inflatedBlockCache

        if (!this.cacheBlocks) {
            const buffer = await this.loadBLockData(startBlock, endBlock, {skipEnd})
            return inflateBlocks(buffer, undefined, undefined, ibc, startBlock)
        } else {

            const c = this.cache
            if (c &&
                c.startBlock <= startBlock &&
                (c.endBlock >= endBlock || skipEnd && c.nextEndBlock === endBlock)) {
                //console.log("Complete overlap")
                const startOffset = startBlock - c.startBlock
                const endOffset = endBlock - c.startBlock
                return inflateBlocks(c.buffer, startOffset, endOffset, ibc, c.startBlock)
                // Don't update cache, still valid
            } else {

                let buffer
                if (!c || (c.startBlock > endBlock || c.endBlock < startBlock)) {
                    // no overlap with cache
                    buffer = await this.loadBLockData(startBlock, endBlock, {skipEnd})
                } else {

                    //console.log("Some overlap")
                    const arrayBuffers = []

                    // Load blocks preceding cache start, if any
                    if (startBlock < c.startBlock) {
                        // load first blocks
                        const startBuffer = await this.loadBLockData(startBlock, c.startBlock, {skipEnd: true})
                        arrayBuffers.push(startBuffer)
                    }

                    // Slice cached buffer as needed
                    let cachedBuffer
                    if (startBlock <= c.startBlock && endBlock >= c.endBlock) {
                        cachedBuffer = c.buffer
                    } else {
                        const start = Math.max(0, startBlock - c.startBlock)
                        let end
                        if (endBlock >= c.endBlock) {
                            end = c.buffer.byteLength
                        } else {
                            // We need to find the byte position of the end of "endBlock"
                            const boundaries = findBlockBoundaries(c.buffer)
                            for (let i = 0; i < boundaries.length - 1; i++) {
                                if (c.startBlock + boundaries[i] === endBlock) {
                                    end = boundaries[i + 1]
                                    break
                                }
                            }
                            // Do something if end not found
                        }
                        cachedBuffer = c.buffer.slice(start, end)
                    }
                    arrayBuffers.push(cachedBuffer)

                    // Load end blocks, if any
                    if (endBlock > c.endBlock) {
                        const endBuffer = await this.loadBLockData(c.endBlock, endBlock, {skipStart: true, skipEnd})
                        arrayBuffers.push(endBuffer)
                    }

                    buffer = concatenateArrayBuffers(arrayBuffers)
                }

                // If skipEnd === true we need to find boundary of last block in cache
                let nextEndBlock = endBlock
                if(skipEnd) {
                    const boundaries = findBlockBoundaries(buffer)
                    endBlock = boundaries[boundaries.length - 1]
                }

                this.cache = {startBlock, endBlock, nextEndBlock, buffer}
                return inflateBlocks(buffer, undefined, undefined, ibc, startBlock)
            }
        }
    }

    async loadBLockData(startBlock, endBlock, options) {

        const config = this.config
        const skipStart = options && options.skipStart
        const skipEnd = options && options.skipEnd

        // Get size of last block if not skipped
        let lastBlockSize = 0
        if (!skipEnd) {
            const bsizeOptions = buildOptions(config, {range: {start: endBlock, size: 26}})
            const abuffer = await igvxhr.loadArrayBuffer(config.url, bsizeOptions)
            lastBlockSize = bgzBlockSize(abuffer)
        }

        if (skipStart) {
            const bsizeOptions = buildOptions(config, {range: {start: startBlock, size: 26}})
            const abuffer = await igvxhr.loadArrayBuffer(config.url, bsizeOptions)
            startBlock += bgzBlockSize(abuffer)
        }

        // Load data for all blocks
        const loadOptions = buildOptions(config, {
            range: {
                start: startBlock,
                size: endBlock + lastBlockSize - startBlock
            }
        })

        return igvxhr.loadArrayBuffer(config.url, loadOptions)
    }
}

function findBlockBoundaries(arrayBuffer) {

    const byteLengh = arrayBuffer.byteLength
    let offset = 0
    const blockBoundaries = [0]
    while (offset < byteLengh) {
        //console.log("Cache block "  + offset)
        const ba = new Uint8Array(arrayBuffer, offset)
        const bsize = (ba[17] << 8 | ba[16]) + 1
        offset += bsize
        if (offset < byteLengh) {
            blockBoundaries.push(offset)
        }
    }
    return blockBoundaries
}


/**
 * Inflate compressed blocks within the data buffer*
 * @param data
 * @param startBlock - optional byte offset for start block within data.  Default == 0
 * @param endBlock - optional byte offset for last block to decompress within data.
 * @param inflatedCache - optional Map<filePosition, Uint8Array> for caching decompressed blocks
 * @param baseFilePosition - file position corresponding to byte 0 in data (used as cache key base)
 * @returns {*[]}
 */
function inflateBlocks(data, startBlock, endBlock, inflatedCache, baseFilePosition) {

    startBlock = startBlock || 0

    const oBlockList = []
    let ptr = startBlock

    const lim = data.byteLength - 18
    while (ptr < lim) {
        try {
            const header = new Uint8Array(data, ptr, 18)

            // Validate BGZF header (gzip magic + deflate + FEXTRA flag)
            if (header[0] !== 0x1f || header[1] !== 0x8b || header[2] !== 0x08 || (header[3] & FEXTRA) === 0) {
                break  // Not a valid BGZF block (e.g. over-fetched past end of data)
            }

            const bsize = ((header[17] << 8) | (header[16]))  // Total block size, including header, minus 1

            // Check inflated block cache
            const filePos = baseFilePosition !== undefined ? baseFilePosition + ptr : undefined
            if (inflatedCache && filePos !== undefined && inflatedCache.has(filePos)) {
                oBlockList.push(inflatedCache.get(filePos))
            } else {
                const xlen = (header[11] << 8) | (header[10])
                const start = 12 + xlen + ptr    // Start of CDATA
                const bytesLeft = data.byteLength - start
                const cDataSize = bsize - xlen - 18

                if (bytesLeft < cDataSize || cDataSize <= 0) {
                    break
                }

                const cdata = new Uint8Array(data, start, cDataSize)
                const inflate = globalThis.__igv_native_inflate_raw || BGZip.inflateRaw
                const unc = inflate(cdata)

                // Cache the inflated block
                if (inflatedCache && filePos !== undefined) {
                    inflatedCache.set(filePos, unc)
                    // Prevent unbounded growth — clear cache if it gets too large
                    if (inflatedCache.size > 500) {
                        inflatedCache.clear()
                    }
                }

                oBlockList.push(unc)
            }

            if (endBlock === ptr) {
                break
            } else {
                // Advance to next block
                ptr += bsize + 1
            }

        } catch (e) {
            console.error(e)
            break
        }
    }
    return oBlockList
}

/**
 * Concat*
 * @param blocks
 * @returns {Uint8Array}
 */
function concatenateBlocks(blocks) {

    // if (arrays.length === 1) {
    //     return arrays[0]
    // }

    let len = 0
    for (const b of blocks) {
        len += b.byteLength
    }
    const c = new Uint8Array(len)
    let offset = 0
    for (const b of blocks) {
        c.set(b, offset)
        offset += b.byteLength
    }
    return c
}


export {BGZBlockLoader as default, inflateBlocks, findBlockBoundaries}