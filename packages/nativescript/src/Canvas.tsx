import { debug, debugWarn } from './debug'
import { Application, Screen, isAndroid } from '@nativescript/core'
import { Component, Suspense } from 'react'
import { createRoot as createReconciler, unmountComponentAtNode } from '@react-three/fiber/webgpu'
import { WebGPURenderer } from 'three/webgpu'
import { events } from './events'

//* Type Imports ==============================
import type { ReactNode } from 'react'
import type { Canvas as NativeCanvas } from '@nativescript/canvas'
import type { RenderProps } from '@react-three/fiber/webgpu'

// The serializable shape forwarded to onError. Deliberately NOT a real Error instance: the raw React
// error (or the boundary) can carry circular fiber references (_reactInternals etc.) that blow up
// JSON.stringify on Android when the host logs it. Plain { message, stack } is safe to log.
export interface SceneError {
  message: string
  stack?: string
}

// A minimal error boundary so a throwing scene reaches `onError` instead of crashing the host app,
// without depending on r3f's internal ErrorBoundary utility.
class ErrorBoundary extends Component<{ set: (error: SceneError) => void; children?: ReactNode }, { error: boolean }> {
  state = { error: false }
  static getDerivedStateFromError() {
    return { error: true }
  }
  componentDidCatch(error: Error) {
    this.props.set({ message: error?.message ?? String(error), stack: error?.stack })
  }
  render() {
    return this.state.error ? null : this.props.children
  }
}

export interface CanvasProps extends Omit<RenderProps<HTMLCanvasElement>, 'size' | 'dpr'> {
  /** Rendered while the scene suspends. A three element or null. */
  fallback?: ReactNode
  /** Called when the scene tree (or renderer setup) fails, instead of crashing the host app. */
  onError?: (error: SceneError) => void
  /** @internal Per-present hook (the stats overlay sampler). Set by createCanvasPage; not for app code. */
  onPresent?: (renderer: object) => void
}

export interface Root {
  render(element: ReactNode): void
  unmount(): void
}

// Max pointer travel (logical px) between down and up to still count as a tap → click.
const CLICK_SLOP = 10

//* Bootstrap ==============================

