const webpack = require('@nativescript/webpack')
const reactThree = require('@react-three/nativescript/webpack')

module.exports = (env) => {
  webpack.init(env)
  // react flavor + react-dom alias drop + drei missing-export downgrade, the ns-worker-loader
  // (turns inline blob-URL workers into on-disk NativeScript workers), and the React Compiler pass
  // on .tsx (runs first, on source, ahead of ts-loader).
  reactThree(webpack, { workers: true, reactCompiler: true })
  return webpack.resolveConfig()
}
