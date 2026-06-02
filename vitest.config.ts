import { defineConfig } from 'vitest/config'
import * as path from 'node:path'

// Standalone adaptation of react-three-fiber's root vitest config. @react-three/fiber resolves from
// the installed npm package (no local fiber source here); the @nativescript/* modules are aliased to
// test stubs because their real builds use platform-specific native resolution that can't load under
// jsdom.
export default defineConfig({
  resolve: {
    dedupe: ['react', 'react-dom', 'three', 'use-sync-external-store'],
    // Array form, most-specific first: vite alias prefix-matches, so `@nativescript/canvas/helpers`
    // must be redirected before the bare `@nativescript/canvas` rule swallows the subpath.
    alias: [
      {
        find: '@nativescript/canvas/helpers',
        replacement: path.resolve(__dirname, './packages/nativescript/tests/stubs/canvas-helpers.ts'),
      },
      {
        find: '@nativescript/canvas-polyfill',
        replacement: path.resolve(__dirname, './packages/nativescript/tests/stubs/empty.ts'),
      },
      {
        find: '@nativescript/canvas',
        replacement: path.resolve(__dirname, './packages/nativescript/tests/stubs/canvas.ts'),
      },
      {
        find: '@nativescript/core',
        replacement: path.resolve(__dirname, './packages/nativescript/tests/stubs/core.ts'),
      },
    ],
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./packages/nativescript/tests/setup.ts'],
    include: ['packages/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    testTimeout: 30000,
  },
})
