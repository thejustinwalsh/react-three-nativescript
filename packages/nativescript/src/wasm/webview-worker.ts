// Wasm workers for NativeScript iOS, multiplexed through ONE WKWebView.
//
// NativeScript's V8 is jitless on iOS (Apple's JIT ban), so `WebAssembly` is unavailable there.
// WKWebView is WebKit, has the JIT entitlement, and — being a full browser — supports real
// `Worker`s that run wasm at full speed on their own threads. So instead of a WKWebView per worker
// (one WebKit content process each), we run a SINGLE hidden WKWebView host and spawn real web
// Workers *inside* it, one per channel. The host routes native <-> inner-worker traffic; every
// `createWasmWorker` is a channel on that one host. Process count stays at one no matter how many
// decoders (meshopt, KTX2, draco-wasm) or models are in flight.
//
// Transport: the host boundary (WKScriptMessage.body / evaluateJavaScript) is JSON-only. Native ->
// WebView, buffers and large strings ride the nsbin:// scheme — stashed in a registry, the WebView
// FETCHes them as raw bytes (no base64, no IPC-size limit); only the small JSON structure is framed
// into <=CHUNK_CHARS chunks. WebView -> native (the decoded result) can't use the scheme (WKWebView
// strips custom-scheme request bodies), so it stays buffer-tagged base64 + chunked. Inside the WebView,
// host <-> inner-worker uses native structured clone — real buffers, no copy.
//
// On Android (and anywhere the app V8 has wasm) there's no bridge to justify: `createWasmWorker`
// returns a real native `Worker`.

import { Utils } from '@nativescript/core'
import { BUFFER_TAG, encode, decode } from './codec'
import { registerBinScheme, binURL, type BinRegistry } from './bin-channel'

type Listener = (event: { data: unknown }) => void

export interface WorkerLike {
  onmessage: Listener | null
  onerror: ((event: { message: string }) => void) | null
  postMessage(data: unknown): void
  terminate(): void
}

const isIOS = !!(global as any).__APPLE__ || (typeof Utils !== 'undefined' && (Utils as any).ios !== undefined)

// Max characters per bridged IPC frame; larger messages are split and reassembled by id.
const CHUNK_CHARS = 256 * 1024

// Strings at/above this length go over the nsbin:// channel (as bytes) instead of inline in the
// framed JSON — so a big worker source isn't chunked through evaluateJavaScript. Small strings stay
// inline (a fetch per tiny string isn't worth it).
const NSBIN_TEXT_MIN = 4096

