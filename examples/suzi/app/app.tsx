import { runCanvasApp } from '@react-three/nativescript'
import { Scene } from './scene'

console.log('[FLATLAND APP] app.tsx top-level evaluation started')
console.log('[FLATLAND APP] About to call runCanvasApp() — preload + GLTF patch are owned by the package')
runCanvasApp(<Scene />, {
  camera: { position: [4, 2.5, 8], fov: 35 },
  page: { backgroundColor: '#daa520' },
  // Native FPS + renderer info overlay (top-left, dev-only, dead-code-eliminated in release).
  // This was part of the original polished demo state — the package's createStatsOverlay
  // (native Label, safe-area aware, samples renderer.info) is still fully intact.
  stats: true,
  onError: (err: any) => {
    // Safe logging: the error passed here can contain React fiber nodes / ErrorBoundary instances
    // with circular _reactInternals on some paths (especially Android + dev). Never let it hit
    // a naive console.error or JSON.stringify.
    console.error('[r3f]', err?.message || err)
    if (err?.stack) console.error(err.stack)
  },
})
