// Virtual-module resolver for `aperture:runtime`.
//
// Phase 1 uses Node's module.register() hooks to intercept import specifiers
// of the form `aperture:runtime` and redirect them to the shim module on disk.
// The shim itself is plain `.mjs` — it just happens to be resolved by URL
// rather than by package name. This preserves native `.mjs` module semantics
// for the user script.
//
// Phase 6 will swap in the Bun-bundled Node runtime, at which point we may
// choose to migrate this to a compile-time shim. The contract on the script
// side (`import ... from 'aperture:runtime'`) does not change.

import { register } from 'node:module'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const shimPath = resolve(here, 'shim.mjs')
const shimUrl = pathToFileURL(shimPath).href

// Node's ESM resolver does NOT honor NODE_PATH, so user scripts that
// `import from 'zod'` (or any other shipped-with-aperture package) can't
// find it via the env var. Walk up from the shim directory to locate a
// `node_modules/` that contains the package and resolve its ESM entry so
// we can hand that URL to the ESM hooks directly.
//
// This is the Phase 2 bridge until Phase 6's bun-backed dep install lands —
// Phase 6 will move per-script deps into `~/.aperture/deps/` keyed by a
// manifest hash, and this map becomes obsolete.
const SHIPPED_PACKAGES = ['zod']
const shippedResolutions = {}
for (const pkg of SHIPPED_PACKAGES) {
  let dir = here
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(dir, 'node_modules', pkg)
    if (existsSync(resolve(candidate, 'package.json'))) {
      const pj = JSON.parse(readFileSync(resolve(candidate, 'package.json'), 'utf8'))
      const rel = pj.module ?? pj.main ?? 'index.js'
      const entryPath = resolve(candidate, rel)
      shippedResolutions[pkg] = pathToFileURL(entryPath).href
      break
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
}

register('./hooks.mjs', import.meta.url, {
  data: { shimUrl, shippedResolutions },
})
