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

// `reactCompiler` opts the app's .tsx into the React Compiler. The compiler is a Babel pass and React's
// own rule is that it runs FIRST, on the original source, before anything lowers JSX or strips types — it
// needs source-level info to be sound. NativeScript compiles .tsx with ts-loader (babel only shows up in
// dev for react-refresh), so we add the compiler as an enforce:'pre' loader: pre-loaders run ahead of the
// normal `ts` rule, so it sees pristine .tsx, then ts-loader compiles the result. The loader is
// react-compiler-webpack's `reactCompilerLoader` (parses TS + JSX, runs only babel-plugin-react-compiler,
// re-emits source with types intact). Scoped to .tsx/.jsx — the two unambiguous JSX extensions. .ts/.js
// are left out on purpose: with the JSX parser on, a plain-TS generic like `foo<T>()` parses as a JSX
// tag, so blanket .ts would misparse. Components/JSX live in .tsx here anyway.
// The app supplies the `babel-plugin-react-compiler` peer; React 19's built-in `react/compiler-runtime`
// is the `_c` cache. Pass `true`, or an options object forwarded to the compiler plugin.
module.exports = function applyReactThree(webpack, options = {}) {
  const {
    reactFlavor = true,
    dropReactDomAlias = true,
    exportsPresence = 'warn',
    workers = false,
    reactCompiler = false,
  } = options
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

  if (reactCompiler) {
    // `reactCompilerLoader` is a resolved path string (react-compiler-webpack exports it via
    // require.resolve), so webpack-chain takes it as the loader directly.
    const { reactCompilerLoader } = require('react-compiler-webpack')
    // target '19' = use the built-in react/compiler-runtime. Any object passed as `reactCompiler` is
    // merged in so callers can set sources/panicThreshold/etc.
    const compilerOpts = { target: '19', ...(typeof reactCompiler === 'object' ? reactCompiler : {}) }
    webpack.chainWebpack((config) => {
      config.module
        .rule('react-compiler')
        .enforce('pre')
        .test(/\.[jt]sx$/)
        .use('react-compiler')
        .loader(reactCompilerLoader)
        .options(compilerOpts)
    })
  }
}