// The page loaded once into the host WKWebView. It manages real inner Workers keyed by channel,
// routes spawn/post/terminate from native, and forwards each inner worker's messages + errors back
// (buffer-tagged + chunked). Inner workers see real structured-cloned buffers — base64 lives only on
// the native boundary.
function hostBootstrapHTML(): string {
  const host = `
    var __TAG='${BUFFER_TAG}';
    var __CHUNK=${CHUNK_CHARS};
    var __hasB64=typeof Uint8Array.prototype.toBase64==='function'&&typeof Uint8Array.fromBase64==='function';
    function __b64ToBytes(b64){if(__hasB64)return Uint8Array.fromBase64(b64);var bin=atob(b64);var u=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);return u;}
    function __bytesToB64(u){if(__hasB64)return u.toBase64();var s='';for(var i=0;i<u.length;i++)s+=String.fromCharCode(u[i]);return btoa(s);}
    function __enc(v){if(v instanceof ArrayBuffer){var o={};o[__TAG]=__bytesToB64(new Uint8Array(v));return o;}
      if(ArrayBuffer.isView(v)){var o={};o[__TAG]=__bytesToB64(new Uint8Array(v.buffer,v.byteOffset,v.byteLength));o.view=v.constructor.name;return o;}
      if(Array.isArray(v))return v.map(__enc);
      if(v&&typeof v==='object'){var o={};for(var k in v)o[k]=__enc(v[k]);return o;}return v;}
    function __dec(v){
      if(v&&typeof v==='object'){
        if(typeof v.__nsbin__==='string')return fetch('nsbin://b/'+v.__nsbin__).then(function(r){return r.arrayBuffer();}).then(function(ab){return v.text?new TextDecoder().decode(ab):(v.view&&self[v.view]?new self[v.view](ab):ab);});
        if(typeof v[__TAG]==='string'){var b=__b64ToBytes(v[__TAG]);return Promise.resolve(v.view&&self[v.view]?new self[v.view](b.buffer):b.buffer);}
        if(Array.isArray(v))return Promise.all(v.map(__dec));
        var out={};return Promise.all(Object.keys(v).map(function(k){return __dec(v[k]).then(function(d){out[k]=d;});})).then(function(){return out;});
      }
      return Promise.resolve(v);
    }
    var __sendSeq=0;
    function __hostSend(obj){
      var json=JSON.stringify(__enc(obj));var id=++__sendSeq;
      var total=Math.max(1,Math.ceil(json.length/__CHUNK));
      for(var seq=0;seq<total;seq++){window.webkit.messageHandlers.nshost.postMessage(JSON.stringify({id:id,seq:seq,total:total,data:json.slice(seq*__CHUNK,(seq+1)*__CHUNK)}));}
    }
    function __report(message,ch){try{window.webkit.messageHandlers.nshosterror.postMessage(JSON.stringify({ch:ch,message:String(message)}));}catch(e){}}
    function __xfer(v,acc){
      if(v instanceof ArrayBuffer){acc.push(v);return;}
      if(ArrayBuffer.isView(v)){acc.push(v.buffer);return;}
      if(Array.isArray(v)){for(var i=0;i<v.length;i++)__xfer(v[i],acc);return;}
      if(v&&typeof v==='object'){for(var k in v)__xfer(v[k],acc);}
    }
    var __workers={};
    var __recvBuf={};
    self.__hostRecv=function(id,seq,total,data){
      var b=__recvBuf[id];if(!b){b=__recvBuf[id]={parts:new Array(total),got:0,total:total};}
      if(b.parts[seq]===undefined){b.parts[seq]=data;b.got++;}
      if(b.got===b.total){var full=b.parts.join('');delete __recvBuf[id];__hostHandle(full);}
    };
    // __dec is async (it may fetch nsbin buffers), so messages are chained — each fully handled before
    // the next starts — or a 'post' could outrun the 'spawn' that creates its worker.
    var __chain=Promise.resolve();
    function __hostHandle(json){
      __chain=__chain.then(function(){
        var parsed;try{parsed=JSON.parse(json);}catch(err){__report((err&&err.message)||String(err));return;}
        return __dec(parsed).then(function(msg){
          if(msg.type==='spawn'){
            var url=URL.createObjectURL(new Blob([msg.source],{type:'text/javascript'}));
            var w=new Worker(url);__workers[msg.ch]=w;
            (function(ch){
              w.onmessage=function(e){__hostSend({type:'message',ch:ch,data:e.data});};
              w.onerror=function(e){__report((e&&(e.message||e.filename))||'inner worker error',ch);};
            })(msg.ch);
          }else if(msg.type==='post'){
            var pw=__workers[msg.ch];if(pw){var t=[];__xfer(msg.data,t);pw.postMessage(msg.data,t);}
          }else if(msg.type==='terminate'){
            var tw=__workers[msg.ch];if(tw){try{tw.terminate();}catch(e){}delete __workers[msg.ch];}
          }
        }).catch(function(err){__report((err&&err.stack)||(err&&err.message)||String(err),parsed&&parsed.ch);});
      });
    }
    window.onerror=function(message,source,line,col,err){__report((err&&err.stack)||(message+' @'+line+':'+col));return true;};
    window.addEventListener('unhandledrejection',function(ev){__report('unhandledrejection: '+((ev.reason&&ev.reason.stack)||ev.reason));});
  `
  return `<!doctype html><html><head><meta charset="utf-8"><script>${host}\n//# sourceURL=nshost.js</script></head><body></body></html>`
}

// One channel = one inner Worker. A thin WorkerLike handle; all transport goes through the host.
class HostChannel implements WorkerLike {
  onmessage: Listener | null = null
  onerror: ((event: { message: string }) => void) | null = null
  constructor(
    private host: WebViewWorkerHost,
    private ch: number,
  ) {}
  postMessage(data: unknown): void {
    this.host.postToChannel(this.ch, data)
  }
  terminate(): void {
    this.host.terminateChannel(this.ch)
  }
}

