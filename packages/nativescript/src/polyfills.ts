import { Helpers } from '@nativescript/canvas/helpers'
import { Folder, knownFolders, path as nsPath, isAndroid } from '@nativescript/core'

const g = globalThis as any

if (isAndroid) {
  console.log(
    '[NS-R3F] Android detected via @nativescript/core isAndroid - calling Helpers.initialize() before canvas-polyfill',
  )
  Helpers.initialize()
} else {
  console.log('[NS-R3F] Not Android (per @nativescript/core) - skipping Helpers.initialize()')
}

import '@nativescript/canvas-polyfill'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { getMeshoptDecoder } from './wasm/meshopt-decoder'

// We need getMeshoptDecoder available for the early global THREE.GLTFLoader interceptor
// setup below (before we even publish THREE or define patchGLTFLoader). Importing it
// this early is safe — it has no DOM/canvas dependencies.

// Global THREE
g.THREE ??= THREE
if (g.window) g.window.THREE ??= THREE

// --- Early auto-patch via global THREE (answers "why can't we use THREE.GLTFLoader?") ---
// Classic three.js and some bundler/NS setups attach the examples loaders to the namespace:
//   import * as THREE from 'three'
//   import { GLTFLoader } from 'three/examples/...'
//   THREE.GLTFLoader = GLTFLoader
// By installing an assignment interceptor the instant we publish THREE to global, any
// later `THREE.GLTFLoader = ctor` (by drei, user code, or the loader module itself) causes
// an immediate patch of that ctor's prototype. We also patch whatever is already present.
// This runs at the absolute earliest moment the package can observe the global namespace.
function patchOneGLTFLoader(ctor: any, tag = '[NS-R3F MESHOPT]'): boolean {
  if (!ctor?.prototype) return false
  const proto = ctor.prototype as { __nsMeshopt?: boolean; setMeshoptDecoder?: (d: unknown) => unknown }
  if (proto.__nsMeshopt) return false
  proto.__nsMeshopt = true
  const set = proto.setMeshoptDecoder
  if (typeof set === 'function') {
    proto.setMeshoptDecoder = function () {
      return set.call(this, getMeshoptDecoder())
    }
    console.log(`${tag} Patched setMeshoptDecoder on`, ctor.name || 'GLTFLoader')
    return true
  }
  return false
}

function setupThreeGLTFLoaderInterceptor(): void {
  const threeNs = g.THREE
  if (!threeNs || threeNs.__nsGLTFPatched) return
  threeNs.__nsGLTFPatched = true

  // Patch whatever GLTFLoader (if any) is already on the namespace right now.
  if (threeNs.GLTFLoader) {
    patchOneGLTFLoader(threeNs.GLTFLoader)
  }

  // Intercept future assignments so the patch is applied the instant anyone attaches a loader.
  let current = threeNs.GLTFLoader
  try {
    Object.defineProperty(threeNs, 'GLTFLoader', {
      configurable: true,
      enumerable: true,
      get() {
        return current
      },
      set(v: any) {
        current = v
        if (v) patchOneGLTFLoader(v)
        return v
      },
    })
    console.log('[NS-R3F MESHOPT] Installed assignment interceptor on global THREE.GLTFLoader for early auto-patch')
  } catch {
    // Non-configurable property or frozen namespace in this env — one-time best effort is all we can do.
  }
}
setupThreeGLTFLoaderInterceptor()

