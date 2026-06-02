/**
 * Vitest setup for the @react-three/nativescript suite.
 *
 * Adapted from react-three-fiber's fiber test setup, trimmed to what the NativeScript Canvas test
 * needs under jsdom: a React act flag, WebGL context mocks, a ResizeObserver/PointerEvent polyfill,
 * and an import.meta.hot stand-in for the scheduler's HMR code.
 */
import { WebGL2RenderingContext } from './helpers/WebGL2RenderingContext'
import { vi } from 'vitest'

// react-use-measure (a fiber dependency) reads layout that jsdom doesn't compute.
vi.mock('react-use-measure', () => ({
  default: vi.fn(() => [() => {}, { width: 1280, height: 800, top: 0, left: 0, bottom: 800, right: 1280, x: 0, y: 0 }]),
}))

// The scheduler reads import.meta.hot for HMR; unbuild rewrites it to import_meta_hot at build time.
// @ts-ignore
globalThis.import_meta_hot = undefined

// @ts-ignore — let React know we're testing effectful components.
globalThis.IS_REACT_ACT_ENVIRONMENT = true

// polyfills.ts publishes `global.THREE ??= THREE` and then extends it (a GLTFLoader assignment
// interceptor). The bundled NativeScript runtime hands it an extensible THREE; native ESM hands a
// frozen module namespace. Pre-seed an extensible stand-in so the `??=` keeps it and the interceptor
// can attach. (This test asserts Canvas sizing; the THREE namespace itself isn't under test.)
// @ts-ignore
globalThis.THREE = {}

// three.cjs / three.core.js load as separate instances under vitest; silence the dedupe warning
// (bundlers deduplicate in production).
const originalWarn = console.warn
console.warn = (...args: any[]) => {
  if (typeof args[0] === 'string' && args[0].includes('Multiple instances of Three.js')) return
  originalWarn.apply(console, args)
}

globalThis.WebGL2RenderingContext = WebGL2RenderingContext as any
globalThis.WebGLRenderingContext = class WebGLRenderingContext extends WebGL2RenderingContext {} as any

HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
  return new WebGL2RenderingContext(this) as any
}

globalThis.ResizeObserver = class ResizeObserver {
  callback: ResizeObserverCallback
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
  }
  observe(element: HTMLElement) {
    const rect = element.getBoundingClientRect()
    this.callback(
      [
        {
          target: element,
          contentRect: rect,
          borderBoxSize: [{ inlineSize: rect.width, blockSize: rect.height }],
          contentBoxSize: [{ inlineSize: rect.width, blockSize: rect.height }],
          devicePixelContentBoxSize: [{ inlineSize: rect.width, blockSize: rect.height }],
        },
      ],
      this,
    )
  }
  unobserve() {}
  disconnect() {}
} as any

// jsdom ships no PointerEvent.
if (!global.PointerEvent) {
  // @ts-ignore
  global.PointerEvent = class PointerEvent extends MouseEvent {
    readonly pointerId: number = 0
    readonly width: number = 1
    readonly height: number = 1
    readonly pressure: number = 0
    readonly tangentialPressure: number = 0
    readonly tiltX: number = 0
    readonly tiltY: number = 0
    readonly twist: number = 0
    readonly pointerType: string = ''
    readonly isPrimary: boolean = false
    readonly altitudeAngle: number = 0
    readonly azimuthAngle: number = 0

    constructor(type: string, params: PointerEventInit = {}) {
      super(type, params)
      Object.assign(this, params)
    }

    getCoalescedEvents = () => []
    getPredictedEvents = () => []
  }
}

// Give canvases a non-zero box so rays have something to hit.
Object.defineProperties(HTMLCanvasElement.prototype, {
  getBoundingClientRect: {
    value: () => ({ width: 1280, height: 800, top: 0, left: 0, bottom: 800, right: 1280, x: 0, y: 0 }),
  },
  width: { get: () => 1280, set: () => {} },
  height: { get: () => 800, set: () => {} },
  clientWidth: { get: () => 1280 },
  clientHeight: { get: () => 800 },
})

export {}
