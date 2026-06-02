/**
 * Temporary diagnostic component for Android rendering issues.
 *
 * HOW TO USE FOR DEBUGGING:
 * 1. Import in app/scene.tsx:  import { AndroidRenderDebug } from './ANDROID_RENDER_DEBUG'
 * 2. Drop <AndroidRenderDebug /> anywhere inside the <Scene> return (e.g. at the end).
 * 3. Run on your Android device: npx ns run android --device
 * 4. Watch the JS console output (and adb logcat if needed). It prints with [ANDROID_RENDER_DEBUG] prefix.
 *
 * What to look for and report back:
 * - "actual context attributes" JSON  →  does "alpha" come back as true even though we asked for false?
 * - ALPHA_BITS value (0 = good for opaque, 8 = we have alpha channel)
 * - isWebGLBackend vs isWebGPUBackend
 * - Whether view.getContext('webgl2')?.flush exists on your device
 * - The getClearColor value vs your goldenrod background
 *
 * Once we have this data from your device we can decide if the alpha theory, the present/noop theory,
 * or something else is the real cause.
 */

import { useEffect } from 'react'
import { useThree } from '@react-three/nativescript'

export function AndroidRenderDebug() {
  const gl = useThree((s) => s.gl) as any
  const size = useThree((s) => s.size)
  const scene = useThree((s) => s.scene)

  const runDiagnostic = (label: string) => {
    const out: string[] = []
    out.push(`\n========== [ANDROID_RENDER_DEBUG] ${label} ==========`)

    // === Backend detection (from three WebGPURenderer) ===
    const backend = gl?.backend
    out.push(`backend exists: ${!!backend}`)
    out.push(`backend.isWebGLBackend: ${backend?.isWebGLBackend}`)
    out.push(`backend.isWebGPUBackend: ${backend?.isWebGPUBackend}`)
    out.push(`backend.constructor.name: ${backend?.constructor?.name}`)

    // === The real question: what attributes did the actual GL context get? ===
    // We try several ways to reach the underlying WebGL2RenderingContext
    let realGl: WebGL2RenderingContext | null = null

    if (backend?.gl) {
      realGl = backend.gl
      out.push('Found realGl via backend.gl')
    } else if (gl?.domElement?.getContext) {
      // The canvas the renderer was given
      try {
        realGl = gl.domElement.getContext('webgl2') || gl.domElement.getContext('webgl')
        if (realGl) out.push('Found realGl via gl.domElement.getContext')
      } catch (e) {
        out.push(`getContext attempt failed: ${e}`)
      }
    }

    // Fallbacks for different three internal structures
    if (!realGl && (gl as any)._gl) realGl = (gl as any)._gl
    if (!realGl && backend?._gl) realGl = backend._gl

    if (realGl && typeof realGl.getContextAttributes === 'function') {
      const attrs = realGl.getContextAttributes()
      out.push(`>>> ACTUAL CONTEXT ATTRIBUTES: ${JSON.stringify(attrs)}`)
      out.push(`>>> ALPHA_BITS: ${realGl.getParameter(realGl.ALPHA_BITS)}`)
      out.push(`>>> DEPTH_BITS: ${realGl.getParameter(realGl.DEPTH_BITS)}`)
      out.push(`>>> STENCIL_BITS: ${realGl.getParameter(realGl.STENCIL_BITS)}`)
      out.push(`>>> SAMPLES (MSAA): ${realGl.getParameter(realGl.SAMPLES) || 0}`)
      out.push(`>>> Drawing buffer size: ${realGl.drawingBufferWidth} x ${realGl.drawingBufferHeight}`)
    } else {
      out.push('!!! Could NOT obtain the real underlying WebGL context for inspection')
    }

    // === What does three think the clear color is? ===
    try {
      const cc = { r: 0, g: 0, b: 0, a: 1 }
      if (typeof gl?.getClearColor === 'function') {
        gl.getClearColor(cc as any)
      } else if (backend?.getClearColor) {
        const c = backend.getClearColor()
        cc.r = c.r
        cc.g = c.g
        cc.b = c.b
        cc.a = c.a ?? 1
      }
      out.push(
        `renderer clearColor: rgba(${cc.r.toFixed(3)}, ${cc.g.toFixed(3)}, ${cc.b.toFixed(3)}, ${cc.a.toFixed(3)})`,
      )
    } catch (e: any) {
      out.push(`getClearColor error: ${e?.message || e}`)
    }

    // === Scene background from your app.tsx config ===
    // scene.background can be Color | Texture | CubeTexture | null
    const bg = scene?.background as any
    if (bg?.isColor === true) {
      out.push(
        `scene.background (Color): #${typeof bg.getHexString === 'function' ? bg.getHexString() : (bg.getHex?.() ?? '??')}`,
      )
    } else if (bg) {
      out.push(`scene.background: ${bg.type || bg.constructor?.name || typeof bg}`)
    } else {
      out.push(`scene.background: null/undefined`)
    }

    // === autoClear state (r3f usually sets this) ===
    out.push(
      `gl.autoClear=${gl?.autoClear} color=${gl?.autoClearColor} depth=${gl?.autoClearDepth} stencil=${gl?.autoClearStencil}`,
    )

    // === r3f logical size vs drawing buffer ===
    out.push(`r3f size: ${size.width} x ${size.height}`)

    // === What would createPresent() decide right now? (important for Android) ===
    const canvas = gl?.domElement
    if (canvas?.getContext) {
      const wgl2 = canvas.getContext('webgl2')
      out.push(`canvas.getContext('webgl2')?.flush is function: ${typeof wgl2?.flush === 'function'}`)
      const wgpu = canvas.getContext('webgpu')
      out.push(`canvas.getContext('webgpu')?.presentSurface is function: ${typeof wgpu?.presentSurface === 'function'}`)
    }

    out.push('============================================================\n')

    // Print to console so it appears in the NS Android logs
    console.warn(out.join('\n'))
    // Also try to surface in some environments
    if (typeof (global as any).__nsLog === 'function') {
      ;(global as any).__nsLog(out.join(' | '))
    }
  }

  useEffect(() => {
    // Give the renderer, backend, and first frame time to settle
    const t = setTimeout(() => {
      runDiagnostic('FIRST RUN (after mount + 1200ms)')
    }, 1200)
    return () => clearTimeout(t)
  }, [])

  // You can also force another run by remounting the component if needed
  return null
}
