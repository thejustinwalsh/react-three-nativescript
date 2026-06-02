import { describe, it, expect, vi, beforeEach } from 'vitest'

// Fake worker + registry, hoisted so the vi.mock factory can use them.
const h = vi.hoisted(() => {
  class FakeWorker {
    onmessage: ((e: { data: any }) => void) | null = null
    onerror: ((e: { message: string }) => void) | null = null
    posted: any[] = []
    postMessage(d: any) {
      this.posted.push(d)
    }
    terminate() {}
    reply(d: any) {
      this.onmessage?.({ data: d })
    }
    fail(message: string) {
      this.onerror?.({ message })
    }
  }
  return { FakeWorker, workers: [] as InstanceType<typeof FakeWorker>[] }
})

vi.mock('../src/wasm/webview-worker', () => ({
  createWasmWorker: () => {
    const w = new h.FakeWorker()
    h.workers.push(w)
    return w
  },
}))

import { createBridgedDecoder, getMeshoptDecoder } from '../src/wasm/meshopt-decoder'

beforeEach(() => {
  h.workers.length = 0
})

describe('getMeshoptDecoder selector', () => {
  it('returns a memoized bridged decoder when WebAssembly is absent (iOS)', () => {
    const saved = (globalThis as any).WebAssembly
    try {
      delete (globalThis as any).WebAssembly
      const a = getMeshoptDecoder()
      const b = getMeshoptDecoder()
      expect(a).toBe(b) // memoized singleton, not a fresh decoder per call
      expect(a.supported).toBe(true)
      // it's the bridged decoder: a decode lazily spins up a (faked) worker
      a.decodeGltfBufferAsync(1, 4, new Uint8Array([1]), 'ATTRIBUTES', 'NONE')
      expect(h.workers.length).toBe(1)
    } finally {
      ;(globalThis as any).WebAssembly = saved
    }
  })

  it('returns the stock decoder (no bridge worker) when WebAssembly is present', () => {
    expect(typeof (globalThis as any).WebAssembly).not.toBe('undefined')
    const dec = getMeshoptDecoder()
    dec.decodeGltfBufferAsync(1, 4, new Uint8Array([1]), 'ATTRIBUTES', 'NONE').catch(() => {})
    expect(h.workers.length).toBe(0) // stock path never touches createWasmWorker
  })
})

describe('bridged meshopt decoder', () => {
  it('reports supported and a resolved ready', async () => {
    const dec = createBridgedDecoder()
    expect(dec.supported).toBe(true)
    await expect(dec.ready).resolves.toBeUndefined()
  })

  it('lazily creates exactly one worker, shared across decodes', () => {
    const dec = createBridgedDecoder()
    expect(h.workers.length).toBe(0) // nothing until first decode
    dec.decodeGltfBufferAsync(1, 4, new Uint8Array([1]), 'ATTRIBUTES', 'NONE')
    dec.decodeGltfBufferAsync(1, 4, new Uint8Array([2]), 'ATTRIBUTES', 'NONE')
    expect(h.workers.length).toBe(1)
  })

  it('forwards count/size/mode/filter and a COPY of the source', () => {
    const dec = createBridgedDecoder()
    const backing = new Uint8Array([0, 0, 7, 8, 9, 0])
    const source = backing.subarray(2, 5) // [7,8,9]
    dec.decodeGltfBufferAsync(3, 12, source, 'TRIANGLES', 'OCTAHEDRAL')
    const msg = h.workers[0].posted[0]
    expect(msg.kind).toBe('meshopt')
    expect(msg.count).toBe(3)
    expect(msg.size).toBe(12)
    expect(msg.mode).toBe('TRIANGLES')
    expect(msg.filter).toBe('OCTAHEDRAL')
    expect(Array.from(msg.source)).toEqual([7, 8, 9])
    expect(msg.source).not.toBe(source) // a tight copy, not the GLB-backed view
    expect(msg.source.byteOffset).toBe(0)
  })

  it('resolves with the decoded bytes keyed by id', async () => {
    const dec = createBridgedDecoder()
    const p = dec.decodeGltfBufferAsync(2, 2, new Uint8Array([1]), 'ATTRIBUTES', 'NONE')
    const id = h.workers[0].posted[0].id
    h.workers[0].reply({ id, ok: true, result: new Uint8Array([4, 5, 6, 7]) })
    const out = await p
    expect(Array.from(out)).toEqual([4, 5, 6, 7])
  })

  it('routes concurrent decodes to the right promise', async () => {
    const dec = createBridgedDecoder()
    const p1 = dec.decodeGltfBufferAsync(1, 1, new Uint8Array([1]), 'ATTRIBUTES', 'NONE')
    const p2 = dec.decodeGltfBufferAsync(1, 1, new Uint8Array([2]), 'ATTRIBUTES', 'NONE')
    const [id1, id2] = h.workers[0].posted.map((m) => m.id)
    expect(id1).not.toBe(id2)
    // Reply out of order.
    h.workers[0].reply({ id: id2, ok: true, result: new Uint8Array([22]) })
    h.workers[0].reply({ id: id1, ok: true, result: new Uint8Array([11]) })
    expect(Array.from(await p1)).toEqual([11])
    expect(Array.from(await p2)).toEqual([22])
  })

  it('rejects a decode whose worker reports ok:false', async () => {
    const dec = createBridgedDecoder()
    const p = dec.decodeGltfBufferAsync(1, 1, new Uint8Array([1]), 'ATTRIBUTES', 'NONE')
    const id = h.workers[0].posted[0].id
    h.workers[0].reply({ id, ok: false, error: 'Malformed buffer data: 1' })
    await expect(p).rejects.toThrow(/Malformed buffer data/)
  })

  it('rejects all in-flight decodes on a worker-level error', async () => {
    const dec = createBridgedDecoder()
    const p1 = dec.decodeGltfBufferAsync(1, 1, new Uint8Array([1]), 'ATTRIBUTES', 'NONE')
    const p2 = dec.decodeGltfBufferAsync(1, 1, new Uint8Array([2]), 'ATTRIBUTES', 'NONE')
    h.workers[0].fail('inner worker crashed')
    await expect(p1).rejects.toThrow(/inner worker crashed/)
    await expect(p2).rejects.toThrow(/inner worker crashed/)
  })

  it('rejects a decode that never gets a reply, after the timeout', async () => {
    vi.useFakeTimers()
    try {
      const dec = createBridgedDecoder()
      const p = dec.decodeGltfBufferAsync(1, 1, new Uint8Array([1]), 'ATTRIBUTES', 'NONE')
      const settled = expect(p).rejects.toThrow(/timed out/)
      await vi.advanceTimersByTimeAsync(30_000)
      await settled
    } finally {
      vi.useRealTimers()
    }
  })
})
