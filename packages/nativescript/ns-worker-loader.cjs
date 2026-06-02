// Babel-AST webpack loader that makes three's wasm decoders run on NativeScript, automatically.
//
// Three things, no per-decoder config:
//  1. REROUTE — three loaders create workers as `new Worker(URL.createObjectURL(new Blob([<src>])))`,
//     which NativeScript can't load. We rewrite that (direct, decoupled `const u = …; new Worker(u)`,
//     and `this.member = …; new Worker(this.member)` forms) to `createWasmWorker(<src>)` — the
//     `<src>` is the runtime-built worker source itself, so it runs in the WKWebView (where wasm
//     lives) with no static resolution. (DRACOLoader, KTX2Loader, anything with a blob worker.)
//  2. RESOURCES — a decoder fetches its files by bare name (`_loadLibrary('draco_decoder.wasm', …)`);
//     we discover those names in the AST, resolve them in the module's package `libs/`, and emitFile
//     them to `assets/decoders/`. The runtime fetch hook (polyfills) serves them by basename.
//  3. INLINE — `@ns-inline:<module>` in a string literal is replaced with that module's
//     (export-stripped) source at build time. For meshopt, whose wasm is embedded in JS and runs on
//     the main thread, so it must run whole inside a worker rather than be rerouted.
//
// `substitutions` are optional: `{ test, inline?, resources? }` to override a resource the heuristic
// can't resolve, or swap an inlined source.
const babel = require('@babel/core')
const fs = require('node:fs')
const path = require('node:path')

// If `node` is `URL.createObjectURL(new Blob([ <src> ]))`, return the <src> node, else null.
function createObjBlobSrc(node, t) {
  if (!t.isCallExpression(node)) return null
  const callee = node.callee
  if (!t.isMemberExpression(callee) || !t.isIdentifier(callee.property, { name: 'createObjectURL' })) return null
  const blob = node.arguments[0]
  if (!t.isNewExpression(blob) || !t.isIdentifier(blob.callee, { name: 'Blob' })) return null
  return blob.arguments[0] || null
}

// Resolve a module specifier (package path like `three/examples/...` or a relative file) to an
// absolute path, from the rewritten module's directory.
function resolveModule(spec, baseDir) {
  try {
    return require.resolve(spec, { paths: [baseDir, process.cwd()] })
  } catch {
    const rel = path.resolve(baseDir, spec)
    return fs.existsSync(rel) ? rel : null
  }
}

// Drop ESM export syntax so a module's source can run as a classic worker script (the names it
// declares stay as worker globals). meshopt only has a trailing `export { MeshoptDecoder };`.
function stripEsmExports(src) {
  return src
    .replace(/^[ \t]*export\s+default\s+/gm, '')
    .replace(/^[ \t]*export\s*\{[^}]*\}\s*;?[ \t]*$/gm, '')
    .replace(/^[ \t]*export\s+(?=(const|let|var|function|class|async)\b)/gm, '')
}

// Extract a named function's BODY source from a module (the text between its outer braces), using the
// node's source positions — exactly three's own `fn.substring(fn.indexOf('{')+1, fn.lastIndexOf('}'))`
// move, done at build time. Lets us reuse e.g. DRACOWorker's decode logic without patching three.
function extractFunctionBody(file, fnName) {
  const src = fs.readFileSync(file, 'utf-8')
  let body = null
  babel.transformSync(src, {
    babelrc: false,
    configFile: false,
    sourceType: 'module',
    plugins: [
      function ({ types: t }) {
        return {
          visitor: {
            FunctionDeclaration(p) {
              if (t.isIdentifier(p.node.id, { name: fnName })) {
                const b = p.node.body
                body = src.substring(b.start + 1, b.end - 1)
                p.stop()
              }
            },
          },
        }
      },
    ],
  })
  return body
}

// Resolve one inline spec to its text. A string spec inlines a module's (export-stripped) source.
// An object spec selects a mode: { module, fn } extracts that function's body; { module, base64 }
// inlines the file's bytes as base64; { module } is plain text.
function resolveInlineContent(spec, baseDir, loaderContext) {
  const moduleSpec = typeof spec === 'string' ? spec : spec.module
  const file = resolveModule(moduleSpec, baseDir)
  if (!file) {
    loaderContext.emitWarning(new Error(`[ns-worker-loader] inline: cannot resolve "${moduleSpec}"`))
    return null
  }
  if (typeof spec === 'object' && spec.fn) {
    const body = extractFunctionBody(file, spec.fn)
    if (body == null)
      loaderContext.emitWarning(
        new Error(`[ns-worker-loader] inline: function "${spec.fn}" not found in ${moduleSpec}`),
      )
    return body
  }
  if (typeof spec === 'object' && spec.base64) return fs.readFileSync(file).toString('base64')
  return stripEsmExports(fs.readFileSync(file, 'utf-8'))
}

