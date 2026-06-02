// Test stub for @nativescript/core (the real module uses platform-specific .ios/.android
// resolution that can't load under jsdom). Only what the bootstrap reads.
export const Screen = { mainScreen: { scale: 2, widthDIPs: 1280, heightDIPs: 800 } }

// Platform flags the bootstrap reads. jsdom is neither — polyfills.ts skips its Android-only
// Helpers.initialize() path when isAndroid is false.
export const isAndroid = false
export const isIOS = false

// File-system stubs for the decoder-redirect hook (polyfills.ts). No decoders folder under jsdom, so
// the hook no-ops.
export const Folder = { exists: () => false, fromPath: () => ({ getEntitiesSync: () => [] }) }
export const knownFolders = { currentApp: () => ({ path: '/app' }) }
export const path = { join: (...parts: string[]) => parts.join('/') }

export const Application = {
  orientationChangedEvent: 'orientationChanged',
  on() {},
  off() {},
  run() {},
}

// Minimal stand-ins for the view classes the app helper constructs (createCanvasPage/runThreeFiberApp).
export class Color {
  constructor(public value: string) {}
}
export class Page {
  actionBarHidden = false
  iosOverflowSafeArea = false
  iosIgnoreSafeArea = false
  backgroundColor?: Color
  content: unknown
}
export class GridLayout {
  backgroundColor?: Color
  addChild() {}
}
export class Label {
  text = ''
  horizontalAlignment?: string
  verticalAlignment?: string
  marginLeft?: number
  marginTop?: number
  isUserInteractionEnabled?: boolean
  on() {}
  setInlineStyle() {}
}
export class Frame {
  navigate() {}
}