// The single hidden WKWebView. Lazily created on the first iOS wasm worker; never torn down (keeping
// it warm avoids re-instantiating decoder wasm). Owns chunk reassembly, outgoing framing, and the
// channel registry.
class WebViewWorkerHost {
  private static instance: WebViewWorkerHost | null = null
  static shared(): WebViewWorkerHost {
    if (!this.instance) this.instance = new WebViewWorkerHost()
    return this.instance
  }

  private webView: any
  private handler: any
  private errorHandler: any
  private navDelegate: any
  private ready = false
  private queue: string[] = []
  private msgSeq = 0
  private nextCh = 0
  private incoming = new Map<number, { parts: string[]; got: number; total: number }>()
  private channels = new Map<number, HostChannel>()
  // The native -> WebView binary channel (no base64). Live for future input-side use (large sources,
  // KTX2 textures, wasm blobs); see bin-channel.ts for why it's input-only.
  private binRegistry: BinRegistry | null = null
  private binVerify: ((v: { ok: boolean; detail: string }) => void) | null = null
  readonly whenReady: Promise<void>
  private resolveReady!: () => void

  constructor() {
    const WKConfig = (global as any).WKWebViewConfiguration
    const WKWebView = (global as any).WKWebView
    if (!WKConfig || !WKWebView) throw new Error('WebViewWorkerHost requires iOS WKWebView')
    this.whenReady = new Promise<void>((resolve) => (this.resolveReady = resolve))

    const config = WKConfig.alloc().init()
    const controller = config.userContentController
    // Register the nsbin:// scheme on the config (frozen at WebView init, so it must happen here).
    this.binRegistry = registerBinScheme(config)

    // Inner worker -> native: {type:'message', ch, data}, reassembled from frames then decoded.
    const Handler = (global as any).NSObject.extend(
      {
        userContentControllerDidReceiveScriptMessage: (_uc: unknown, message: any) => {
          const full = this.reassemble(JSON.parse(message.body))
          if (full == null) return
          const msg = decode(JSON.parse(full)) as { type: string; ch: number; data?: unknown }
          if (msg.type === 'message') this.channels.get(msg.ch)?.onmessage?.({ data: msg.data })
        },
      },
      { protocols: [(global as any).WKScriptMessageHandler] },
    )
    this.handler = Handler.new()
    controller.addScriptMessageHandlerName(this.handler, 'nshost')

    // Errors: inner worker.onerror (tagged with ch) or a page-level exception (no ch → broadcast).
    const ErrorHandler = (global as any).NSObject.extend(
      {
        userContentControllerDidReceiveScriptMessage: (_uc: unknown, message: any) => {
          let parsed: { ch?: number; message?: string }
          try {
            parsed = JSON.parse(message.body)
          } catch {
            parsed = { message: String(message.body) }
          }
          const text = String(parsed.message)
          if (parsed.ch != null && this.channels.has(parsed.ch))
            this.channels.get(parsed.ch)!.onerror?.({ message: text })
          // Page-level (no channel): a caps report or a page error. LOG only — never reject channels.
          // An info report or an unrelated page error must not kill in-flight decodes.
          else console.log(text)
        },
      },
      { protocols: [(global as any).WKScriptMessageHandler] },
    )
    this.errorHandler = ErrorHandler.new()
    controller.addScriptMessageHandlerName(this.errorHandler, 'nshosterror')

    // One-shot reply channel for verifyBinChannel()'s device round-trip.
    const VerifyHandler = (global as any).NSObject.extend(
      {
        userContentControllerDidReceiveScriptMessage: (_uc: unknown, message: any) => {
          const cb = this.binVerify
          this.binVerify = null
          try {
            cb?.(JSON.parse(message.body))
          } catch {
            cb?.({ ok: false, detail: String(message.body) })
          }
        },
      },
      { protocols: [(global as any).WKScriptMessageHandler] },
    )
    controller.addScriptMessageHandlerName(VerifyHandler.new(), 'nsbinverify')

    const frame = (global as any).CGRectMake(0, 0, 1, 1)
    this.webView = WKWebView.alloc().initWithFrameConfiguration(frame, config)

    const NavDelegate = (global as any).NSObject.extend(
      {
        webViewDidFinishNavigation: () => {
          this.ready = true
          for (const json of this.queue) this.deliver(json)
          this.queue = []
          this.resolveReady()
        },
        webViewDidFailNavigationWithError: (_wv: unknown, _nav: unknown, error: any) => {
          this.broadcastError(String((error && error.localizedDescription) || error))
        },
      },
      { protocols: [(global as any).WKNavigationDelegate] },
    )
    this.navDelegate = NavDelegate.new()
    this.webView.navigationDelegate = this.navDelegate

    // A real http origin (not null/about:blank) so the page may create blob-URL Workers — WebKit
    // blocks worker construction from an opaque origin.
    const NSURL = (global as any).NSURL
    const baseURL = NSURL && NSURL.URLWithString ? NSURL.URLWithString('http://localhost/') : null
    this.webView.loadHTMLStringBaseURL(hostBootstrapHTML(), baseURL)
  }

