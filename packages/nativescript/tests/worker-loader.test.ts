import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// The loader is plain CJS (a webpack loader). Require it directly.
const loader = require('../ns-worker-loader.cjs') as (source: string) => string

// Fake webpack loader context: captures emitFile() assets (name -> content) and warnings. `root`
// only matters for resolving local importScripts fixtures relative to resourcePath.
function makeContext(root: string, resourcePath = path.join(root, 'node_modules/lib/index.js'), options: any = {}) {
  const assets: Record<string, string> = {}
  return {
    rootContext: root,
    resourcePath,
    assets,
    warnings: [] as string[],
    getOptions() {
      return options
    },
    emitFile(name: string, content: string) {
      assets[name] = content
    },
    emitWarning(e: Error) {
      this.warnings.push(e.message)
    },
  }
}

describe('worker loader: reroute to createWasmWorker', () => {
  let root: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'r3f-wl-'))
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  // No config — the reroute is automatic for any blob-URL worker (the webpack rule's `include` scopes
  // which files reach the loader). makeContext defaults to no substitutions.
  const IMPORT =
    /import\s*\{\s*createWasmWorker as __nsCreateWasmWorker\s*\}\s*from\s*['"]@react-three\/nativescript['"]/

  it('reroutes a direct blob worker to createWasmWorker and injects the import — no config', () => {
    const out = loader.call(makeContext(root), 'const w = new Worker(URL.createObjectURL(new Blob([source])))')
    expect(out).toContain('__nsCreateWasmWorker(source)')
    expect(out).toMatch(IMPORT)
    expect(out).not.toContain('createObjectURL')
  })

  it('reroutes the decoupled form, repointing the var to the source string', () => {
    const out = loader.call(
      makeContext(root),
      'const u = URL.createObjectURL(new Blob([body]));\nconst w = new Worker(u)',
    )
    expect(out).toContain('const u = body')
    expect(out).toContain('__nsCreateWasmWorker(u)')
  })

  it('reroutes the this.member form across statements (the DRACO shape)', () => {
    const src = 'class L { a(){ this.url = URL.createObjectURL(new Blob([body])) } b(){ return new Worker(this.url) } }'
    const out = loader.call(makeContext(root), src)
    expect(out).toContain('this.url = body')
    expect(out).toContain('__nsCreateWasmWorker(this.url)')
  })

  it('passes a runtime-built (dynamic) body straight through — no static resolution needed', () => {
    const src = 'const body = [pre, fn.toString()].join("\\n");\nnew Worker(URL.createObjectURL(new Blob([body])))'
    const out = loader.call(makeContext(root), src)
    expect(out).toContain('__nsCreateWasmWorker(body)')
  })

  it('joins a multi-part blob body', () => {
    const out = loader.call(makeContext(root), 'new Worker(URL.createObjectURL(new Blob([a, b])))')
    expect(out).toMatch(/__nsCreateWasmWorker\(\[a, b\]\.join\(""\)\)/)
  })

  it('leaves a plain (non-blob) file-path worker alone', () => {
    const src = "const w = new Worker('./real-worker.js')"
    expect(loader.call(makeContext(root), src)).toBe(src)
  })
})

describe('worker loader: inline substitution', () => {
  let root: string
  let pkgDir: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'r3f-wl-inline-'))
    pkgDir = path.join(root, 'node_modules/@scope/pkg/dist')
    fs.mkdirSync(pkgDir, { recursive: true })
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  const sub = (spec: string) => ({
    substitutions: [{ test: /index\.mjs$/, inline: { __NS_INLINE_X__: spec } }],
  })

  it('replaces a standalone sentinel with the module source, stripping the ESM export', () => {
    fs.writeFileSync(path.join(pkgDir, 'mod.js'), 'var Foo = function(){ return 42 };\nexport { Foo };\n')
    const ctx = makeContext(root, path.join(pkgDir, 'index.mjs'), sub('./mod.js'))
    const out = loader.call(ctx, "const S = '__NS_INLINE_X__'\nself.body = S")
    expect(out).not.toContain('__NS_INLINE_X__')
    expect(out).toContain('var Foo = function')
    expect(out).not.toContain('export {')
  })

  it('replaces a sentinel embedded in a larger literal (bundler-folded SENTINEL + handler)', () => {
    fs.writeFileSync(path.join(pkgDir, 'mod.js'), 'var Decoder = 1;\nexport { Decoder };')
    const ctx = makeContext(root, path.join(pkgDir, 'index.mjs'), sub('./mod.js'))
    const out = loader.call(ctx, "const S = '__NS_INLINE_X__\\nself.onmessage = function(){}'")
    expect(out).toContain('var Decoder = 1;')
    expect(out).toContain('self.onmessage = function')
    expect(out).not.toContain('__NS_INLINE_X__')
  })

  it('resolves a package-style specifier (require.resolve from the module dir)', () => {
    // A tiny installed package the loader resolves by name.
    const dep = path.join(root, 'node_modules/tiny-dec')
    fs.mkdirSync(dep, { recursive: true })
    fs.writeFileSync(path.join(dep, 'package.json'), JSON.stringify({ name: 'tiny-dec', main: 'd.js' }))
    fs.writeFileSync(path.join(dep, 'd.js'), 'var TinyDec = true;\nexport { TinyDec };')
    const ctx = makeContext(root, path.join(pkgDir, 'index.mjs'), sub('tiny-dec'))
    const out = loader.call(ctx, "const S = '__NS_INLINE_X__'")
    expect(out).toContain('var TinyDec = true;')
  })

  it('warns and leaves source unchanged when the module cannot be resolved', () => {
    const ctx = makeContext(root, path.join(pkgDir, 'index.mjs'), sub('./does-not-exist.js'))
    const out = loader.call(ctx, "const S = '__NS_INLINE_X__'")
    expect(out).toContain('__NS_INLINE_X__') // untouched
    expect(ctx.warnings.join('\n')).toMatch(/cannot resolve/)
  })

  it('skips files that do not contain the sentinel', () => {
    fs.writeFileSync(path.join(pkgDir, 'mod.js'), 'var Foo = 1; export { Foo };')
    const ctx = makeContext(root, path.join(pkgDir, 'index.mjs'), sub('./mod.js'))
    const src = 'const unrelated = 1'
    expect(loader.call(ctx, src)).toBe(src)
  })
})

