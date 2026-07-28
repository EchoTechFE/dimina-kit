// node:crypto shim for the browser build. @dimina/compiler derives its CSS scope id
// via `createHash('sha256').update(path).digest().readBigUInt64BE(0)` (utils.js). The
// browser has no node:crypto, and Web Crypto's `subtle.digest` is async — it cannot
// back a synchronous `uuid()`. So this provides a self-contained synchronous SHA-256.
// Only the sha256 + digest()->Buffer path the compiler actually uses is implemented.
import { Buffer } from 'buffer'

const K = new Uint32Array([
  0x428A2F98, 0x71374491, 0xB5C0FBCF, 0xE9B5DBA5, 0x3956C25B, 0x59F111F1, 0x923F82A4, 0xAB1C5ED5,
  0xD807AA98, 0x12835B01, 0x243185BE, 0x550C7DC3, 0x72BE5D74, 0x80DEB1FE, 0x9BDC06A7, 0xC19BF174,
  0xE49B69C1, 0xEFBE4786, 0x0FC19DC6, 0x240CA1CC, 0x2DE92C6F, 0x4A7484AA, 0x5CB0A9DC, 0x76F988DA,
  0x983E5152, 0xA831C66D, 0xB00327C8, 0xBF597FC7, 0xC6E00BF3, 0xD5A79147, 0x06CA6351, 0x14292967,
  0x27B70A85, 0x2E1B2138, 0x4D2C6DFC, 0x53380D13, 0x650A7354, 0x766A0ABB, 0x81C2C92E, 0x92722C85,
  0xA2BFE8A1, 0xA81A664B, 0xC24B8B70, 0xC76C51A3, 0xD192E819, 0xD6990624, 0xF40E3585, 0x106AA070,
  0x19A4C116, 0x1E376C08, 0x2748774C, 0x34B0BCB5, 0x391C0CB3, 0x4ED8AA4A, 0x5B9CCA4F, 0x682E6FF3,
  0x748F82EE, 0x78A5636F, 0x84C87814, 0x8CC70208, 0x90BEFFFA, 0xA4506CEB, 0xBEF9A3F7, 0xC67178F2,
])

function rotr(x, n) {
  return (x >>> n) | (x << (32 - n))
}

// SHA-256 over a Uint8Array, returning the 32-byte digest as a Uint8Array.
function sha256(msg) {
  let h0 = 0x6A09E667, h1 = 0xBB67AE85, h2 = 0x3C6EF372, h3 = 0xA54FF53A
  let h4 = 0x510E527F, h5 = 0x9B05688C, h6 = 0x1F83D9AB, h7 = 0x5BE0CD19

  const l = msg.length
  const bitLen = l * 8
  // pad: 0x80, then zeros so length ≡ 56 (mod 64), then 64-bit big-endian bit length.
  const total = (((l + 8) >> 6) + 1) << 6
  const buf = new Uint8Array(total)
  buf.set(msg)
  buf[l] = 0x80
  const dv = new DataView(buf.buffer)
  dv.setUint32(total - 8, Math.floor(bitLen / 0x100000000), false)
  dv.setUint32(total - 4, bitLen >>> 0, false)

  const w = new Uint32Array(64)
  for (let i = 0; i < total; i += 64) {
    for (let t = 0; t < 16; t++) w[t] = dv.getUint32(i + t * 4, false)
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3)
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10)
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (h + S1 + ch + K[t] + w[t]) >>> 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) >>> 0
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0
  }

  const out = new Uint8Array(32)
  const odv = new DataView(out.buffer)
  const hs = [h0, h1, h2, h3, h4, h5, h6, h7]
  for (let i = 0; i < 8; i++) odv.setUint32(i * 4, hs[i], false)
  return out
}

class Hash {
  constructor() {
    this._chunks = []
  }

  // Accepts a string (UTF-8 encoded, matching node's default) or raw bytes
  // (Uint8Array/Buffer, copied). No inputEncoding form (`update(x, 'hex')`) — the
  // compiler only ever hashes a path string, and silently accepting an encoding we
  // ignore would diverge from node:crypto.
  update(data) {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data)
    this._chunks.push(bytes)
    return this
  }

  digest() {
    let len = 0
    for (const c of this._chunks) len += c.length
    const all = new Uint8Array(len)
    let off = 0
    for (const c of this._chunks) { all.set(c, off); off += c.length }
    // Return a Buffer so callers can use Buffer methods (readBigUInt64BE) on the digest.
    return Buffer.from(sha256(all))
  }
}

export function createHash(algorithm) {
  if (algorithm !== 'sha256') {
    throw new Error(`[compiler] browser crypto shim only implements sha256 (got '${algorithm}')`)
  }
  return new Hash()
}

export default { createHash }
