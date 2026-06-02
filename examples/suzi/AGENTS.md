# AGENTS.md

## Project overview

NativeScript + React Three Fiber demo (the "Flatland" project). Renders a 3D scene with the Suzi model, OrbitControls, contact shadows, and an HDR environment — all inside NativeScript's `runCanvasApp`. Entry: `app/app.tsx`.

## Commands

```bash
# Install deps (runs patch-package postinstall)
npm install

# If using pnpm, postinstall can be unreliable. After `pnpm install`, run:
# pnpm patch
# or
# npx patch-package

# Build & run on iOS device/simulator
npx ns run ios --device

# Build & run on Android emulator/device
npx ns run android --emulator  # or --device

# Rebuild without cache
npx ns clean && npx ns run ios --clean
```

No `start`/`serve` script — the CLI is via `ns`.

## Key quirks

- **Webpack**: Custom in `webpack.config.js`. It chains `@react-three/nativescript/webpack`, which handles: react flavor, `react-dom` alias drop for drei's missing exports, and converting inline blob-worker URLs to on-disk NS worker files. Do not remove or reorder — breaking this chain breaks loading.

- **`preloadWasmHost()` in app.tsx**: Warms the shared WKWebView wasm host at boot so meshopt decode is fast. Calling it before `runCanvasApp` is required for perf.

- **Three.js version pin**: `three@0.183.2`, `@react-three/fiber@10.0.0-alpha.2`, `@react-three/nativescript` from a local `.tgz`. These are tightly coupled — don't upgrade one without checking the others.

- **`@react-three/nativescript` source**: The package is at `~/Developer/react-three-fiber/packages/nativescript/`. To install it locally, run:

  ```bash
  cd ~/Developer/react-three-fiber/packages/nativescript && npm pack
  # copies react-three-nativescript-<version>.tgz to this repo's root
  npm install ./react-three-nativescript-*.tgz
  ```

  The `package.json` currently pins via `"file:../react-three-fiber/packages/nativescript/react-three-nativescript-10.0.0-alpha.2.tgz"`. Don't run `npm pack` on the wrong branch.

- **drei/WebGPU path**: `scene.tsx` imports `from '@react-three/drei/webgpu'`, not `'@react-three/drei'`. Use the WebGPU variant; the default export may lack needed features on NS.

- **`references.d.ts`**: Only line: `<reference path="./node_modules/@nativescript/types/index.d.ts" />`. If `tsc` errors about missing types, check this file exists and points to the right `@nativescript/core` version.

## Source layout

| Path                     | Purpose                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------- |
| `app/app.tsx`            | Entry — initializes canvas app with camera, shadows, background color              |
| `app/scene.tsx`          | All scene components: Suzi model loader, spheres, OrbitControls, responsive camera |
| `app/assets/`            | HDR environment file (`venice_sunset_1k.hdr`) and GLB model (`suzi-meshopt.glb`)   |
| `webpack.config.js`      | Webpack setup — do not edit without understanding reactThree() side effects        |
| `nativescript.config.ts` | App ID, paths, Android v8 flags (gc + marking mode)                                |
