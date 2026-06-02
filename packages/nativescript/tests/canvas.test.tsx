import { vi } from 'vitest'
import { act } from 'react'
import { WebGL2RenderingContext } from './helpers/WebGL2RenderingContext'
import { Canvas } from '../src'

// @nativescript/core and @nativescript/canvas-polyfill are aliased to test stubs in
// vitest.config.ts (their real modules use platform-specific resolution).

// Minimal stand-in for @nativescript/canvas's Canvas view (which natively implements the
// HTMLCanvasElement surface core reads).
function createNSCanvas() {
  const canvas: any = {
    clientWidth: 1280,
    clientHeight: 800,
    width: 0,
    height: 0,
    style: {},
    flush: vi.fn(),
    getContext: vi.fn(() => new WebGL2RenderingContext(canvas)),
    addEventListener: () => {},
    removeEventListener: () => {},
    on: () => {},
    off: () => {},
    notify: () => {},
    dispatchEvent: () => true,
    getBoundingClientRect: () => ({ width: 1280, height: 800, top: 0, left: 0, right: 1280, bottom: 800, x: 0, y: 0 }),
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
  }
  canvas.ownerDocument = canvas
  canvas.getRootNode = () => canvas
  return canvas
}

describe('nativescript Canvas', () => {
  it('should size the drawing buffer from layout and screen scale', () => {
    const canvas = createNSCanvas()
    Canvas(canvas)
    expect(canvas.width).toBe(2560)
    expect(canvas.height).toBe(1600)
  })

  it('should correctly mount', async () => {
    const canvas = createNSCanvas()
    await act(async () => {
      Canvas(canvas).render(<group />)
    })
    await vi.waitFor(() => expect(canvas.getContext).toHaveBeenCalled())
  })

  it('should correctly unmount', async () => {
    const canvas = createNSCanvas()
    const root = Canvas(canvas)
    await act(async () => {
      root.render(<group />)
    })
    await vi.waitFor(() => expect(canvas.getContext).toHaveBeenCalled())
    await act(async () => root.unmount())
  })

  it('should forward scene errors to onError', async () => {
    const canvas = createNSCanvas()
    const onError = vi.fn()
    function Boom(): null {
      throw new Error('boom')
    }
    await act(async () => {
      Canvas(canvas, { onError }).render(<Boom />)
    })
    // Canvas forwards a plain serializable { message, stack } (not the raw Error) so host-app
    // logging can't choke on circular fiber refs — see ErrorBoundary.componentDidCatch in Canvas.tsx.
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'boom' })))
  })
})