// Bridge a @nativescript/canvas Canvas (from its `ready` event) into an r3f root. This is the
// NativeScript counterpart to the web `<Canvas>`: same render props (camera, gl, shadows,
// onCreated, …), wrapping children in an error boundary and suspense. It is a call, not a host
// JSX element, because NativeScript has no React view renderer to mount one into.
//
// We hand three the real NS canvas (not a shim): the WebGPU surface is bound to the canvas's
// width/height, so they must be set on the live view. This mirrors @nativescript/canvas-three.
export function Canvas(view: NativeCanvas, props: CanvasProps = {}): Root {
  const { fallback = null, onError, onPresent, ...renderProps } = props

  // Single failure path for both scene throws (via the ErrorBoundary) and async setup/render
  // rejections. Forwards a serializable SceneError; if the host gave no onError, surface it on the
  // console so a renderer-setup failure can't silently leave a blank screen.
  const fail = (err: unknown) => {
    const e: SceneError = {
      message: (err as { message?: string })?.message ?? String(err),
      stack: (err as { stack?: string })?.stack,
    }
    if (onError) onError(e)
    else console.error('[R3FNS] scene/renderer failure:', e.message, e.stack ?? '')
  }

  const screen = Screen.mainScreen
  const dpr = screen.scale

  // We deliberately do NOT set the view's layout size here. The NS canvas measures to whatever
  // spec its parent hands it (onMeasure just echoes the measure spec), so a parent layout that
  // stretches — e.g. the canvas as the single child of a GridLayout — fills the view for us. Setting
  // style.width/height ourselves fights that stretch and mis-resolves (it shrank the view to 1/3).
  // We only own the *surface* (drawing buffer) below; the *view* size is the host layout's job.

  // Logical size = the canvas's laid-out frame in points. `Canvas(view, ...)` runs from the NS
  // canvas 'ready' event, which fires from the first layout pass after the surface exists, so
  // clientWidth/clientHeight are valid here; fall back to the full screen if not. r3f derives
  // camera.aspect from this size, so the camera follows for free.
  const width = view.clientWidth || screen.widthDIPs
  const height = view.clientHeight || screen.heightDIPs

  // Drawing-buffer / WebGPU surface size in physical px. Set both in one tick so NS coalesces them
  // into a single resize. Surface = frame*scale renders the laid-out view at native resolution.
  view.width = Math.floor(width * dpr)
  view.height = Math.floor(height * dpr)

  // WebGPU pre-initialization — Android only.
  //
  // On iOS the original "let three.js create and manage everything" behavior worked
  // perfectly, so we leave that path untouched.
  //
  // On Android with @nativescript/canvas, three's WebGPURenderer was not reliably
  // discovering navigator.gpu (or the native layer wasn't ready), causing silent
  // fallback to a broken WebGL2 path that crashed or hung.
  //
  // This mirrors the minimal manual bootstrap that finally made the official
  // @nativescript/canvas + three demos work on Android.
  let webgpuDevice: any
  let webgpuContext: any

  debug(
    '[R3FNS] Canvas created – isAndroid (from @nativescript/core):',
    isAndroid,
    'navigator.gpu exists:',
    typeof navigator !== 'undefined' && !!(navigator as any).gpu,
  )

  // Manual WebGPU bootstrap whenever navigator.gpu is present (the important part
  // for making three.js actually use the real backend on Android).
  // We still log the official isAndroid value for diagnostics.
  const webgpuSetup =
    typeof navigator !== 'undefined' && (navigator as any).gpu
      ? (async () => {
          debug('[R3FNS] navigator.gpu present – starting requestAdapter...')
          try {
            const gpu = (navigator as any).gpu
            const adapter = await gpu.requestAdapter()
            debug('[R3FNS] requestAdapter result:', !!adapter)
            if (adapter) {
              webgpuDevice = await adapter.requestDevice()
              webgpuContext = view.getContext('webgpu')
              debug('[R3FNS] WebGPU device + context acquired successfully')
            } else {
              debugWarn('[R3FNS] navigator.gpu.requestAdapter returned null')
            }
          } catch (err) {
            debugWarn('[R3FNS] WebGPU pre-init failed:', err)
          }
        })()
      : Promise.resolve()

  const root = createReconciler(view as unknown as HTMLCanvasElement)

  let setSize: ((w: number, h: number) => void) | undefined

  // r3f sizes the renderer with renderer.setSize(w, h, updateStyle). On NativeScript the canvas is
  // instanceof HTMLCanvasElement (the polyfill's Symbol.hasInstance), so updateStyle resolves true
  // and three writes canvas.style.width = w + 'px'. NativeScript reads CSS px as DEVICE pixels, so
  // "402px" becomes 402/dpr DIPs and shrinks the fullscreen view to ~1/dpr of the screen. We pass a
  // renderer FACTORY (r3f's renderer prop accepts one) whose setSize drops updateStyle, so three
  // only ever resizes the drawing buffer, never the NS layout style.
  //
  // THREE always uses the WebGPURenderer (imported from @react-three/fiber/webgpu):
  // WebGPU backend when available, WebGL2 fallback otherwise.
  //
  // We let three.js create and manage the renderer and context. The only platform-specific
  // work we do is the present() call after every frame (required for NativeScript canvas).
  const userRenderer = (renderProps as { renderer?: unknown }).renderer

  const createRenderer = (rendererProps: object) => {
    const config = userRenderer && typeof userRenderer === 'object' ? userRenderer : {}

    // Let three.js create the renderer.
    //
    // On Android we pass pre-acquired WebGPU resources when available.
    // This is the equivalent of the manual setup in the working canvas demos.
    const hasWebGPUResources = !!(webgpuContext && webgpuDevice)
    debug('[R3FNS] createRenderer – hasWebGPUResources:', hasWebGPUResources)
    if (hasWebGPUResources) {
      debug('[R3FNS] Passing WebGPU device + context to WebGPURenderer')
    }
    const renderer = new WebGPURenderer({
      ...rendererProps,
      ...config,
      ...(hasWebGPUResources ? { context: webgpuContext, device: webgpuDevice } : {}),
    } as any)

    const setSize = renderer.setSize.bind(renderer)
    ;(renderer as unknown as { setSize: (w: number, h: number) => void }).setSize = (w, h) => setSize(w, h, false)
    return renderer
  }

  // Wait for WebGPU resources (if we are doing the Android manual bootstrap)
  // before letting r3f call our renderer factory. This guarantees the values
  // are populated when new WebGPURenderer runs.
  const ready = webgpuSetup.then(() =>
    root.configure({
      events,
      ...renderProps,
      renderer: createRenderer,
      dpr,
      size: { width, height, top: 0, left: 0 },
      onCreated(state) {
        setSize = state.setSize
        const present = createPresent(view, state.renderer)
        const render = state.renderer.render.bind(state.renderer)
        const getTarget = (state.renderer as { getRenderTarget?: () => unknown }).getRenderTarget
        const backend = 'backend' in state.renderer ? (state.renderer as any).backend : null
        debug(
          '[R3FNS] onCreated - final backend:',
          backend?.constructor?.name,
          'isWebGPUBackend:',
          backend?.isWebGPUBackend,
        )

        // We only wrap render() to inject the platform-specific present() call.
        // Everything else (context, clears, scene.background, etc.) is left to three.js.
        //
        // Critical: We only call present() (and thus presentSurface() / finish+flush+commit on Android)
        // when rendering the *final on-screen frame*. Calling it during every intermediate render
        // (shadows, ContactShadows, environment probes, post effects, etc.) causes excessive
        // presents, breaks proper vsync/frame pacing, wastes CPU/GPU, and leads to heat + fps drops.
        state.gl.render = (scene: any, camera: any) => {
          render(scene, camera)

          const isOnScreen = !getTarget || getTarget.call(state.gl) === null

          if (isOnScreen) {
            present()
          }

          // Sample stats only for the on-screen frame.
          if (onPresent && isOnScreen) onPresent(state.gl)
        }

        return renderProps.onCreated?.(state)
      },
    }),
  )

  // NS dispatches pointer events but never a 'click', and its dispatchEvent is a no-op — so r3f's
  // onClick can't fire on its own. Synthesize one on a stationary pointerup via notify(), which is
  // where NS routes addEventListener('click'). Mirrors @react-three/native's PanResponder.
  let downX = 0
  let downY = 0
  const onPointerDown = (e: { clientX: number; clientY: number }) => {
    downX = e.clientX
    downY = e.clientY
  }
  const onPointerUp = (e: { clientX: number; clientY: number; pointerId?: number }) => {
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > CLICK_SLOP) return
    ;(view as unknown as { notify(data: object): void }).notify({
      eventName: 'click',
      object: view,
      type: 'click',
      clientX: e.clientX,
      clientY: e.clientY,
      offsetX: e.clientX,
      offsetY: e.clientY,
      pointerId: e.pointerId ?? 0,
      pointerType: 'touch',
      button: 0,
      buttons: 0,
      target: view,
      preventDefault() {},
      stopPropagation() {},
    })
  }
  view.addEventListener('pointerdown', onPointerDown)
  view.addEventListener('pointerup', onPointerUp)

  // Re-fit on device rotation. orientationChangedEvent is a single discrete event (not the
  // per-layout 'layoutChanged' that fed back before), and we read Screen.mainScreen — stable
  // dimensions that swap with orientation, never the surface-perturbed clientWidth. Because the
  // renderer factory keeps r3f off the layout style, setting the surface here can't shrink the view.
  // We defer a tick so the screen reports the rotated dimensions. setSize updates camera.aspect.
  let disposed = false
  let rotateTimer: ReturnType<typeof setTimeout> | undefined
  const onOrientation = () => {
    rotateTimer = setTimeout(() => {
      // A rotation can fire just before unmount; the deferred body must not write to a torn-down view.
      if (disposed) return
      const w = screen.widthDIPs
      const h = screen.heightDIPs
      if (!w || !h) return
      view.width = Math.floor(w * dpr)
      view.height = Math.floor(h * dpr)
      setSize?.(w, h)
    }, 0)
  }
  Application.on(Application.orientationChangedEvent, onOrientation)

  return {
    render(element) {
      // Route renderer-setup (webgpuSetup/configure) and initial-render rejections to the same
      // failure path as scene throws, so a setup failure surfaces instead of hanging silently.
      ready
        .then(() =>
          root.render(
            <ErrorBoundary set={fail}>
              <Suspense fallback={fallback}>{element}</Suspense>
            </ErrorBoundary>,
          ),
        )
        .catch(fail)
    },
    unmount() {
      disposed = true
      if (rotateTimer !== undefined) clearTimeout(rotateTimer)
      Application.off(Application.orientationChangedEvent, onOrientation)
      view.removeEventListener('pointerdown', onPointerDown)
      view.removeEventListener('pointerup', onPointerUp)
      unmountComponentAtNode(view as unknown as HTMLCanvasElement)
    },
  }
}