// We copy decoders into the app bundle and redirect fetch/XHR to load them
function installDecoderRedirect(): void {
  const tag = '[NS-R3F DECODERS]'
  console.log(`${tag} installDecoderRedirect() called at startup`)
  try {
    if (typeof Folder?.exists !== 'function') {
      console.log(`${tag} Folder API not available, skipping decoder redirect`)
      return
    }
    const appPath = knownFolders.currentApp().path
    const dir = nsPath.join(appPath, 'assets', 'decoders')
    console.log(`${tag} Checking for decoder directory: ${dir}`)
    const exists = Folder.exists(dir)
    console.log(`${tag} Folder.exists("${dir}") = ${exists}`)
    if (!exists) {
      console.log(`${tag} No decoders directory found — no redirect installed`)
      return
    }

    const folder = Folder.fromPath(dir)
    const entities = folder.getEntitiesSync()
    const names = new Set<string>()
    console.log(`${tag} Found ${entities.length} entities in decoder dir:`)
    for (const entity of entities) {
      console.log(`${tag}   - ${entity.name} (path: ${entity.path})`)
      names.add(entity.name)
    }
    if (!names.size) {
      console.log(`${tag} Decoder directory exists but is empty`)
      return
    }
    console.log(`${tag} Will redirect these decoder filenames:`, Array.from(names))

    const redirect = (url: unknown): string | null => {
      if (typeof url !== 'string') return null
      const clean = url.split('?')[0].split('#')[0].split('/').pop() || ''
      const hit = names.has(clean)
      if (hit) {
        const target = `~/assets/decoders/${clean}`
        console.log(`${tag} REDIRECT: ${url} → ${target}`)
        return target
      }
      return null
    }

    const origFetch = g.fetch
    if (typeof origFetch === 'function') {
      console.log(`${tag} Patching global fetch for decoder redirect`)
      g.fetch = (input: any, init?: any) => {
        const original = typeof input === 'string' ? input : input?.url
        const redirected = redirect(original)
        if (redirected) {
          return origFetch(redirected, init)
        }
        return origFetch(input, init)
      }
    }
    const XHR = g.XMLHttpRequest
    if (XHR?.prototype && typeof XHR.prototype.open === 'function') {
      console.log(`${tag} Patching XMLHttpRequest.prototype.open for decoder redirect`)
      const open = XHR.prototype.open
      XHR.prototype.open = function (method: string, url: string, ...rest: any[]) {
        const redirected = redirect(url)
        return open.call(this, method, redirected ?? url, ...rest)
      }
    }
    console.log(`${tag} Decoder redirect installation complete`)
  } catch (err) {
    console.error(`${tag} Error during decoder redirect setup:`, err)
    /* no decoders copied / NS file APIs unavailable — leave fetch untouched */
  }
}
console.log('[NS-R3F POLYFILLS] polyfills.ts evaluating - about to call installDecoderRedirect()')
installDecoderRedirect()

// The ONE irreducible decoder special case: meshopt. Its wasm is embedded in JS and instantiates on
// the main thread, so on iOS the stock decoder bails — there's no fetch to redirect and no worker to
// reroute. So whenever a GLTFLoader sets a meshopt decoder (drei's useGLTF does, by default), swap in
// our WKWebView-bridged one (getMeshoptDecoder is platform-aware: stock on Android). Draco/KTX2/etc.
// need nothing here — they ride the redirect above. So `useGLTF(url)` just works, no app code.
//
// We patch BOTH the directly-imported constructor (reliable for modern ESM + drei) AND whatever
// is reachable via the global THREE namespace (covers classic `THREE.GLTFLoader` usage and any
// assignment that happened before or after our interceptor was installed).
export function patchGLTFLoader(): void {
  // Always try the direct module import first — this is the one drei/useGLTF will typically close over.
  patchOneGLTFLoader(GLTFLoader, '[NS-R3F MESHOPT direct]')

  // Also hit the global namespace version if present (may be a different module instance in some bundles).
  const threeNs = g.THREE
  if (threeNs?.GLTFLoader && threeNs.GLTFLoader !== GLTFLoader) {
    patchOneGLTFLoader(threeNs.GLTFLoader, '[NS-R3F MESHOPT global]')
  }

  // Re-run the interceptor setup in case we are called explicitly very early by user code
  // before the top-level one had a chance (defensive; idempotent).
  setupThreeGLTFLoaderInterceptor()
}

// Callable marker for app bootstraps that want to force-import before rendering;
// the side-effect imports above already do the work.
export function polyfills(): void {}

// Auto-apply the GLTF patch as a side effect when the package is imported.
// This gives the "just use useGLTF and it works" magic for most users.
patchGLTFLoader()
