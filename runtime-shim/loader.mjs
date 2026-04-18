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

const here = dirname(fileURLToPath(import.meta.url))
const shimPath = resolve(here, 'shim.mjs')
const shimUrl = pathToFileURL(shimPath).href

register('./hooks.mjs', import.meta.url, {
  data: { shimUrl },
})
