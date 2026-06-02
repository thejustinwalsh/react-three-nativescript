const webpack = require('@nativescript/webpack')
const reactThree = require('@react-three/nativescript/webpack')

module.exports = (env) => {
  webpack.init(env)
  // react flavor + react-dom alias drop + drei missing-export downgrade, and the ns-worker-loader
  // (turns inline blob-URL workers into on-disk NativeScript workers).
  reactThree(webpack, { workers: true })
  return webpack.resolveConfig()
}