// Match characters allowed in a module specifier after the directive prefix.
const NS_INLINE_RE = /@ns-inline:([^\s'"`]+)/g

// Inline a module's (export-stripped) source into a string literal so it becomes a self-contained
// worker body. Two triggers, both substring-matched (survives the bundler folding `X + handler`):
//   - `@ns-inline:<module>` — AST-discovered, the path is in the string, ZERO config. (meshopt uses this.)
//   - a configured sentinel key — explicit override, for when a consumer wants to swap the source.
function inlinePlugin(loaderContext, state, inline, baseDir) {
  const content = {}
  for (const key of Object.keys(inline)) {
    const resolved = resolveInlineContent(inline[key], baseDir, loaderContext)
    if (resolved != null) content[key] = resolved
  }
  const keys = Object.keys(content)
  return function () {
    return {
      visitor: {
        StringLiteral(p) {
          let v = p.node.value
          let changed = false
          v = v.replace(NS_INLINE_RE, (whole, spec) => {
            const file = resolveModule(spec, baseDir)
            if (!file) {
              loaderContext.emitWarning(new Error(`[ns-worker-loader] @ns-inline: cannot resolve "${spec}"`))
              return whole
            }
            changed = true
            return stripEsmExports(fs.readFileSync(file, 'utf-8'))
          })
          for (const key of keys) {
            if (v.indexOf(key) !== -1) {
              v = v.split(key).join(content[key])
              changed = true
            }
          }
          if (changed) {
            p.node.value = v
            state.changed = true
          }
        },
      },
    }
  }
}

// Recursively find files named `basename` under `dir` (bounded depth), returning absolute paths.
function findInTree(dir, basename, maxDepth) {
  const matches = []
  const walk = (d, depth) => {
    if (depth > maxDepth) return
    let entries
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) walk(full, depth + 1)
      else if (e.name === basename) matches.push(full)
    }
  }
  walk(dir, 0)
  return matches
}

const RESOURCE_RE = /^[\w.-]+\.(wasm|js|bin|data)$/i

// Discover the resource files a decoder fetches and copy them into the bundle. The decoder names them
// as bare string-literal filenames (`_loadLibrary('draco_decoder.wasm', ...)`); we resolve each by
// searching the module's package `libs/` (zero config), prefer a `gltf/` match, and `emitFile` it to
// `assets/decoders/<name>`. An explicit `override` map ({ name: relativeFile }) wins where the
// heuristic can't decide. The runtime fetch hook (polyfills) redirects requests for these by name.
function resourcePlugin(loaderContext, baseDir, override) {
  const searchRoot = path.resolve(baseDir, '..') // e.g. examples/jsm, from loaders/
  const seen = new Set()
  return function () {
    return {
      visitor: {
        StringLiteral(p) {
          const name = p.node.value
          if (seen.has(name) || !RESOURCE_RE.test(name)) return
          let file = override && override[name] ? path.resolve(baseDir, override[name]) : null
          if (!file) {
            // Resource files live under a `libs/` dir by convention — filters out other loaders' .js.
            const matches = findInTree(searchRoot, name, 6).filter(
              (m) => m.indexOf(`${path.sep}libs${path.sep}`) !== -1,
            )
            if (!matches.length) return
            file = matches.find((m) => m.indexOf(`${path.sep}gltf${path.sep}`) !== -1) || matches[0]
          }
          if (!file || !fs.existsSync(file)) return
          seen.add(name)
          loaderContext.emitFile(`assets/decoders/${name}`, fs.readFileSync(file))
        },
      },
    }
  }
}

// The Blob's parts (an array like [body]) reduced to the single source expression.
function partsToSource(parts, t) {
  if (!t.isArrayExpression(parts)) return parts
  if (parts.elements.length === 1) return parts.elements[0]
  return t.callExpression(t.memberExpression(parts, t.identifier('join')), [t.stringLiteral('')])
}

