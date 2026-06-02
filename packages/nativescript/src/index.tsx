import './polyfills'

//* Re-exports ==============================
// The WebGPU entry, so r3f always uses the WebGPURenderer (it runs on a WebGL2 backend when
// WebGPU isn't viable). Then the NS bootstrap on top; createRoot/Canvas override core's.
export * from '@react-three/fiber/webgpu'

export { Canvas, createRoot, type CanvasProps, type Root } from './Canvas'
export { createCanvasPage, runCanvasApp, type CanvasAppProps, type PageOptions, type StatsOptions } from './app'
export { events } from './events'
// The generic wasm-worker primitive (runs a worker in the WKWebView on iOS). Public because the
// loader's reroute injects `import { createWasmWorker } from '@react-three/nativescript'`, and apps
// can use it directly. preloadWasmHost warms the host at boot.
export { createWasmWorker, preloadWasmHost, type WorkerLike } from './wasm/webview-worker'

// Re-export for advanced/low-level use only (e.g. when you call the raw Canvas(view) API
// directly on a ready event instead of using runCanvasApp/createCanvasPage).
// The high-level APIs (runCanvasApp, createCanvasPage) + polyfills side-effects now fully
// own preloadWasmHost + patchGLTFLoader timing so normal usage requires zero ceremony.
export { patchGLTFLoader } from './polyfills'
