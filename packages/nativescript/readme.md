# @react-three/nativescript

[react-three-fiber](https://github.com/pmndrs/react-three-fiber) for [NativeScript](https://nativescript.org/) — render declarative Three.js on iOS and Android, on the WebGPU renderer, backed by [`@nativescript/canvas`](https://github.com/NativeScript/canvas).

It is the NativeScript sibling of `@react-three/fiber` (web) and `@react-three/native` (React Native). The reconciler and core are platform-neutral and untouched; only the bootstrap here is NativeScript-specific, and it uses public r3f and NativeScript APIs throughout.

```tsx
import { runThreeFiberApp } from '@react-three/nativescript'

function Box() {
  return (
    <mesh>
      <boxGeometry />
      <meshStandardMaterial color="orange" />
    </mesh>
  )
}

runThreeFiberApp(
  <>
    <ambientLight intensity={Math.PI / 2} />
    <Box />
  </>,
  { camera: { position: [0, 0, 5] } },
)
```

## Install

```sh
npm install @react-three/nativescript @react-three/fiber@alpha three react
npm install @nativescript/canvas @nativescript/core
```

Peers: `react@19`, `three >=0.183.2`, `@react-three/fiber >=10.0.0-alpha`, `@nativescript/canvas >=2`, `@nativescript/core >=8.3.5`.

The package always renders with three's **WebGPURenderer** (imported from `@react-three/fiber/webgpu`). On a device without WebGPU it runs on the WebGL2 backend automatically — the same path Safari takes.

## Webpack setup (required)

Apply the package's preset in your `webpack.config.js`:

```js
const webpack = require('@nativescript/webpack')
const reactThree = require('@react-three/nativescript/webpack')

module.exports = (env) => {
  webpack.init(env)
  reactThree(webpack, { workers: true }) // workers: optional, see "Compressed assets"
  return webpack.resolveConfig()
}
```

It applies the NativeScript **react flavor** (`.tsx` + JSX), drops the `react-dom → react-nativescript` alias (we render through r3f's own React 19 reconciler), and downgrades drei's missing-export warnings so the WebGPU bundle builds. Options: `{ reactFlavor, dropReactDomAlias, exportsPresence, workers }`.

## API

### `runThreeFiberApp(element, props?)`

Boots a single-screen app whose root is a fullscreen r3f canvas (`Frame → Page → GridLayout → Canvas`). `props` are the usual r3f render props (`camera`, `shadows`, `gl`/`renderer`, `scene`, `onCreated`, `onError`) plus a `page` object:

```ts
runThreeFiberApp(<Scene />, {
  shadows: true,
  camera: { position: [4, 2.5, 8], fov: 35 },
  page: {
    actionBarHidden: true,   // default true
    fullscreen: true,        // default true — edge-to-edge under the notch/home indicator
    backgroundColor: '#daa520',
    configure: (page) => {}, // escape hatch for orientation, gestures, native status-bar APIs
  },
})
```

> Status bar visibility is an `Info.plist` concern (`UIStatusBarHidden`); `fullscreen` controls whether the canvas draws underneath it.

### `createCanvasPage(element, props?)`

Returns a configured `Page` instead of running the app — use it when the canvas is one screen among several in your own `Frame`.

### `Canvas(view, props)` / `createRoot(view, props)`

The low-level bootstrap. Given a `@nativescript/canvas` `Canvas` (from its `ready` event), returns `{ render, unmount }`. `runThreeFiberApp` is built on this; reach for it when you build the page/layout yourself.

```tsx
canvas.on('ready', (args) => {
  Canvas(args.object, { camera: { position: [0, 0, 5] } }).render(<Scene />)
})
```

It is a **call, not a `<Canvas>` host element** — NativeScript has no React view renderer for R19 to mount one into.

## Assets

Bundle assets under `app/assets/` (NativeScript copies `assets/**`) and load them with the `~/` app-folder URL — three's loaders read them off disk via NativeScript's native XHR:

```tsx
useGLTF('~/assets/model.glb')
<Environment files="~/assets/venice_sunset_1k.hdr" />
```

## Compressed assets (workers)

three's `DRACOLoader`/`KTX2Loader` create Web Workers from blob URLs, which NativeScript's file-based worker runtime can't load. With `workers: true` the package's **ns-worker-loader** rewrites those into on-disk NativeScript workers at build time.

For DRACO it goes further: it inlines three's **JS (asm.js) decoder** into the worker and stubs the loader's main-thread decoder fetch — so a draco-compressed model loads through a plain `useGLTF('~/assets/model.glb')` with **no decoder files to bundle and no `setDecoderPath`/`setDecoderConfig`**. (The JS decoder avoids the question of whether NativeScript runs wasm; jitless V8's wasm support is unverified.)

Configure additional worker-using loaders with `reactThree(webpack, { workers: { substitutions: [{ test, vars, stubCalls }] } })`.

## drei

Import drei components from `@react-three/drei/webgpu` (the WebGPU build), matching this package's renderer. drei's alpha references `WebGLCubeRenderTarget`, which three's WebGPU build renamed to `CubeRenderTarget`; until that's fixed upstream, alias the import with [patch-package](https://www.npmjs.com/package/patch-package).

## License

MIT
