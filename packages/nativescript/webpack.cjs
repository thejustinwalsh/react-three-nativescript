// Webpack preset for @react-three/nativescript apps. Folds in the build config r3f + drei need on
// NativeScript so you don't hand-roll it. Use it in your webpack.config.js:
//
//   const webpack = require('@nativescript/webpack')
//   const reactThree = require('@react-three/nativescript/webpack')
//   module.exports = (env) => {
//     webpack.init(env)
//     reactThree(webpack)
//     return webpack.resolveConfig()
//   }
//
// `workers` wires the Babel loader: it reroutes blob-URL workers (draco/ktx2/…) through the WKWebView
// bridge and copies the decoder resource files they fetch into assets/decoders — automatic, no config.
// Pass `true` for the defaults, or an object `{ include, substitutions }` which is MERGED with the
// defaults (you always get the meshopt inline + the three/@react-three scope, plus your additions). A
// substitution is `{ test, inline?, resources? }` — `resources` overrides resource resolution where
// the heuristic can't decide (gltf-vs-top-level draco, a custom decoder build).
const DEFAULT_WORKER_INCLUDE = [
  /node_modules[\\/]three[\\/]/,
  /node_modules[\\/]@react-three[\\/]/,
  // This package's own directory, so its built dist (which carries the meshopt `@ns-inline:`
  // directive) is processed even when the package is consumed through a workspace symlink — a
  // monorepo, where webpack resolves the real path under packages/… instead of node_modules/@react-
  // three/…, so the pattern above wouldn't match. Harmless for a real npm install (the dist there is
  // already covered by the node_modules/@react-three pattern).
  __dirname,
]
// No default substitutions — the loader is fully self-describing now. Blob-URL worker reroute +
// resource discovery (draco/ktx2/…) is automatic for every scanned module; meshopt's module is inlined
// via an `@ns-inline:` directive the loader discovers in the package's own AST. Consumers only add a
// substitution to override a resource the heuristic can't resolve, or to swap an inlined source.
const DEFAULT_SUBSTITUTIONS = []

// Pass options to override defaults, e.g. reactThree(webpack, { exportsPresence: 'error' }).
module.exports = function applyReactThree(webpack, options = {}) {
  const { reactFlavor = true, dropReactDomAlias = true, exportsPresence = 'warn', workers = false } = options
  const workerOpts = workers === true ? {} : workers || {}
  // Merge, don't replace: you always get the defaults (the meshopt inline, the three/@react-three
  // scope) PLUS whatever you add. User entries come last, so a substitution matching the same module
  // can override a specific default key while keeping the rest.
  const workerInclude = [...DEFAULT_WORKER_INCLUDE, ...(workerOpts.include || [])]
  const substitutions = [...DEFAULT_SUBSTITUTIONS, ...(workerOpts.substitutions || [])]

  // r3f authors scenes in .tsx/JSX. The NativeScript "react" flavor adds .tsx resolution + JSX.
  if (reactFlavor) webpack.useConfig('react')

  if (dropReactDomAlias) {
    webpack.chainWebpack((config) => {
      // The react flavor aliases react-dom -> react-nativescript for RNS apps. We render through
      // r3f's own reconciler on real React 19, so drop the alias.
      config.resolve.alias.delete('react-dom')
    })
  }

  if (exportsPresence) {
    // drei's /webgpu build imports a few WebGL-only classes that three/webgpu doesn't re-export and
    // that only its unused components reference. Downgrade the missing-named-export hard error to a
    // warning so the WebGPU bundle builds. (Assets in app/assets are already copied by NS's default
    // `assets/**` rule, so three's loaders read them off disk via `~/...`.)
    webpack.mergeWebpack({ module: { parser: { javascript: { exportsPresence } } } })
  }

  if (workers) {
    webpack.chainWebpack((config) => {
      const rule = config.module.rule('ns-worker-loader').test(/\.[cm]?js$/)
      for (const inc of workerInclude) rule.include.add(inc)
      rule.use('ns-worker-loader').loader(require.resolve('./ns-worker-loader.cjs')).options({ substitutions })
    })
  }
}
