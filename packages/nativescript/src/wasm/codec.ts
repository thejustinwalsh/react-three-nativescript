// Codec for the native side of the WKWebView bridge.
//
// The bridge boundary (WKScriptMessage.body / evaluateJavaScript) is JSON-string only — it can't
// carry ArrayBuffers. So every ArrayBuffer/typed-array is tagged and base64-encoded into the JSON,
// and reconstructed on the far side.
//
// Base64 prefers a real built-in: the TC39 `Uint8Array.toBase64`/`fromBase64` if the runtime's V8
// has them, then `atob`/`btoa` if the environment provides them. NativeScript's V8 ships none of
// atob/btoa/Buffer (its TextEncoder is UTF-8 only), so the hand-rolled path below is the fallback it
// actually needs — not the primary. (The WebView side uses WebKit's built-in atob/btoa.)

export const BUFFER_TAG = '__nsab__'

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const B64_LOOKUP = /* @__PURE__ */ (() => {
  const t = new Uint8Array(256)
  for (let i = 0; i < B64_CHARS.length; i++) t[B64_CHARS.charCodeAt(i)] = i
  return t
})()

// Hand-rolled fallback — the path NS V8 takes when no built-in base64 exists.
export function manualToBase64(bytes: Uint8Array): string {
  let out = ''
  const len = bytes.length
  let i = 0
  for (; i + 2 < len; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    out += B64_CHARS[(n >> 18) & 63] + B64_CHARS[(n >> 12) & 63] + B64_CHARS[(n >> 6) & 63] + B64_CHARS[n & 63]
  }
  const rem = len - i
  if (rem === 1) {
    const n = bytes[i] << 16
    out += B64_CHARS[(n >> 18) & 63] + B64_CHARS[(n >> 12) & 63] + '=='
  } else if (rem === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8)
    out += B64_CHARS[(n >> 18) & 63] + B64_CHARS[(n >> 12) & 63] + B64_CHARS[(n >> 6) & 63] + '='
  }
  return out
}

export function manualFromBase64(b64: string): Uint8Array {
  const len = b64.length
  if (len === 0) return new Uint8Array(0)
  let pad = 0
  if (b64.charCodeAt(len - 1) === 61) pad++
  if (b64.charCodeAt(len - 2) === 61) pad++
  const outLen = (len >> 2) * 3 - pad
  const out = new Uint8Array(outLen)
  let p = 0
  for (let i = 0; i < len; i += 4) {
    const n =
      (B64_LOOKUP[b64.charCodeAt(i)] << 18) |
      (B64_LOOKUP[b64.charCodeAt(i + 1)] << 12) |
      (B64_LOOKUP[b64.charCodeAt(i + 2)] << 6) |
      B64_LOOKUP[b64.charCodeAt(i + 3)]
    if (p < outLen) out[p++] = (n >> 16) & 255
    if (p < outLen) out[p++] = (n >> 8) & 255
    if (p < outLen) out[p++] = n & 255
  }
  return out
}

// Pick a BYTE-EXACT base64 once, at load: the TC39 Uint8Array built-in if present, else the manual
// codec.
//
// Deliberately NOT atob/btoa. They are NOT byte-exact on NativeScript: its native btoa/atob
// (NSString.btoa, the WinterTC layer) operate on UTF-8, so a byte >= 0x80 inflates to its 2-byte
// UTF-8 form (0xa0 -> "c2 a0"). Across this bridge the native side would btoa (UTF-8) and the WebView
// would atob (latin1, per the browser spec) — mismatched, so binary corrupts one-way. (A full
// round-trip hides it: native atob later UTF-8-decodes it back, which is why a byte-echo test passes
// while a one-way decode like meshopt fails.) The manual codec is latin1/byte-exact, which is what
// binary needs; toBase64 operates on the bytes directly, so it's exact too.
const base64 = /* @__PURE__ */ (() => {
  const U8 = Uint8Array as unknown as {
    fromBase64?: (s: string) => Uint8Array
    prototype: { toBase64?: () => string }
  }
  const hasNative = typeof U8.prototype.toBase64 === 'function' && typeof U8.fromBase64 === 'function'
  if (hasNative) {
    return {
      name: 'Uint8Array.toBase64',
      enc: (b: Uint8Array) => (b as unknown as { toBase64(): string }).toBase64(),
      dec: (s: string) => U8.fromBase64!(s),
    }
  }
  return { name: 'manual', enc: manualToBase64, dec: manualFromBase64 }
})()

// Which base64 the native side picked. NativeScript's V8 has no TC39 Uint8Array.toBase64, so this is
// 'manual' there — the byte-exact path binary requires (NS's native btoa/atob are UTF-8, unusable).
export const base64Backend = base64.name

export function base64FromBytes(bytes: Uint8Array): string {
  return base64.enc(bytes)
}

export function bytesFromBase64(b64: string): Uint8Array {
  return base64.dec(b64)
}

// Tag + base64 every ArrayBuffer/typed-array so structured data survives the JSON-only host boundary.
export function encode(value: unknown): unknown {
  if (value instanceof ArrayBuffer) return { [BUFFER_TAG]: base64FromBytes(new Uint8Array(value)) }
  // Honor the view's offset/length — a subarray (e.g. GLTFLoader's view into the GLB buffer) ships
  // only its own bytes, not the entire backing ArrayBuffer.
  if (ArrayBuffer.isView(value))
    return {
      [BUFFER_TAG]: base64FromBytes(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)),
      view: value.constructor.name,
    }
  if (Array.isArray(value)) return value.map(encode)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value as object)) out[k] = encode((value as Record<string, unknown>)[k])
    return out
  }
  return value
}

export function decode(value: unknown): unknown {
  if (value && typeof value === 'object') {
    const tag = (value as Record<string, unknown>)[BUFFER_TAG]
    if (typeof tag === 'string') {
      const bytes = bytesFromBase64(tag)
      const view = (value as Record<string, unknown>).view as string | undefined
      const ctor = view
        ? (globalThis as unknown as Record<string, new (b: ArrayBufferLike) => unknown>)[view]
        : undefined
      if (ctor) return new ctor(bytes.buffer)
      return bytes.buffer
    }
    if (Array.isArray(value)) return value.map(decode)
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value as object)) out[k] = decode((value as Record<string, unknown>)[k])
    return out
  }
  return value
}
