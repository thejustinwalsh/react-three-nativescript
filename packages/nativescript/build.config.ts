import { defineBuildConfig } from 'unbuild'

export default defineBuildConfig({
  entries: ['src/index'],
  outDir: 'dist',
  clean: true,
  declaration: true,
  failOnWarn: false,
  rollup: {
    emitCJS: true,
    esbuild: { jsx: 'automatic', target: 'es2020' },
  },
  externals: [
    'react',
    'three',
    'three/webgpu',
    /^three\/examples\//,
    '@react-three/fiber',
    '@react-three/fiber/webgpu',
    '@nativescript/core',
    '@nativescript/canvas',
    '@nativescript/canvas-polyfill',
    'its-fine',
  ],
})
