import { describe, it, expect } from 'vitest'
import { BinRegistry, binURL, keyFromURL, BIN_SCHEME, registerBinScheme } from '../src/wasm/bin-channel'

describe('BinRegistry', () => {
  it('stores a buffer under an incrementing key', () => {
    const r = new BinRegistry()
    expect(r.put(new Uint8Array([1]))).toBe('1')
    expect(r.put(new Uint8Array([2]))).toBe('2')
    expect(r.size).toBe(2)
  })

  it('take is one-shot: returns the buffer then frees it', () => {
    const r = new BinRegistry()
    const key = r.put(new Uint8Array([9, 8, 7]))
    expect(Array.from(r.take(key)!)).toEqual([9, 8, 7])
    expect(r.take(key)).toBeUndefined() // gone after first take
    expect(r.size).toBe(0)
  })
})

describe('nsbin url helpers', () => {
  it('round-trips a key through binURL/keyFromURL', () => {
    expect(binURL('42')).toBe(`${BIN_SCHEME}://b/42`)
    expect(keyFromURL(binURL('42'))).toBe('42')
  })
  it('keyFromURL ignores a query string', () => {
    expect(keyFromURL(`${BIN_SCHEME}://b/7?cacheBust=1`)).toBe('7')
  })
})

describe('registerBinScheme', () => {
  it('returns null when WebKit globals are absent', () => {
    expect(registerBinScheme(null, {})).toBeNull()
    expect(registerBinScheme({ setURLSchemeHandlerForURLScheme: () => {} }, {})).toBeNull()
  })

  it('registers the nsbin scheme and serves a put buffer to a started task', () => {
    let registeredScheme = ''
    let registeredHandler: any = null
    const g: any = {
      WKURLSchemeHandler: {},
      NSHTTPURLResponse: {
        alloc: () => ({ initWithURLStatusCodeHTTPVersionHeaderFields: () => ({}) }),
      },
      NSObject: { extend: (methods: any) => ({ new: () => ({ ...methods }) }) },
    }
    const config = {
      setURLSchemeHandlerForURLScheme: (h: any, scheme: string) => {
        registeredHandler = h
        registeredScheme = scheme
      },
    }
    const registry = registerBinScheme(config, g)!
    expect(registry).not.toBeNull()
    expect(registeredScheme).toBe(BIN_SCHEME)

    // Stash a buffer; drive a fake URL scheme task for its URL and capture what's served.
    const key = registry.put(new Uint8Array([3, 1, 4, 1, 5]))
    let served: Uint8Array | null = null
    let finished = false
    const task = {
      request: { URL: { absoluteString: binURL(key) } },
      didReceiveResponse: () => {},
      didReceiveData: (ab: ArrayBuffer) => (served = new Uint8Array(ab)),
      didFinish: () => (finished = true),
      didFailWithError: () => {},
    }
    registeredHandler.webViewStartURLSchemeTask(null, task)
    expect(Array.from(served!)).toEqual([3, 1, 4, 1, 5])
    expect(finished).toBe(true)
    expect(registry.size).toBe(0) // one-shot freed
  })
})
