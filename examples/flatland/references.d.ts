/// <reference path="./node_modules/@nativescript/types/index.d.ts" />
/// <reference path="./node_modules/@nativescript/core/global-types.d.ts" />

// Build-time constants injected by NativeScript / Webpack
// These must be declared via global augmentation for modern TS + bundler setups.
declare global {
  var __ANDROID__: boolean
  var __IOS__: boolean
  var __VISIONOS__: boolean
  var __APPLE__: boolean
  var __DEV__: boolean
}

export {}
