// Node ESM loader hooks — resolve `aperture:runtime` to the bundled shim.

let shimUrl = null

export async function initialize(data) {
  shimUrl = data?.shimUrl ?? null
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'aperture:runtime') {
    if (!shimUrl) {
      throw new Error('aperture:runtime hooks were not initialized with a shim URL')
    }
    return { url: shimUrl, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