  // Spawn an inner worker for `source`; returns its channel handle.
  spawn(source: string): WorkerLike {
    const ch = ++this.nextCh
    const channel = new HostChannel(this, ch)
    this.channels.set(ch, channel)
    this.send({ type: 'spawn', ch, source })
    return channel
  }

  postToChannel(ch: number, data: unknown): void {
    this.send({ type: 'post', ch, data })
  }

  terminateChannel(ch: number): void {
    this.channels.delete(ch)
    this.send({ type: 'terminate', ch })
  }

  // Stash a buffer the WebView can fetch as the returned nsbin:// URL — the native -> WebView path
  // with no base64. (Input-side; the result direction stays on the bridge. See bin-channel.ts.)
  putBinary(bytes: Uint8Array): string | null {
    return this.binRegistry ? binURL(this.binRegistry.put(bytes)) : null
  }

  // Device verification of the nsbin:// channel: stash a known 0..255 ramp, have the page fetch it as
  // raw bytes (no base64) and report whether they match. Resolves { ok, detail }.
  async verifyBinChannel(): Promise<{ ok: boolean; detail: string }> {
    if (!this.binRegistry) return { ok: false, detail: 'no bin registry (not iOS WebKit)' }
    await this.whenReady
    const probe = new Uint8Array(256)
    for (let i = 0; i < probe.length; i++) probe[i] = i
    const url = binURL(this.binRegistry.put(probe))
    // Wrapped in a void IIFE: the fetch chain is async, and returning the Promise makes
    // evaluateJavaScript's completion fire with "unsupported type". The real result comes back via
    // the nsbinverify handler; the IIFE returns undefined so the completion only fires on a sync throw.
    const js =
      `(function(){fetch(${JSON.stringify(url)}).then(function(r){return r.arrayBuffer()}).then(function(ab){` +
      `var u=new Uint8Array(ab);` +
      `window.webkit.messageHandlers.nsbinverify.postMessage(JSON.stringify({ok:(u.length===256&&u[0]===0&&u[255]===255),detail:'len='+u.length+' first='+u[0]+' last='+u[u.length-1]}));` +
      `}).catch(function(e){window.webkit.messageHandlers.nsbinverify.postMessage(JSON.stringify({ok:false,detail:String((e&&e.message)||e)}));});})();`
    return new Promise((resolve) => {
      this.binVerify = resolve
      this.webView.evaluateJavaScriptCompletionHandler(js, (_r: unknown, err: any) => {
        if (err) {
          this.binVerify = null
          resolve({ ok: false, detail: 'eval: ' + String(err.localizedDescription || err) })
        }
      })
    })
  }

  private broadcastError(message: string): void {
    for (const c of this.channels.values()) c.onerror?.({ message })
  }

  private reassemble(env: { id: number; seq: number; total: number; data: string }): string | null {
    let b = this.incoming.get(env.id)
    if (!b) {
      b = { parts: new Array(env.total), got: 0, total: env.total }
      this.incoming.set(env.id, b)
    }
    if (b.parts[env.seq] === undefined) {
      b.parts[env.seq] = env.data
      b.got++
    }
    if (b.got !== b.total) return null
    this.incoming.delete(env.id)
    return b.parts.join('')
  }

