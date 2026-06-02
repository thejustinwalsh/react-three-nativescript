import { Label } from '@nativescript/core'

// A native FPS / frame-time overlay — a NativeScript Label, not a three primitive. NS has no DOM, so
// stats.js / drei <Stats> can't mount; and a GPU HUD (canvas-texture text + screen pass) would churn a
// texture every refresh for a number in the corner. A native Label rasterizes with the platform font
// (crisp at any DPR), costs no GPU, and drops straight into the page's GridLayout cell as a true
// overlay (same cell → children overlap by z-order; it never resizes the canvas).
//
// Dev-only: callers gate construction on __DEV__ so the whole thing (and this module) strips from
// release builds.

export interface StatsOptions {
  /** Milliseconds between text refreshes; also the rolling-average window. Default 500. */
  sampleMs?: number
  /** Append renderer.info draw calls + triangle count to the readout. Default true. */
  info?: boolean
  /**
   * Top offset in DIPs. The canvas page is edge-to-edge with the status bar hidden, so the overlay
   * insets itself to clear the notch / Dynamic Island. Defaults to `max(real safe-area inset, 64)`.
   */
  top?: number
}

interface RendererInfoLike {
  info?: { render?: { drawCalls?: number; calls?: number; triangles?: number } }
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(n >= 10_000 ? 0 : 1) + 'k'
  return String(n)
}

// iOS top safe-area inset (status bar / notch / Dynamic Island). The canvas page is edge-to-edge
// (iosIgnoreSafeArea), so the overlay must inset itself to clear the system header. Read from the
// window — valid once the view is loaded. Falls back to a sane constant off-device or on lookup miss.
function topSafeInset(): number {
  try {
    const app = (globalThis as { UIApplication?: any }).UIApplication?.sharedApplication
    if (!app) return 44
    let win = app.keyWindow
    if (!win && app.windows) {
      for (let i = 0; i < app.windows.count; i++) {
        const w = app.windows.objectAtIndex(i)
        if (w.isKeyWindow) {
          win = w
          break
        }
      }
      if (!win && app.windows.count > 0) win = app.windows.objectAtIndex(0)
    }
    const top = win?.safeAreaInsets?.top
    return typeof top === 'number' && top > 0 ? top : 44
  } catch {
    return 44
  }
}

// Returns the Label to drop into the page grid, plus a per-present `sample(renderer)` to call from the
// render loop. The label updates itself every `sampleMs`; touch is disabled so controls underneath
// (OrbitControls, etc.) keep receiving pointer events through the overlay.
export function createStatsOverlay(opts: StatsOptions = {}): { view: Label; sample: (renderer: unknown) => void } {
  const sampleMs = opts.sampleMs ?? 500
  const withInfo = opts.info ?? true

  const view = new Label()
  view.text = '…'
  view.horizontalAlignment = 'center'
  view.verticalAlignment = 'top'
  ;(view as unknown as { isUserInteractionEnabled: boolean }).isUserInteractionEnabled = false
  ;(view as unknown as { setInlineStyle(css: string): void }).setInlineStyle(
    'padding: 3 6; font-size: 11; font-family: Menlo, monospace; color: #00ff9c; background-color: rgba(0, 0, 0, 0.55); border-radius: 4;',
  )
  // Inset below the system header once attached. Status bar is hidden and the page is edge-to-edge, so
  // the safe-area inset under-reports — floor it to 64 DIPs to clear the notch / Dynamic Island. `loaded`
  // is when the window's insets are valid; `opts.top` overrides outright.
  view.on('loaded', () => {
    view.marginTop = opts.top ?? Math.max(topSafeInset(), 64)
  })

  let last = Date.now()
  let elapsed = 0
  let frames = 0

  function sample(renderer: unknown): void {
    const now = Date.now()
    elapsed += now - last
    last = now
    frames++
    if (elapsed < sampleMs) return
    const fps = Math.round((frames * 1000) / elapsed)
    const ms = (elapsed / frames).toFixed(1)
    let text = fps + ' fps · ' + ms + ' ms'
    if (withInfo) {
      const render = (renderer as RendererInfoLike).info?.render
      if (render) {
        const calls = render.drawCalls ?? render.calls
        if (calls != null) text += ' · ' + calls + ' calls'
        if (render.triangles != null) text += ' · ' + formatCount(render.triangles) + ' tris'
      }
    }
    view.text = text
    elapsed = 0
    frames = 0
  }

  return { view, sample }
}
