// Meshopt decoder for NativeScript, backed by the WKWebView wasm bridge on iOS.
//
// three's MeshoptDecoder is wasm-only (no JS fallback) and bails at import with `{ supported: false }`
// when `WebAssembly` is absent — which is exactly iOS NativeScript (jitless V8). So on iOS we don't
// run meshopt on the main thread at all. Instead the *whole* stock module runs inside a worker that
// has wasm (a WKWebView via `createWasmWorker`), and the main thread holds a thin shim that forwards
// each `decodeGltfBufferAsync` over the bridge. GLTFLoader already calls that method async and
// Suspense already awaits the load, so the bridge slots into an async socket that's already there.
//
// On Android (and anywhere the app V8 has wasm) there's no bridge to justify — the stock decoder
// works directly, so `getMeshoptDecoder` hands that back instead.

import { createWasmWorker, type WorkerLike } from './webview-worker'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'

// The `@ns-inline:` directive: the ns-worker-loader discovers this path in the AST and replaces the
// string with the (export-stripped) source of meshopt_decoder.module.js at build time — zero config.
// The module embeds its own wasm as a byte literal, so the inlined text is self-contained; run inside
// the WebView (where `WebAssembly` exists) it defines a fully `supported` MeshoptDecoder. If the loader
// didn't run, the directive stays a string and worker creation throws — a decode rejection, not a
// silent wrong result.
const MESHOPT_MODULE_SOURCE = '@ns-inline:three/examples/jsm/libs/meshopt_decoder.module.js'

// Appended after the module: a worker-side message handler that decodes one bufferView per request.
// `decodeGltfBuffer` maps the glTF mode/filter strings to wasm exports itself, so we forward them raw.
const WORKER_HANDLER = `
self.onmessage = function (e) {
  var m = e.data
  if (!m || m.kind !== 'meshopt') return
  MeshoptDecoder.ready.then(function () {
    var src = m.source instanceof Uint8Array ? m.source : new Uint8Array(m.source)
    try {
      var target = new Uint8Array(m.count * m.size)
      MeshoptDecoder.decodeGltfBuffer(target, m.count, m.size, src, m.mode, m.filter)
      self.postMessage({ id: m.id, ok: true, result: target }, [target.buffer])
    } catch (err) {
      // On failure, report the params + first source bytes. A valid meshopt stream begins with a
      // header byte 0xa_ (vertex) or 0xe_ (index); garbage head => the source corrupted in transit.
      var head = ''
      for (var i = 0; i < (src.length < 8 ? src.length : 8); i++) head += (src[i] < 16 ? '0' : '') + src[i].toString(16)
      self.postMessage({
        id: m.id,
        ok: false,
        error:
          String((err && err.message) || err) +
          ' [count=' + m.count + ' size=' + m.size + ' srcLen=' + src.length + ' mode=' + m.mode + ' filter=' + m.filter + ' head=' + head + ']',
      })
    }
  })
}
`

// The subset of MeshoptDecoder GLTFLoader actually uses (its `EXT_meshopt_compression` path).
export interface MeshoptDecoderLike {
  supported: boolean
  ready: Promise<void>
  decodeGltfBufferAsync(
    count: number,
    size: number,
    source: Uint8Array,
    mode: string,
    filter: string,
  ): Promise<Uint8Array>
}

type Pending = { resolve: (v: Uint8Array) => void; reject: (e: Error) => void }

export function createBridgedDecoder(): MeshoptDecoderLike {
  let worker: WorkerLike | null = null
  const pending = new Map<number, Pending>()
  let nextId = 0

  function ensureWorker(): WorkerLike {
    if (worker) return worker
    const w = createWasmWorker(MESHOPT_MODULE_SOURCE + '\n' + WORKER_HANDLER)
    w.onmessage = (e) => {
      const m = e.data as { id: number; ok: boolean; result?: Uint8Array; error?: string }
      const p = pending.get(m.id)
      if (!p) return
      pending.delete(m.id)
      if (m.ok && m.result)
        p.resolve(m.result instanceof Uint8Array ? m.result : new Uint8Array(m.result as ArrayBufferLike))
      else p.reject(new Error(m.error || 'meshopt: decode failed'))
    }
    w.onerror = (e) => {
      // A worker-level failure can't be tied to one request; fail every in-flight decode.
      const err = new Error(`meshopt worker: ${e.message}`)
      for (const p of pending.values()) p.reject(err)
      pending.clear()
    }
    worker = w
    return w
  }

  return {
    supported: true,
    ready: Promise.resolve(),
    decodeGltfBufferAsync(count, size, source, mode, filter) {
      const w = ensureWorker()
      return new Promise<Uint8Array>((resolve, reject) => {
        const id = ++nextId
        pending.set(id, { resolve, reject })
        // GLTFLoader hands a subarray view into the GLB buffer; copy to a tight buffer so only these
        // bytes cross the bridge (and the encoder ships exactly them).
        const src = source.slice()
        w.postMessage({ kind: 'meshopt', id, count, size, source: src, mode, filter })
      })
    },
  }
}

let bridged: MeshoptDecoderLike | null = null

// The decoder to hand `loader.setMeshoptDecoder(...)`. Stock module when the app V8 has wasm
// (Android), the WKWebView-bridged decoder when it doesn't (iOS).
export function getMeshoptDecoder(): MeshoptDecoderLike {
  const tag = '[NS-R3F MESHOPT]'
  const hasWebAssembly = typeof (globalThis as { WebAssembly?: unknown }).WebAssembly !== 'undefined'
  const stockSupported = !!(MeshoptDecoder as MeshoptDecoderLike).supported
  console.log(`${tag} getMeshoptDecoder() called - hasWebAssembly=${hasWebAssembly}, stockSupported=${stockSupported}`)

  if (hasWebAssembly && stockSupported) {
    console.log(`${tag} → Using STOCK MeshoptDecoder (Android path or V8 with wasm)`)
    return MeshoptDecoder as unknown as MeshoptDecoderLike
  }
  console.log(`${tag} → Falling back to BRIDGED (WKWebView) decoder`)
  if (!bridged) {
    console.log(`${tag} Creating bridged decoder for the first time`)
    bridged = createBridgedDecoder()
  }
  return bridged
}
