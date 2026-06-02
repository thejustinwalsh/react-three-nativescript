import { createPointerEvents } from '@react-three/fiber/webgpu'

// NativeScript's Canvas dispatches real PointerEvents.
// On both iOS and Android the native input comes through as pointerType 'touch'.
// We do some defensive normalization here because:
// - offsetX/offsetY are sometimes missing
// - pageX/pageY can be missing on certain NS canvas versions or input paths
// - pointerType can occasionally be inconsistent or missing in edge cases
// This helps OrbitControls and other pointer-based controls behave more consistently
// across iOS and Android.
export function events(store: Parameters<typeof createPointerEvents>[0]) {
  const manager = createPointerEvents(store)

  manager.compute = (event, state) => {
    const e = event as unknown as {
      clientX: number
      clientY: number
      offsetX?: number
      offsetY?: number
      pageX?: number
      pageY?: number
      pointerType?: string
    }

    // Coordinate fallbacks (some NS canvas paths omit these)
    if (e.offsetX == null) e.offsetX = e.clientX
    if (e.offsetY == null) e.offsetY = e.clientY
    if (e.pageX == null) e.pageX = e.clientX
    if (e.pageY == null) e.pageY = e.clientY

    // Normalize pointerType for controls (OrbitControls etc. care about this).
    // Android NS canvas correctly reports 'touch'. iOS historically could be inconsistent
    // (sometimes behaving more like mouse in older WKWebView + canvas paths).
    // We force 'touch' on mobile for consistent OrbitControls / pointer-based controls behavior.
    if (!e.pointerType || e.pointerType === 'mouse') {
      e.pointerType = 'touch'
    }

    state.pointer.set((e.clientX / state.size.width) * 2 - 1, -((e.clientY / state.size.height) * 2 - 1))
    state.raycaster.setFromCamera(state.pointer, state.camera)
  }

  return manager
}
