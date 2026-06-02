import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { encode, decode } from '../src/wasm/codec'
import { WebViewWorkerHost } from '../src/wasm/webview-worker'

// A fake iOS surface: captures evaluateJavaScript strings, the registered script-message handlers,
// and lets the test drive didFinishNavigation + inbound messages.
function installIOS() {
  const evals: string[] = []
  const handlers: Record<string, any> = {}
  const webView: any = {
    navigationDelegate: null,
    loadHTMLStringBaseURL: () => {},
    evaluateJavaScriptCompletionHandler: (js: string, cb: any) => {
      evals.push(js)
      cb && cb(null, null)
    },
  }
  const controller = { addScriptMessageHandlerName: (h: any, name: string) => (handlers[name] = h) }
  const config = { userContentController: controller }
  const g = globalThis as any
  g.WKWebViewConfiguration = { alloc: () => ({ init: () => config }) }
  g.WKWebView = { alloc: () => ({ initWithFrameConfiguration: () => webView }) }
  g.CGRectMake = () => ({})
  g.WKScriptMessageHandler = {}
  g.WKNavigationDelegate = {}
  g.NSURL = { URLWithString: (s: string) => ({ s }) }
  g.NSObject = { extend: (methods: any) => ({ new: () => ({ ...methods }) }) }
  return { evals, handlers, webView }
}

function uninstallIOS() {
  const g = globalThis as any
  for (const k of [
    'WKWebViewConfiguration',
    'WKWebView',
    'CGRectMake',
    'WKScriptMessageHandler',
    'WKNavigationDelegate',
    'NSURL',
    'NSObject',
  ])
    delete g[k]
}

// Reassemble the chunked __hostRecv(id,seq,total,"json") calls back into decoded payloads.
function drainOutgoing(evals: string[]): any[] {
  const buf: Record<number, { parts: string[]; total: number; got: number }> = {}
  const done: any[] = []
  for (const js of evals) {
    const m = /^self\.__hostRecv\((\d+),(\d+),(\d+),([\s\S]*)\)$/.exec(js)
    if (!m) continue
    const id = +m[1]
    const seq = +m[2]
    const total = +m[3]
    const part = JSON.parse(m[4]) as string
    let b = buf[id]
    if (!b) b = buf[id] = { parts: new Array(total), total, got: 0 }
    if (b.parts[seq] === undefined) {
      b.parts[seq] = part
      b.got++
    }
    if (b.got === total) {
      done.push(decode(JSON.parse(b.parts.join(''))))
      delete buf[id]
    }
  }
  return done
}

let io: ReturnType<typeof installIOS>
beforeEach(() => {
  io = installIOS()
})
afterEach(() => uninstallIOS())

function ready() {
  io.webView.navigationDelegate.webViewDidFinishNavigation()
}