describe('worker loader: resource discovery', () => {
  let root: string
  let modDir: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'r3f-wl-res-'))
    modDir = path.join(root, 'node_modules/three/examples/jsm/loaders')
    fs.mkdirSync(modDir, { recursive: true })
    const draco = path.join(root, 'node_modules/three/examples/jsm/libs/draco')
    fs.mkdirSync(path.join(draco, 'gltf'), { recursive: true })
    fs.writeFileSync(path.join(draco, 'draco_decoder.wasm'), Buffer.from('TOP'))
    fs.writeFileSync(path.join(draco, 'gltf/draco_decoder.wasm'), Buffer.from('GLTF'))
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it('discovers a fetched resource, prefers the gltf build, and emits it to assets/decoders', () => {
    const ctx = makeContext(root, path.join(modDir, 'DRACOLoader.js'), {
      substitutions: [{ test: /DRACOLoader\.js$/, reroute: true }],
    })
    loader.call(
      ctx,
      "function f(){ this.url = URL.createObjectURL(new Blob([body])); return new Worker(this.url) }\nvar x = this._loadLibrary('draco_decoder.wasm', 'arraybuffer')",
    )
    expect(ctx.assets['assets/decoders/draco_decoder.wasm']?.toString()).toBe('GLTF')
  })

  it('an explicit override wins over the heuristic', () => {
    fs.writeFileSync(path.join(root, 'custom.wasm'), Buffer.from('CUSTOM'))
    const ctx = makeContext(root, path.join(modDir, 'DRACOLoader.js'), {
      substitutions: [
        {
          test: /DRACOLoader/,
          reroute: true,
          resources: { 'draco_decoder.wasm': path.relative(modDir, path.join(root, 'custom.wasm')) },
        },
      ],
    })
    loader.call(
      ctx,
      "var x = this._loadLibrary('draco_decoder.wasm', 'arraybuffer'); new Worker(URL.createObjectURL(new Blob([b])))",
    )
    expect(ctx.assets['assets/decoders/draco_decoder.wasm']?.toString()).toBe('CUSTOM')
  })
})

describe('worker loader: @ns-inline directive (config-free)', () => {
  let root: string
  let pkgDir: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'r3f-wl-nsi-'))
    pkgDir = path.join(root, 'node_modules/@scope/pkg/dist')
    fs.mkdirSync(pkgDir, { recursive: true })
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it('inlines the module named in an @ns-inline string, no substitution config', () => {
    fs.writeFileSync(path.join(pkgDir, 'mod.js'), 'var Foo = 7;\nexport { Foo };')
    const ctx = makeContext(root, path.join(pkgDir, 'index.mjs')) // no options
    const out = loader.call(ctx, "const S = '@ns-inline:./mod.js'\nself.body = S")
    expect(out).toContain('var Foo = 7;')
    expect(out).not.toContain('@ns-inline')
    expect(out).not.toContain('export {')
  })

  it('warns and leaves the directive when the module cannot be resolved', () => {
    const ctx = makeContext(root, path.join(pkgDir, 'index.mjs'))
    const out = loader.call(ctx, "const S = '@ns-inline:./missing.js'")
    expect(out).toContain('@ns-inline:./missing.js')
    expect(ctx.warnings.join('\n')).toMatch(/cannot resolve/)
  })
})