// Reroute a module's blob-URL worker to run through our bridge: `new Worker(x)` -> `createWasmWorker(x)`
// (which runs it in the WKWebView on iOS), and repoint the blob URL `x` to the runtime source string
// itself (so no static resolution / emit-to-disk is needed — the decoder's runtime-built source just
// flows to createWasmWorker). Handles the direct, decoupled, and `this.member` forms.
function workerPlugin(state) {
  return function ({ types: t }) {
    let touched = false
    // member name -> path of its `URL.createObjectURL(new Blob([...]))` call.
    const memberCalls = new Map()
    return {
      visitor: {
        Program: {
          enter(programPath) {
            programPath.traverse({
              AssignmentExpression(ap) {
                const { left } = ap.node
                if (!t.isMemberExpression(left) || !t.isIdentifier(left.property)) return
                if (createObjBlobSrc(ap.node.right, t)) memberCalls.set(left.property.name, ap.get('right'))
              },
            })
          },
          exit(pp) {
            if (!touched) return
            const imp = babel.parseSync(
              `import { createWasmWorker as __nsCreateWasmWorker } from '@react-three/nativescript';`,
              { babelrc: false, configFile: false, sourceType: 'module' },
            )
            pp.node.body.unshift(...imp.program.body)
          },
        },
        NewExpression(p) {
          if (!t.isIdentifier(p.node.callee, { name: 'Worker' })) return
          const arg = p.node.arguments[0]
          if (!arg) return

          if (createObjBlobSrc(arg, t)) {
            // direct: new Worker(URL.createObjectURL(new Blob([parts])))
            p.node.arguments[0] = partsToSource(createObjBlobSrc(arg, t), t)
          } else if (t.isIdentifier(arg)) {
            // decoupled: const u = URL.createObjectURL(...); new Worker(u)
            const b = p.scope.getBinding(arg.name)
            const parts = b && b.path.isVariableDeclarator() && createObjBlobSrc(b.path.node.init, t)
            if (!parts) return
            b.path.get('init').replaceWith(partsToSource(parts, t))
          } else if (t.isMemberExpression(arg) && t.isIdentifier(arg.property) && memberCalls.has(arg.property.name)) {
            // this.member: this.member = URL.createObjectURL(...); new Worker(this.member)
            const callPath = memberCalls.get(arg.property.name)
            const parts = createObjBlobSrc(callPath.node, t)
            if (!parts) return
            callPath.replaceWith(partsToSource(parts, t))
          } else {
            return
          }
          p.replaceWith(t.callExpression(t.identifier('__nsCreateWasmWorker'), p.node.arguments))
          touched = true
          state.changed = true
        },
      },
    }
  }
}

module.exports = function nsWorkerLoader(source) {
  const options = (typeof this.getOptions === 'function' && this.getOptions()) || {}
  const baseDir = path.dirname(this.resourcePath || process.cwd())
  // Optional, override-only config from any substitution whose `test` matches this module: `inline`
  // sentinels (swap an inlined source) and `resources` (force a resource the heuristic can't resolve).
  const inline = {}
  const resourceOverride = {}
  for (const sub of options.substitutions || []) {
    if (!sub || !sub.test || !sub.test.test(this.resourcePath)) continue
    if (sub.inline) Object.assign(inline, sub.inline)
    if (sub.resources) Object.assign(resourceOverride, sub.resources)
  }

  // Any module (within the rule's `include` scope) that builds a blob-URL worker gets that worker
  // rerouted to createWasmWorker AND its fetched resource files discovered + copied to assets/decoders.
  // Blob-URL workers can never load natively on NativeScript, so rerouting one is always correct — no
  // opt-in. Inline modules get their sentinels replaced (the one bespoke case: meshopt). Skip the rest.
  const hasWorker = source.indexOf('createObjectURL') !== -1 && source.indexOf('Worker') !== -1
  const hasInline =
    source.indexOf('@ns-inline:') !== -1 || Object.keys(inline).some((key) => source.indexOf(key) !== -1)
  if (!hasWorker && !hasInline) return source

  const state = { changed: false }
  const plugins = []
  if (hasInline) plugins.push(inlinePlugin(this, state, inline, baseDir))
  if (hasWorker) {
    plugins.push(workerPlugin(state))
    plugins.push(resourcePlugin(this, baseDir, resourceOverride))
  }

  try {
    const result = babel.transformSync(source, {
      babelrc: false,
      configFile: false,
      compact: false,
      sourceType: 'unambiguous',
      plugins,
    })
    // Don't reformat modules we didn't touch — only return generated code when we changed something.
    return state.changed && result && result.code ? result.code : source
  } catch (err) {
    this.emitWarning(new Error(`[ns-worker-loader] skipped ${this.resourcePath}: ${err.message}`))
    return source
  }
}
