// Explicit side-effect dependency: the early Android bootstrap + canvas polyfill
// must run before any Canvas or three.js code. Importing this module guarantees it.
import { debug } from './debug'
import './polyfills'
import { patchGLTFLoader } from './polyfills'
import { preloadWasmHost } from './wasm/webview-worker'

import { Application, Color, Frame, GridLayout, Page, Utils, isAndroid } from '@nativescript/core'
import { Canvas as NativeCanvas } from '@nativescript/canvas'
import { Canvas } from './Canvas'
import { createStatsOverlay } from './stats'

//* Type Imports ==============================
import type { EventData } from '@nativescript/core'
import type { ReactNode } from 'react'
import type { CanvasProps } from './Canvas'
import type { StatsOptions } from './stats'

// Injected by the NativeScript webpack DefinePlugin (`__DEV__: mode === 'development'`). The `typeof`
// guard keeps it safe under rollup (package build) and vitest, where it isn't defined; in a release
// build it folds to `false` so the stats overlay (and its module) are dead-code-eliminated.
declare const __DEV__: boolean

export interface PageOptions {
  /** Hide the ActionBar. Default `true`. */
  actionBarHidden?: boolean
  /**
   * Extend content edge-to-edge under the iOS safe area (notch / home indicator). Default `true`.
   * Hiding the status bar *overlay* itself is an Info.plist concern (`UIStatusBarHidden`); this
   * controls whether the canvas draws underneath it.
   */
  fullscreen?: boolean
  /** Page (and backing grid) background, shown before the scene renders. */
  backgroundColor?: string
  /** Escape hatch to configure the Page directly — orientation, gestures, native status-bar APIs. */
  configure?: (page: Page) => void
}

export interface CanvasAppProps extends CanvasProps {
  /** NativeScript page/layout options. Sensible fullscreen defaults; override as needed. */
  page?: PageOptions
  /**
   * Show a native FPS / frame-time overlay (top-left). `true` for defaults, or pass {@link StatsOptions}.
   * Dev-only: it is stripped from release builds, so it's safe to leave on. Renders as a true overlay
   * (never resizes the canvas) and passes touches through.
   */
  stats?: boolean | StatsOptions
}

export type { StatsOptions }

//* App Helpers ==============================

// Build a NativeScript Page hosting a fullscreen r3f canvas. This folds in the host-app boilerplate
// the docs require: a GridLayout-filled Canvas (style 100% via the CSS parser so the view — whose
// `width` is hijacked to the surface — actually fills its cell) and the Page safe-area handling for
// true edge-to-edge. A host that wants its own page structure can skip this and call Canvas()
// directly on a `ready` event.
export function createCanvasPage(element: ReactNode, props: CanvasAppProps = {}): Page {
  const { page: pageOptions = {}, stats, ...canvasProps } = props
  const { actionBarHidden = true, fullscreen = true, backgroundColor, configure } = pageOptions

  // The high-level entry points fully own the required iOS/Android bootstrap ordering:
  // - preloadWasmHost() warms the shared WKWebView wasm host on iOS (no-op elsewhere).
  //   This must precede any meshopt decode that will use the bridged decoder.
  // - patchGLTFLoader() installs the prototype override so drei's useGLTF (and raw GLTFLoader
  //   + meshopt .glb files) get our platform-aware decoder instead of the stock one.
  //
  // Doing both here (synchronously, at the very start of page creation) means apps can simply
  // call runThreeFiberApp(<Scene/>) or createCanvasPage(...) with zero ceremony. The polyfills
  // side-effect + global THREE.GLTFLoader interceptor already did a best-effort early attempt
  // at import time; this guarantees the correct post-preload timing right before any React
  // rendering (and thus any GLTF loads) can start.
  debug('[R3FNS] createCanvasPage: auto-calling preloadWasmHost() + patchGLTFLoader()')
  preloadWasmHost()
  patchGLTFLoader()

  const page = new Page()
  page.actionBarHidden = actionBarHidden
  if (backgroundColor) page.backgroundColor = new Color(backgroundColor)

  // Original tuned fullscreen logic the user spent time on.
  // - Android: call Utils.android.enableEdgeToEdge() early for proper edge-to-edge (no system bars chrome).
  // - iOS: set iosOverflowSafeArea inside 'loaded' so it takes effect after the native view is created.
  if (fullscreen) {
    // Gate on isAndroid BEFORE touching Utils.android: @nativescript/core 9.0+ makes the
    // `Utils.android` getter throw on iOS unless the platform is checked first. isAndroid is a plain
    // boolean (safe on any platform), so this short-circuits on iOS and never reads the getter.
    if (isAndroid && Utils.android) {
      // enableEdgeToEdge is the modern recommended call for true edge-to-edge on Android 11+.
      // It may not be in the .d.ts of the current @nativescript/core version, so we cast defensively.
      ;(Utils.android as any).enableEdgeToEdge?.()
    }

    page.on('loaded', (args: EventData) => {
      const p = args.object as Page
      p.iosOverflowSafeArea = true
    })
  }

  const grid = new GridLayout()
  if (backgroundColor)
    grid.backgroundColor = new Color(backgroundColor)

    // Restoring the user's original fullscreen canvas layout approach (the version they
    // spent a day tuning): a plain GridLayout containing a single canvas that is told to
    // fill the entire available space via 100% style + explicit stretch alignment.
    // Goal: true edge-to-edge, no room for any headers/footers/safe area chrome.
    // The star/ItemSpec approach was added later and is being removed per user feedback.
  ;(grid as any).setInlineStyle('width: 100%; height: 100%;')
  const view = new NativeCanvas()
  ;(view as unknown as { setInlineStyle(css: string): void }).setInlineStyle('width: 100%; height: 100%;')

  // These alignments + the 100% style on the child are part of the tuned logic for
  // making the canvas occupy the full viewport on iOS without gaps at the bottom.
  view.horizontalAlignment = 'stretch'
  view.verticalAlignment = 'stretch'

  view.on('ready', (args: EventData) => {
    // Defensive re-patch right before we hand control to r3f and user scene code can run.
    // The call at the top of createCanvasPage already did the authoritative preload+patch,
    // but this covers any exotic code paths that reach a ready handler without going through
    // the high-level create/run functions, and the __nsMeshopt guard makes it a no-op if
    // already applied.
    patchGLTFLoader()
    Canvas(args.object as NativeCanvas, canvasProps).render(element)
  })

  grid.addChild(view)

  // Native stats overlay, dev-only (the __DEV__ guard strips it + the stats module from release
  // builds). Added to the same single grid cell AFTER the canvas: GridLayout children overlap by
  // z-order, so it floats top-left over the canvas without resizing it, and its sampler rides the
  // per-present hook so it measures the real frame cadence.
  if (typeof __DEV__ !== 'undefined' && __DEV__ && stats) {
    const overlay = createStatsOverlay(typeof stats === 'object' ? stats : {})
    grid.addChild(overlay.view)
    canvasProps.onPresent = overlay.sample
  }

  page.content = grid
  configure?.(page)
  return page
}

// Run a single-screen app whose root is a fullscreen r3f canvas page (Frame → Page → Canvas). The
// Frame is the ContainerView NS sizes to the full screen, so the page lays out edge-to-edge.
export function runThreeFiberApp(element: ReactNode, props?: CanvasAppProps): void {
  Application.run({
    create: () => {
      const frame = new Frame()
      frame.navigate({ create: () => createCanvasPage(element, props) })
      return frame
    },
  })
}
