// @aperture-version 1.0.0
// CI smoke test — runs headless, asserts basic runtime is functional, exits 0.

export async function headless(_params, runtime) {
  runtime.log('smoke test: start')

  // Verify state API works.
  runtime.state.set('ping', 'pong')
  const val = runtime.state.get('ping')
  if (val !== 'pong') {
    throw new Error(`state round-trip failed: expected "pong", got ${JSON.stringify(val)}`)
  }

  // Verify params is a frozen object.
  if (typeof runtime.params !== 'object' || runtime.params === null) {
    throw new Error('runtime.params is not an object')
  }

  // Verify signal is an AbortSignal.
  if (!(runtime.signal instanceof AbortSignal)) {
    throw new Error('runtime.signal is not an AbortSignal')
  }

  runtime.log('smoke test: all checks passed')
  return { result: 'ok', version: '1.0.0' }
}