// ReactDOM-style alias for the bootstrap above.
export const createRoot = Canvas

//* Present ==============================

// Pick the per-frame present call from the renderer's active backend.
// This is the only place we have platform-specific logic:
// - WebGPU backend → context.presentSurface()
// - WebGL fallback  → context.finish() + flush() + commit() (required on NS Android canvas)
function createPresent(view: NativeCanvas, renderer: object): () => void {
  const backend = (renderer as { backend?: { isWebGPUBackend?: boolean } }).backend
  debug('[R3FNS] createPresent – backend:', backend?.constructor?.name, 'isWebGPUBackend:', backend?.isWebGPUBackend)

  if (backend?.isWebGPUBackend) {
    const context = view.getContext('webgpu')
    debug('[R3FNS] WebGPU backend detected – context has presentSurface:', !!context?.presentSurface)
    if (context?.presentSurface) return () => context.presentSurface()
  }

  const context = view.getContext('webgl2')
  if (context) {
    debug('[R3FNS] Falling back to WebGL2 present logic')
    // Reliable present for Android WebGL fallback.
    return () => {
      try {
        if (typeof context.finish === 'function') context.finish()
        if (typeof context.flush === 'function') context.flush()
        if (typeof context.commit === 'function') context.commit()
      } catch {
        // Some contexts don't support flush/commit; ignore errors.
      }
    }
  }

  return () => {}
}