describe('WebViewWorkerHost protocol', () => {
  it('queues sends until didFinishNavigation, then flushes a decoded spawn', () => {
    const host = new (WebViewWorkerHost as any)()
    host.spawn('SRC()')
    expect(io.evals.length).toBe(0) // queued until ready
    ready()
    const out = drainOutgoing(io.evals)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ type: 'spawn', ch: 1, source: 'SRC()' })
  })

  it('sends a post frame carrying a reconstructed buffer', () => {
    const host = new (WebViewWorkerHost as any)()
    const ch = host.spawn('SRC()')
    ready()
    io.evals.length = 0
    ch.postMessage({ kind: 'meshopt', source: new Uint8Array([5, 6, 7]) })
    const [msg] = drainOutgoing(io.evals)
    expect(msg.type).toBe('post')
    expect(msg.ch).toBe(1)
    expect(msg.data.kind).toBe('meshopt')
    expect(Array.from(msg.data.source)).toEqual([5, 6, 7])
  })

  it('routes an inbound message to the right channel with buffers reconstructed', () => {
    const host = new (WebViewWorkerHost as any)()
    const ch = host.spawn('SRC()')
    ready()
    let received: any = null
    ch.onmessage = (e: { data: any }) => (received = e.data)
    const full = JSON.stringify(
      encode({ type: 'message', ch: 1, data: { id: 9, result: new Uint8Array([1, 2, 3, 4]) } }),
    )
    io.handlers.nshost.userContentControllerDidReceiveScriptMessage(null, {
      body: JSON.stringify({ id: 100, seq: 0, total: 1, data: full }),
    })
    expect(received.id).toBe(9)
    expect(Array.from(received.result)).toEqual([1, 2, 3, 4])
  })

  it('ignores inbound for an unknown channel', () => {
    const host = new (WebViewWorkerHost as any)()
    host.spawn('SRC()')
    ready()
    const full = JSON.stringify(encode({ type: 'message', ch: 999, data: { x: 1 } }))
    expect(() =>
      io.handlers.nshost.userContentControllerDidReceiveScriptMessage(null, {
        body: JSON.stringify({ id: 1, seq: 0, total: 1, data: full }),
      }),
    ).not.toThrow()
  })

  it('routes a channel-tagged error to that channel; an untagged page message never rejects channels', () => {
    const host = new (WebViewWorkerHost as any)()
    const a = host.spawn('A()')
    const b = host.spawn('B()')
    ready()
    let aErr = '',
      bErr = ''
    a.onerror = (e: { message: string }) => (aErr = e.message)
    b.onerror = (e: { message: string }) => (bErr = e.message)
    // Tagged: only channel 1's onerror fires.
    io.handlers.nshosterror.userContentControllerDidReceiveScriptMessage(null, {
      body: JSON.stringify({ ch: 1, message: 'boom-1' }),
    })
    expect(aErr).toBe('boom-1')
    expect(bErr).toBe('')
    // Untagged (a page-level message / caps report): logged, NOT routed to any channel — it must not
    // reject in-flight decodes (the regression where a caps report killed a meshopt decode).
    io.handlers.nshosterror.userContentControllerDidReceiveScriptMessage(null, {
      body: JSON.stringify({ message: 'page-info' }),
    })
    expect(aErr).toBe('boom-1') // unchanged
    expect(bErr).toBe('')
  })

  it('chunks a large outgoing payload and reassembles losslessly', () => {
    const host = new (WebViewWorkerHost as any)()
    const big = 'x'.repeat(300_000) // > CHUNK_CHARS (256KB)
    host.spawn(big)
    ready()
    const frames = io.evals.filter((js) => js.startsWith('self.__hostRecv'))
    expect(frames.length).toBeGreaterThan(1) // actually chunked
    const [out] = drainOutgoing(io.evals)
    expect(out.source).toBe(big)
  })

  it('reassembles an out-of-order chunked inbound message before delivering once', () => {
    const host = new (WebViewWorkerHost as any)()
    const ch = host.spawn('SRC()')
    ready()
    let calls = 0
    let data: any = null
    ch.onmessage = (e: { data: any }) => {
      calls++
      data = e.data
    }
    const full = JSON.stringify(encode({ type: 'message', ch: 1, data: { tag: 'whole' } }))
    const mid = Math.floor(full.length / 2)
    const p0 = full.slice(0, mid)
    const p1 = full.slice(mid)
    const recv = io.handlers.nshost.userContentControllerDidReceiveScriptMessage
    // Deliver seq 1 first, then seq 0.
    recv(null, { body: JSON.stringify({ id: 42, seq: 1, total: 2, data: p1 }) })
    expect(calls).toBe(0) // not yet complete
    recv(null, { body: JSON.stringify({ id: 42, seq: 0, total: 2, data: p0 }) })
    expect(calls).toBe(1)
    expect(data).toEqual({ tag: 'whole' })
  })

  it('terminate sends a terminate frame and forgets the channel', () => {
    const host = new (WebViewWorkerHost as any)()
    const ch = host.spawn('SRC()')
    ready()
    io.evals.length = 0
    ch.terminate()
    const [msg] = drainOutgoing(io.evals)
    expect(msg).toMatchObject({ type: 'terminate', ch: 1 })
  })
})
