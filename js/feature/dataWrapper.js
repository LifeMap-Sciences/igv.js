function getDataWrapper(data) {

    if (typeof (data) == 'string' || data instanceof String) {
        return new StringDataWrapper(data)
    } else if (data.length > 0x1fffffe0) {
        // Buffer exceeds V8's max string length — decode line-by-line
        return new BufferLineWrapper(data)
    } else {
        // Use native TextDecoder for fast bulk conversion instead of the
        // byte-by-byte UTF-8 decoding in ByteArrayDataWrapper
        const decoded = new TextDecoder().decode(data)
        return new StringDataWrapper(decoded)
    }
}


// Data might be a string, or an UInt8Array
class StringDataWrapper {

    constructor(string) {
        this.data = string
        this.ptr = 0
    }

    nextLine() {
        var start = this.ptr,
            idx = this.data.indexOf('\n', start),
            data = this.data

        if (idx > 0) {
            this.ptr = idx + 1   // Advance pointer for next line
            if (idx > start && data.charAt(idx - 1) === '\r') {
                // Trim CR manually in CR/LF sequence
                return data.substring(start, idx - 1)
            }
            return data.substring(start, idx)
        } else {
            var length = data.length
            this.ptr = length
            // Return undefined only at the very end of the data
            return (start >= length) ? undefined : data.substring(start)
        }
    }
}

class ByteArrayDataWrapper {

    /**
     *
     * @param {Uint8Array} array
     */
    constructor(array) {
        this.data = array
        this.length = this.data.length
        this.ptr = 0
    }

    /**
     * Decode the next line as a UTF-8 string.  From: https://gist.github.com/Yaffle/5458286
     * @returns {undefined|string}
     */
    nextLine() {
        if(this.ptr >= this.data.length) {
            return undefined
        }
        let i = this.ptr
        const octets = this.data
        let string = ""
        let maybeCR = false
        while (i < octets.length) {
            var octet = octets[i]
            var bytesNeeded = 0
            var codePoint = 0
            if (octet <= 0x7F) {
                bytesNeeded = 0
                codePoint = octet & 0xFF
            } else if (octet <= 0xDF) {
                bytesNeeded = 1
                codePoint = octet & 0x1F
            } else if (octet <= 0xEF) {
                bytesNeeded = 2
                codePoint = octet & 0x0F
            } else if (octet <= 0xF4) {
                bytesNeeded = 3
                codePoint = octet & 0x07
            }
            if (octets.length - i - bytesNeeded > 0) {
                var k = 0
                while (k < bytesNeeded) {
                    octet = octets[i + k + 1]
                    codePoint = (codePoint << 6) | (octet & 0x3F)
                    k += 1
                }
            } else {
                codePoint = 0xFFFD
                bytesNeeded = octets.length - i
            }
            i += bytesNeeded + 1

            const c = String.fromCodePoint(codePoint)
            if(c === '\r') {
                maybeCR = true
            } else if( c === '\n') {
                break
            } else {
                if(maybeCR) {
                    // Add cr's unless immediately followed by a line feed.
                    string += '\r'
                    maybeCR = false
                }
                string += c
            }
        }
        this.ptr = i
        return string
    }


}

/**
 * Line-by-line wrapper for large buffers that exceed V8's max string length.
 * Scans for newline bytes and decodes each line individually.
 */
class BufferLineWrapper {

    constructor(buffer) {
        this.data = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
        this.ptr = 0
        this.decoder = new TextDecoder()
    }

    nextLine() {
        if (this.ptr >= this.data.length) {
            return undefined
        }
        const start = this.ptr
        let end = this.data.indexOf(0x0A, start)  // Find newline byte
        if (end === -1) {
            end = this.data.length
            this.ptr = end
        } else {
            this.ptr = end + 1
        }
        // Trim trailing CR if present
        if (end > start && this.data[end - 1] === 0x0D) {
            end--
        }
        return this.decoder.decode(this.data.subarray(start, end))
    }
}

export default getDataWrapper
