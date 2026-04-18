// Node ESM loader hooks — resolve `aperture:runtime` to the bundled shim,
// plus a small map of Phase-2-shipped packages (e.g. `zod`) that would
// otherwise fail resolution from scripts outside our `node_modules/`.

let shimUrl = null
let shippedResolutions = {}

export async function initialize(data) {
  shimUrl = data?.shimUrl ?? null
  shippedResolutions = data?.shippedResolutions ?? {}
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'aperture:runtime') {
    if (!shimUrl) {
      throw new Error('aperture:runtime hooks were not initialized with a shim URL')
    }
    return { url: shimUrl, shortCircuit: true }
  }
  if (shippedResolutions[specifier]) {
    return { url: shippedResolutions[specifier], shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
