import { describe, it, expect } from 'vitest'
import {
  BUFFER_TAG,
  base64FromBytes,
  bytesFromBase64,
  manualToBase64,
  manualFromBase64,
  encode,
  decode,
} from '../src/wasm/codec'

// Node's Buffer is the source of truth for base64 correctness.
const refB64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')

const cases: Record<string, Uint8Array> = {
  empty: new Uint8Array([]),
  one: new Uint8Array([0]),
  two: new Uint8Array([255, 1]),
  three: new Uint8Array([1, 2, 3]),
  four: new Uint8Array([0, 127, 128, 255]),
  five: new Uint8Array([9, 8, 7, 6, 5]),
  allBytes: new Uint8Array(Array.from({ length: 256 }, (_, i) => i)),
}

describe('codec base64', () => {
  it('manual encoder matches Buffer for every remainder class', () => {
    for (const [name, bytes] of Object.entries(cases)) {
      expect(manualToBase64(bytes), name).toBe(refB64(bytes))
    }
  })

  it('manual decoder round-trips and matches Buffer-decoded bytes', () => {
    for (const [name, bytes] of Object.entries(cases)) {
      const decoded = manualFromBase64(refB64(bytes))
      expect(Array.from(decoded), name).toEqual(Array.from(bytes))
    }
  })

  it('manual round-trips a large random buffer', () => {
    const big = new Uint8Array(200_000)
    for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) & 255
    expect(Array.from(manualFromBase64(manualToBase64(big)))).toEqual(Array.from(big))
  })

  it('the selected backend round-trips identically to the manual one', () => {
    // Whatever backend was picked (atob/btoa in jsdom), it must agree with the reference.
    for (const [name, bytes] of Object.entries(cases)) {
      expect(base64FromBytes(bytes), name).toBe(refB64(bytes))
      expect(Array.from(bytesFromBase64(refB64(bytes))), name).toEqual(Array.from(bytes))
    }
  })
})

describe('codec encode/decode', () => {
  it('passes primitives through untouched', () => {
    expect(encode(5)).toBe(5)
    expect(encode('hi')).toBe('hi')
    expect(encode(null)).toBe(null)
    expect(decode(encode({ a: 1, b: 'x', c: true }))).toEqual({ a: 1, b: 'x', c: true })
  })

  it('round-trips an ArrayBuffer', () => {
    const ab = new Uint8Array([10, 20, 30]).buffer
    const out = decode(JSON.parse(JSON.stringify(encode(ab)))) as ArrayBuffer
    expect(out).toBeInstanceOf(ArrayBuffer)
    expect(Array.from(new Uint8Array(out))).toEqual([10, 20, 30])
  })

  it('round-trips typed arrays preserving the view type', () => {
    const f = new Float32Array([1.5, -2.25, 3.0])
    const out = decode(JSON.parse(JSON.stringify(encode(f)))) as Float32Array
    expect(out).toBeInstanceOf(Float32Array)
    expect(Array.from(out)).toEqual([1.5, -2.25, 3.0])
  })

  it('ships only a subarray view, not the whole backing buffer', () => {
    // A view into the middle of a larger buffer (the GLTFLoader-into-GLB case).
    const backing = new Uint8Array([0, 0, 0, 11, 22, 33, 0, 0])
    const view = backing.subarray(3, 6) // [11,22,33], offset 3
    const enc = encode(view) as Record<string, string>
    // The base64 must be exactly the 3 view bytes, not the 8 backing bytes.
    expect(enc[BUFFER_TAG]).toBe(Buffer.from([11, 22, 33]).toString('base64'))
    const out = decode(JSON.parse(JSON.stringify(enc))) as Uint8Array
    expect(Array.from(out)).toEqual([11, 22, 33])
  })

  it('round-trips nested objects and arrays of buffers', () => {
    const msg = {
      kind: 'meshopt',
      id: 7,
      bufs: [new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])],
      meta: { source: new Uint8Array([9]) },
    }
    const out = decode(JSON.parse(JSON.stringify(encode(msg)))) as typeof msg
    expect(out.kind).toBe('meshopt')
    expect(out.id).toBe(7)
    expect(Array.from(out.bufs[0])).toEqual([1, 2])
    expect(Array.from(out.bufs[1])).toEqual([3, 4, 5])
    expect(Array.from(out.meta.source)).toEqual([9])
  })
})
