// Test stub for @nativescript/canvas/helpers. The real module initializes the native canvas bridge
// (Android); under jsdom there's nothing to initialize, and polyfills.ts only calls
// Helpers.initialize() when isAndroid is true (false in the stubbed core), so a no-op suffices.
export const Helpers = { initialize() {} }
