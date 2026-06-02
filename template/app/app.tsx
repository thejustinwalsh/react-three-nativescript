import { runThreeFiberApp } from '@react-three/nativescript'
import { Scene } from './scene'

// Boot a fullscreen r3f canvas. runThreeFiberApp owns the WebGPU renderer setup, the GLTF/decoder
// polyfills, and the NativeScript page/layout — you write three.js.
runThreeFiberApp(<Scene />, {
  camera: { position: [0, 0, 4], fov: 45 },
  page: { backgroundColor: '#15161a' },
})
