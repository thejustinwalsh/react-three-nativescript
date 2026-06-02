// Dev-only diagnostics. The package ships silent, like @react-three/fiber's core: __DEV__ (set by the
// NativeScript webpack DefinePlugin) folds to false in release builds so these calls dead-code-
// eliminate, and it is undefined under rollup (package build) and vitest, where the typeof guard makes
// them no-ops. One logging surface, gated — never raw console noise in shipped code.
declare const __DEV__: boolean

const enabled = typeof __DEV__ !== 'undefined' && __DEV__

export const debug: (...args: unknown[]) => void = enabled ? (...args) => console.log(...args) : () => {}

export const debugWarn: (...args: unknown[]) => void = enabled ? (...args) => console.warn(...args) : () => {}
