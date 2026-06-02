// Binary channel: native -> WebView bulk transfer with no base64, via a custom WKURLSchemeHandler.
//
// WHY (and the honest boundary). The bridge's JSON wall forces base64 (1.33x size + a CPU pass) on
// every buffer. A custom URL scheme lets the WebView FETCH raw bytes from native: the page does
// `fetch('nsbin://b/<key>')` and gets an ArrayBuffer straight from NSData — zero base64, zero copy
// into a JS string. That is the right tool for the native -> WebView direction (INPUTS: a large
// compressed source, a KTX2 texture, a wasm blob).
//
// It does NOT help the other direction. Our hot payload is the DECODED RESULT, which flows
// WebView -> native, and WKWebView strips the body of custom-scheme requests before the handler
// sees it (a long-standing platform limitation), and script messages are JSON-only. So a scheme
// handler cannot carry the result back. Result stays on the chunked base64 path (now native
// atob/btoa + transferables); inputs can go binary. Verified by the directionality of the API, not
// hoped at: the WebView can pull, it cannot push bytes.
//
// This module is the native -> WebView half: a one-shot registry of buffers the page can fetch.
// The registry is unit-tested; the native handler is device-verified (meshopt decode rides it).

import { debug } from '../debug'
export const BIN_SCHEME = 'nsbin'

// One-shot store: a buffer is freed the moment the WebView fetches it, so a decode's input doesn't
// linger in native memory after it's been pulled across. The "freed on fetch" contract only holds on
// the happy path; CAP bounds the worst case (a fetch that never lands) by evicting the oldest entry
// so an un-fetched buffer can't pin memory indefinitely.
const CAP = 64

export class BinRegistry {
  private store = new Map<string, Uint8Array>()
  private seq = 0

  put(bytes: Uint8Array): string {
    if (this.store.size >= CAP) {
      const oldest = this.store.keys().next().value
      if (oldest !== undefined) {
        this.store.delete(oldest)
        debug('[R3FNS] BinRegistry over cap, evicting un-fetched key', oldest)
      }
    }
    const key = String(++this.seq)
    this.store.set(key, bytes)
    return key
  }

  take(key: string): Uint8Array | undefined {
    const bytes = this.store.get(key)
    if (bytes !== undefined) this.store.delete(key)
    return bytes
  }

  get size(): number {
    return this.store.size
  }
}

// Build the URL the page fetches for a given key.
export function binURL(key: string): string {
  return `${BIN_SCHEME}://b/${key}`
}

// The last path segment of an nsbin:// URL is its key.
export function keyFromURL(url: string): string {
  const q = url.indexOf('?')
  const clean = q === -1 ? url : url.slice(0, q)
  return clean.substring(clean.lastIndexOf('/') + 1)
}

// Register the scheme handler on a WKWebViewConfiguration BEFORE its WKWebView is created (the
// scheme set is frozen at WebView init). Returns the registry, or null where there's no WebKit.
// The native interop (NSData from an ArrayBuffer, the URL response) is the device-verified part.
export function registerBinScheme(config: unknown, g: Record<string, any> = global as never): BinRegistry | null {
  const cfg = config as { setURLSchemeHandlerForURLScheme?: (h: unknown, s: string) => void } | null
  if (!cfg || typeof cfg.setURLSchemeHandlerForURLScheme !== 'function' || !g.NSObject || !g.WKURLSchemeHandler) {
    return null
  }
  const registry = new BinRegistry()

  const Handler = g.NSObject.extend(
    {
      webViewStartURLSchemeTask: (_webView: unknown, task: any) => {
        const url = String(task.request.URL.absoluteString)
        try {
          const bytes = registry.take(keyFromURL(url))
          const body = bytes ?? new Uint8Array(0)
          // Tight, owned, offset-0 copy of just these bytes (slice() copies; never reaches into a
          // shared backing buffer).
          const ab = body.byteLength ? body.slice().buffer : new ArrayBuffer(0)
          // Build an NSData that OWNS its bytes: passing the raw ArrayBuffer lets NS hand WebKit a
          // no-copy wrapper over V8 memory that's GC-eligible the moment this handler returns — a
          // cross-process use-after-free. dataWithData copies into ObjC-owned storage.
          const data = g.NSData && g.NSData.dataWithData ? g.NSData.dataWithData(ab) : ab
          // NSHTTPURLResponse with CORS headers: the page's origin (http://localhost) differs from the
          // nsbin:// scheme, so fetch() needs Access-Control-Allow-Origin to read the body.
          const response = g.NSHTTPURLResponse.alloc().initWithURLStatusCodeHTTPVersionHeaderFields(
            task.request.URL,
            200,
            'HTTP/1.1',
            {
              'Access-Control-Allow-Origin': '*',
              'Content-Type': 'application/octet-stream',
              'Content-Length': String(body.byteLength),
              'Cache-Control': 'no-store',
            },
          )
          task.didReceiveResponse(response)
          task.didReceiveData(data)
          task.didFinish()
        } catch (err) {
          debug('[nsbin] handler error:', url, String((err as Error)?.message ?? err))
          if (task && task.didFailWithError && g.NSError) {
            task.didFailWithError(g.NSError.errorWithDomainCodeUserInfo('nsbin', 1, null))
          }
        }
      },
      webViewStopURLSchemeTask: () => {},
    },
    { protocols: [g.WKURLSchemeHandler] },
  )
  cfg.setURLSchemeHandlerForURLScheme(Handler.new(), BIN_SCHEME)
  return registry
}