  // Encode for native -> WebView: buffers (and large strings) are stashed in the nsbin registry and
  // replaced with a key the WebView fetches as raw bytes — no base64, and the big payloads don't ride
  // the framed evaluateJavaScript path at all. Small scalars/strings stay inline.
  private encodeBin(value: unknown): unknown {
    const reg = this.binRegistry!
    if (value instanceof ArrayBuffer) return { __nsbin__: reg.put(new Uint8Array(value)) }
    if (ArrayBuffer.isView(value)) {
      const v = value as ArrayBufferView
      return { __nsbin__: reg.put(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)), view: value.constructor.name }
    }
    if (typeof value === 'string' && value.length >= NSBIN_TEXT_MIN) {
      return { __nsbin__: reg.put(new (global as any).TextEncoder().encode(value)), text: true }
    }
    if (Array.isArray(value)) return value.map((x) => this.encodeBin(x))
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const k of Object.keys(value as object)) out[k] = this.encodeBin((value as Record<string, unknown>)[k])
      return out
    }
    return value
  }

  private send(obj: unknown): void {
    // nsbin path on iOS (binary + big strings fetched over the scheme, no base64); base64 fallback
    // where there's no registry.
    const json = JSON.stringify(this.binRegistry ? this.encodeBin(obj) : encode(obj))
    if (this.ready) this.deliver(json)
    else this.queue.push(json)
  }

  private deliver(json: string): void {
    const id = ++this.msgSeq
    const total = Math.max(1, Math.ceil(json.length / CHUNK_CHARS))
    for (let seq = 0; seq < total; seq++) {
      const part = json.slice(seq * CHUNK_CHARS, (seq + 1) * CHUNK_CHARS)
      // JSON.stringify(part) makes a valid JS string literal; __hostRecv reassembles before handling.
      const call = `self.__hostRecv(${id},${seq},${total},${JSON.stringify(part)})`
      this.webView.evaluateJavaScriptCompletionHandler(call, (_res: unknown, err: any) => {
        if (err) this.broadcastError(String(err.localizedDescription || err))
      })
    }
  }
}

// Warm the shared WKWebView host ahead of first use, so the first decode doesn't pay WebView
// creation + page-load latency. No-op where there's no host (Android, anywhere with app-V8 wasm).
// Call once at app start, e.g. in your entry module. Safe to call repeatedly.
export function preloadWasmHost(): void {
  const tag = '[NS-R3F WASM-HOST]'
  console.log(`${tag} preloadWasmHost() called`)
  const isIOSPlatform =
    !!(global as any).__APPLE__ || (typeof Utils !== 'undefined' && (Utils as any).ios !== undefined)
  const hasWebAssembly = typeof (global as any).WebAssembly !== 'undefined'
  console.log(`${tag} isIOSPlatform=${isIOSPlatform}, hasWebAssembly=${hasWebAssembly}`)
  if (isIOSPlatform && !hasWebAssembly) {
    console.log(`${tag} → Actually creating WKWebView host now (iOS without native wasm)`)
    WebViewWorkerHost.shared()
  } else {
    console.log(`${tag} → No-op (Android or V8 has WebAssembly)`)
  }
}

// Device check of the nsbin:// native -> WebView binary channel. Resolves { ok, detail }; on a
// platform without the host (native wasm) it's a trivial ok.
export function verifyBinChannel(): Promise<{ ok: boolean; detail: string }> {
  if (isIOS && typeof (global as any).WebAssembly === 'undefined') return WebViewWorkerHost.shared().verifyBinChannel()
  return Promise.resolve({ ok: true, detail: 'no bin channel needed (native wasm)' })
}

// Create a worker that can run wasm: a channel on the shared WKWebView host on iOS, a real native
// Worker elsewhere (Android/anywhere WebAssembly exists). `source` is the worker script (e.g. with
// an inlined decoder, as produced by ns-worker-loader).
export function createWasmWorker(source: string): WorkerLike {
  const tag = '[NS-R3F WASM-WORKER]'
  const isIOSPlatform =
    !!(global as any).__APPLE__ || (typeof Utils !== 'undefined' && (Utils as any).ios !== undefined)
  const hasWebAssembly = typeof (global as any).WebAssembly !== 'undefined'
  console.log(`${tag} createWasmWorker() called, source length=${source?.length || 0}`)
  if (isIOSPlatform && !hasWebAssembly) {
    console.log(`${tag} → Using WKWebView bridged worker host`)
    return WebViewWorkerHost.shared().spawn(source)
  }
  console.log(`${tag} → Creating real native Worker (Android path)`)
  const url = (global as any).URL?.createObjectURL?.(new (global as any).Blob([source], { type: 'text/javascript' }))
  return new (global as any).Worker(url) as WorkerLike
}

export { WebViewWorkerHost }
