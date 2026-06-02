# CLAUDE.md

Guidance for working in `@react-three/nativescript`. See the root `CLAUDE.md` for monorepo
commands and code style.

## Overview

NativeScript platform target for r3f, alongside web (`@react-three/fiber`) and React Native
(`@react-three/native`). It backs r3f with [`@nativescript/canvas`](https://github.com/NativeScript/canvas)
so scenes render on iOS/Android, always on three's **WebGPURenderer**. The reconciler and core are
platform-neutral and untouched — only the bootstrap here is NativeScript-specific, and it is built
**entirely on public r3f and NativeScript APIs** (no reconciler internals). Keep it that way: the
one previous internal dependency, r3f's `ErrorBoundary`, was replaced with our own.

## Architecture

### Imperative bootstrap, not a `<Canvas>` host element

`react-nativescript` (the only React renderer for NS views) is React 18 / `react-reconciler@0.29`
and unmaintained; r3f v10 needs React 19, and two reconcilers can't share one React instance. So
the API is imperative — `Canvas(view, props).render(<scene/>)` runs only r3f's own reconciler. The
host app places a `@nativescript/canvas` Canvas and hands it over on its `ready` event.

### WebGPURenderer via a renderer FACTORY — the critical fix

We import from `@react-three/fiber/webgpu` (WebGPURenderer always; WebGL2 backend fallback, the
Safari behavior). We pass r3f a **renderer factory** (`renderer:` accepts a function;
`resolveRenderer` calls it) rather than options, for one reason:

r3f calls `renderer.setSize(w, h, updateStyle)`. On NS the canvas is `instanceof HTMLCanvasElement`
(the polyfill's `Symbol.hasInstance`), so `updateStyle` resolves `true` and three writes
`canvas.style.width = w + 'px'`. **NativeScript interprets CSS `px` as DEVICE pixels**, so `"402px"`
becomes `402 / dpr` DIPs and shrinks the fullscreen view to ~1/dpr of the screen. The factory's
`setSize` drops `updateStyle`, so three only ever resizes the drawing buffer, never the layout
style. The factory also defaults `alpha: false` (opaque surface; avoids the NS-iOS
`alphaMode premultiplied` fallback warning), overridable via the `renderer` prop.

### Fullscreen sizing — surface vs view

Two independent sizes, do not conflate them (this caused a long debugging saga):

- **Surface / drawing buffer** = `canvas.width/height`, device pixels. We own this: `clientWidth * dpr`.
  NS defaults it to 300×150 and never syncs it — set it explicitly.
- **View / layout size** = the on-screen frame. The host layout owns this. The NS canvas **hijacks
  its `width`/`height` properties for the surface**, so the layout size can only be set through the
  CSS parser: `view.setInlineStyle('width:100%; height:100%')`. A plain `style.width =` string
  assignment is _ignored_ (it never sets `effectiveWidth`), and the view falls back to the hijacked
  surface width → the ~1/dpr² tiny box.

The fullscreen recipe (what `createCanvasPage` builds): `Frame → Page → GridLayout → Canvas`, the
Page with `actionBarHidden` + `iosIgnoreSafeArea` (the Page always insets content by the safe area
otherwise — `iosOverflowSafeArea` on the content does not defeat it), the Canvas filling the grid
via `setInlineStyle('100%')`. A bare `Application.run({ create })` Page mis-measures; the **Frame**
is the ContainerView NS sizes to `UIScreen.bounds`.

### Present, events, rotation

- **Present**: `createPresent` picks `context.presentSurface()` (WebGPU backend) or `view.flush()`
  (WebGL). We wrap `gl.render` to present each frame.
- **Events** (`events.ts`): NS dispatches real multi-touch `PointerEvent`s (distinct `pointerId`),
  so OrbitControls/pinch work directly — no PanResponder bridge (unlike RN). We override `compute`
  only to populate `offsetX/offsetY` (NS omits them) and normalize `clientX / size.width` — **no
  dpr factor** (clientX and `size` are both logical points). NS never fires `'click'`, so we
  synthesize one on a stationary pointerup via `view.notify({ eventName: 'click', ... })`.
- **Rotation**: `Application.orientationChangedEvent` → `setSize` from `Screen.mainScreen` (stable,
  swaps on rotate — never the surface-perturbed `clientWidth`). Safe because the factory keeps r3f
  off the layout style, so setting the surface can't shrink the view.

### Polyfills

`@nativescript/canvas-polyfill` installs the web surface three's loaders need (XHR, fetch, Blob,
TextDecoder, `createObjectURL`, document, window, navigator). `src/polyfills.ts` adds only
`global.THREE`. Do **not** depend on `@nativescript/canvas-three` — it just pins a second `three`,
breaking `instanceof`. `@nativescript/audio-context` is a dependency purely to silence a
canvas-polyfill resolve warning.

## Build tooling (ships with the package)

- `webpack.cjs` (`@react-three/nativescript/webpack`) — preset: react flavor, drop the
  `react-dom → react-nativescript` alias, `exportsPresence: 'warn'` (drei alpha references classes
  three/webgpu doesn't re-export), and the worker loader when `workers: true`.
- `ns-worker-loader.cjs` — Babel-AST loader. Rewrites inline blob-URL workers
  (`new Worker(URL.createObjectURL(new Blob([...])))`, incl. the decoupled and `this.member` forms)
  into on-disk workers via `emitFile('assets/workers/…')` (where `~/` resolves), prepends
  `var self = globalThis;`, and inlines local `importScripts`. **Config-driven** for runtime-fetched
  decoders: `substitutions: [{ test, vars: { <var>: <file> }, stubCalls: [<method>] }]` inlines a
  file in place of a runtime variable and stubs the fetch. The DRACO default inlines the **JS**
  decoder (not wasm — NS wasm is unverified) and stubs `_loadLibrary`, so DRACO needs nothing app-side.

## Constraints

- **No changes to `packages/fiber`** core/reconciler, and **no r3f internals** — public exports only.
- drei: import from `@react-three/drei/webgpu`; its alpha needs the `WebGLCubeRenderTarget →
CubeRenderTarget` patch (patch-package) until fixed upstream.
- three peer `>=0.183.2` (WebGPURenderer floor).
- Tests: vitest + jsdom under the root config; GL mocked via test-renderer's
  `WebGL2RenderingContext`; `@nativescript/*` aliased to `tests/stubs/`. The worker loader has its
  own suite (`tests/worker-loader.test.ts`) driving the CJS loader with a fake context.

## Files

| File                   | Purpose                                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| `src/Canvas.tsx`       | `Canvas`/`createRoot` bootstrap: surface sizing, renderer factory, present, click synth, rotation. |
| `src/app.tsx`          | `runCanvasApp` / `createCanvasPage` — the fullscreen page stack + page options.                    |
| `src/events.ts`        | Pointer-event manager: offset population + correct normalization.                                  |
| `src/index.tsx`        | Re-exports `@react-three/fiber/webgpu`, then the NS bootstrap + helpers.                           |
| `src/polyfills.ts`     | Imports canvas-polyfill; binds `global.THREE`.                                                     |
| `webpack.cjs`          | `@react-three/nativescript/webpack` preset.                                                        |
| `ns-worker-loader.cjs` | Babel worker loader.                                                                               |
