# react-three-nativescript starter

A minimal NativeScript app that renders a three.js scene as React, through `@react-three/nativescript`. One lit mesh you can orbit, with the WebGPU renderer, the GLTF/decoder polyfills, and the worker pipeline already wired.

## Scaffold it

```bash
ns create my-app --template ./template
cd my-app
ns run ios      # or: ns run android
```

## What you write

`app/scene.tsx` is your scene. `app/app.tsx` boots it:

```tsx
import { runThreeFiberApp } from '@react-three/nativescript'
import { Scene } from './scene'

runThreeFiberApp(<Scene />, {
  camera: { position: [0, 0, 4], fov: 45 },
  page: { backgroundColor: '#15161a' },
})
```

Add a compressed `.glb` to `app/assets` and load it with `useGLTF('~/assets/your-model.glb')`. DRACO, KTX2, and meshopt decode for you, native worker on Android, WKWebView wasm bridge on iOS. No config.

## The one piece of wiring

`webpack.config.js` chains the NativeScript preset with the react-three one:

```js
const webpack = require('@nativescript/webpack')
const reactThree = require('@react-three/nativescript/webpack')
module.exports = (env) => {
  webpack.init(env)
  reactThree(webpack, { workers: true })
  return webpack.resolveConfig()
}
```

`workers: true` is what reroutes the decoders and copies their wasm into the bundle. Leave it on.
