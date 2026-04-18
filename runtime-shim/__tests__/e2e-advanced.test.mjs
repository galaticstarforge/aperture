// Advanced end-to-end tests — spawn the shim and assert on the NDJSON stream.
// These cover scenarios not exercised by e2e-bootstrap.test.mjs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SHIM_ROOT = resolve(__dirname, '..')
const LOADER = join(SHIM_ROOT, 'loader.mjs')
const BOOTSTRAP = join(SHIM_ROOT, 'bootstrap.mjs')
const REPO_ROOT = resolve(SHIM_ROOT, '..')

async function runShim({
  script,
  cliFlags = {},
  source = null,
  cacheKey = '',
  stateDir = '',
  timeout = 6000,
  stdinLines = [],
  waitMs = 400,
}) {
  const child = spawn(
    process.execPath,
    ['--import', 'file://' + LOADER, BOOTSTRAP, script],
    {
      env: {
        ...process.env,
        APERTURE_SCRIPT: script,
        APERTURE_SOURCE: source ?? script,
        APERTURE_CLI_FLAGS: JSON.stringify(cliFlags),
        APERTURE_CACHE_KEY: cacheKey,
        APERTURE_STATE_DIR: stateDir,
        NODE_PATH: join(REPO_ROOT, 'node_modules'),
      },
      cwd: REPO_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )

  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (c) => (stdout += c.toString()))
  child.stderr.on('data', (c) => (stderr += c.toString()))
  child.stdin.on('error', () => {})

  const exitPromise = new Promise((resolveExit, rejectExit) => {
    const t = setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
      rejectExit(new Error('child timed out'))
    }, timeout)
    child.on('exit', (code) => {
      clearTimeout(t)
      resolveExit(code)
    })
  })

  for (const line of stdinLines) {
    try { child.stdin.write(line + '\n') } catch {}
  }
  await new Promise((r) => setTimeout(r, waitMs))
  try { child.stdin.end() } catch {}

  const exitCode = await exitPromise
  const events = stdout
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      try { return JSON.parse(l) } catch { return { __malformed: l } }
    })
  return { events, exitCode, stderr }
}

async function tmpWorkspace() {
  return mkdtemp(join(tmpdir(), 'aperture-e2e-adv-'))
}

// ---------------------------------------------------------------------------
// Minimal script with no exports
// ---------------------------------------------------------------------------

test('script with no exports exits cleanly (exit 0, result event)', async () => {
  const dir = await tmpWorkspace()
  try {
    const script = join(dir, 'empty.mjs')
    await writeFile(script, '// empty\n')
    const { events, exitCode } = await runShim({ script })
    assert.equal(exitCode, 0)
    assert.ok(events.some((e) => e.type === 'result'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Script that throws in onLoad
// ---------------------------------------------------------------------------

test('throw in onLoad → error event + exit 1', async () => {
  const dir = await tmpWorkspace()
  try {
    const script = join(dir, 'throw.mjs')
    await writeFile(
      script,
      `export async function onLoad() {
         throw new Error('intentional failure')
       }`,
    )
    const { events, exitCode } = await runShim({ script })
    assert.equal(exitCode, 1)
    const err = events.find((e) => e.type === 'error')
    assert.ok(err, 'expected error event')
    assert.match(err.message, /intentional failure/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('throw with a non-Error value surfaces as error event', async () => {
  const dir = await tmpWorkspace()
  try {
    const script = join(dir, 'throw-str.mjs')
    await writeFile(
      script,
      `export async function onLoad() {
         throw 'string error'
       }`,
    )
    const { events, exitCode } = await runShim({ script })
    assert.equal(exitCode, 1)
    const err = events.find((e) => e.type === 'error')
    assert.ok(err)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// progress() events flow through to stdout
// ---------------------------------------------------------------------------

test('progress() calls emit progress events on stdout', async () => {
  const dir = await tmpWorkspace()
  try {
    const script = join(dir, 'progress.mjs')
    await writeFile(
      script,
      `export async function onLoad(_p, runtime) {
         runtime.progress(0, 'Starting')
         runtime.progress(50)
         runtime.progress(100, 'Done')
       }`,
    )
    const { events, exitCode } = await runShim({ script })
    assert.equal(exitCode, 0)
    const progEvs = events.filter((e) => e.type === 'progress')
    assert.ok(progEvs.length >= 3)
    assert.equal(progEvs[0].value, 0)
    assert.equal(progEvs[0].label, 'Starting')
    assert.equal(progEvs[1].value, 50)
    assert.ok(!('label' in progEvs[1]))
    assert.equal(progEvs[2].value, 100)
    assert.equal(progEvs[2].label, 'Done')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// unhandledRejection in onLoad is surfaced
// ---------------------------------------------------------------------------

test('unhandledRejection in async work surfaces as error event', async () => {
  const dir = await tmpWorkspace()
  try {
    const script = join(dir, 'rejection.mjs')
    await writeFile(
      script,
      `export async function onLoad() {
         // Fire-and-forget unhandled rejection.
         Promise.reject(new Error('unhandled!'))
         // Give node a tick to detect it.
         await new Promise(r => setTimeout(r, 50))
       }`,
    )
    const { events, exitCode } = await runShim({ script, waitMs: 600 })
    assert.equal(exitCode, 1)
    const err = events.find((e) => e.type === 'error')
    assert.ok(err, 'expected error event for unhandled rejection')
    assert.match(err.message, /unhandled!/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Malformed JSON on stdin is silently ignored
// ---------------------------------------------------------------------------

test('malformed stdin lines are ignored and script runs normally', async () => {
  const dir = await tmpWorkspace()
  try {
    const script = join(dir, 'malformed-stdin.mjs')
    await writeFile(
      script,
      `export async function onLoad(_p, runtime) {
         runtime.log('alive', 'info')
       }`,
    )
    const { events, exitCode } = await runShim({
      script,
      stdinLines: ['{not json', '!!garbage!!', ''],
    })
    assert.equal(exitCode, 0)
    const alive = events.find((e) => e.type === 'log' && e.message === 'alive')
    assert.ok(alive, 'script should have logged "alive"')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// cancel message on stdin triggers onExit
// ---------------------------------------------------------------------------

test('cancel message on stdin triggers onExit callback', async () => {
  const dir = await tmpWorkspace()
  try {
    const script = join(dir, 'cancel.mjs')
    await writeFile(
      script,
      `export async function onLoad(_p, runtime) {
         // Block until cancelled.
         await new Promise((r) => runtime.signal.addEventListener('abort', r))
       }
       export async function onExit() {
         // Use process.stdout directly since runtime.log may be called after
         // the emit function is torn down in some edge cases.
         process.stdout.write(JSON.stringify({type:'log',level:'info',message:'exiting'}) + '\\n')
       }`,
    )
    const { events, exitCode } = await runShim({
      script,
      stdinLines: [JSON.stringify({ type: 'cancel' })],
      waitMs: 800,
    })
    assert.equal(exitCode, 0)
    const exitLog = events.find((e) => e.type === 'log' && e.message === 'exiting')
    assert.ok(exitLog, 'onExit should have logged "exiting"')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Multiple state keys are all emitted in the initial mirror
// ---------------------------------------------------------------------------

test('all initial state keys are mirrored to stdout after onLoad', async () => {
  const dir = await tmpWorkspace()
  try {
    const script = join(dir, 'multi-state.mjs')
    await writeFile(
      script,
      `import { z } from 'zod'
       export const state = z.object({
         a: z.number().default(1),
         b: z.string().default('hello'),
         c: z.boolean().default(true),
       })
       export async function onLoad() {}`,
    )
    const { events, exitCode } = await runShim({ script })
    assert.equal(exitCode, 0)
    const stateEvs = events.filter((e) => e.type === 'state:set')
    const keys = stateEvs.map((e) => e.key)
    assert.ok(keys.includes('a'), `expected 'a' in ${keys}`)
    assert.ok(keys.includes('b'), `expected 'b' in ${keys}`)
    assert.ok(keys.includes('c'), `expected 'c' in ${keys}`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Script with no schema accepts any CLI flags (no validation error)
// ---------------------------------------------------------------------------

test('script with no schema export accepts any CLI flags without error', async () => {
  const dir = await tmpWorkspace()
  try {
    const script = join(dir, 'no-schema.mjs')
    await writeFile(
      script,
      `export async function onLoad(params, runtime) {
         runtime.log('received:' + JSON.stringify(params), 'info')
       }`,
    )
    const { events, exitCode } = await runShim({
      script,
      cliFlags: { anything: 'goes', n: '42' },
    })
    assert.equal(exitCode, 0)
    const log = events.find((e) => e.type === 'log' && e.message.startsWith('received:'))
    assert.ok(log, 'expected received log')
    const received = JSON.parse(log.message.slice('received:'.length))
    assert.equal(received.anything, 'goes')
    assert.equal(received.n, 42) // coerced to number by mergeRawParams
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// onExit is called when stdin closes naturally
// ---------------------------------------------------------------------------

test('onExit fires when stdin closes', async () => {
  const dir = await tmpWorkspace()
  try {
    const script = join(dir, 'on-exit.mjs')
    await writeFile(
      script,
      `export async function onLoad(_p, runtime) {
         // Wait indefinitely until signal fires.
         await new Promise(r => runtime.signal.addEventListener('abort', r))
       }
       export async function onExit(runtime) {
         runtime.log('cleanup-done', 'info')
       }`,
    )
    const { events, exitCode } = await runShim({ script, waitMs: 400 })
    assert.equal(exitCode, 0)
    const log = events.find((e) => e.type === 'log' && e.message === 'cleanup-done')
    assert.ok(log, 'onExit log should appear')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// onLoad return value is emitted as result.data
// ---------------------------------------------------------------------------

test('onLoad return value is included in result event', async () => {
  const dir = await tmpWorkspace()
  try {
    const script = join(dir, 'return-val.mjs')
    await writeFile(
      script,
      `export async function onLoad() {
         return { status: 'ok', code: 42 }
       }`,
    )
    const { events, exitCode } = await runShim({ script })
    assert.equal(exitCode, 0)
    const result = events.find((e) => e.type === 'result')
    assert.ok(result, 'expected result event')
    assert.deepEqual(result.data, { status: 'ok', code: 42 })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('onLoad with no return value emits result with data: null', async () => {
  const dir = await tmpWorkspace()
  try {
    const script = join(dir, 'no-return.mjs')
    await writeFile(script, `export async function onLoad() {}`)
    const { events, exitCode } = await runShim({ script })
    assert.equal(exitCode, 0)
    const result = events.find((e) => e.type === 'result')
    assert.ok(result)
    assert.equal(result.data, null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// APERTURE_SCRIPT not set → bootstrap emits error and exits 1
// ---------------------------------------------------------------------------

test('missing APERTURE_SCRIPT causes immediate error exit', async () => {
  const child = spawn(
    process.execPath,
    ['--import', 'file://' + LOADER, BOOTSTRAP],
    {
      env: {
        ...process.env,
        APERTURE_SCRIPT: '',
        APERTURE_CLI_FLAGS: '{}',
        NODE_PATH: join(REPO_ROOT, 'node_modules'),
      },
      cwd: REPO_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )
  let stdout = ''
  child.stdout.on('data', (c) => (stdout += c.toString()))
  const exitCode = await new Promise((res) => child.on('exit', res))
  assert.notEqual(exitCode, 0)
  const events = stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l) } catch { return null } })
    .filter(Boolean)
  assert.ok(events.some((e) => e.type === 'error'))
})

// ---------------------------------------------------------------------------
// Script syntax error is surfaced as an error event
// ---------------------------------------------------------------------------

test('script with syntax error exits 1 and emits error event', async () => {
  const dir = await tmpWorkspace()
  try {
    const script = join(dir, 'syntax-err.mjs')
    await writeFile(script, 'export function (')
    const { events, exitCode } = await runShim({ script })
    assert.equal(exitCode, 1)
    assert.ok(events.some((e) => e.type === 'error'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// log() all four levels propagate correctly
// ---------------------------------------------------------------------------

test('all log levels emit correctly (info, warn, error, debug→info)', async () => {
  const dir = await tmpWorkspace()
  try {
    const script = join(dir, 'log-levels.mjs')
    await writeFile(
      script,
      `export async function onLoad(_p, runtime) {
         runtime.log('msg-info', 'info')
         runtime.log('msg-warn', 'warn')
         runtime.log('msg-error', 'error')
         runtime.log('msg-debug', 'debug')
       }`,
    )
    const { events, exitCode } = await runShim({ script })
    assert.equal(exitCode, 0)
    const logs = events.filter((e) => e.type === 'log')
    const byMsg = Object.fromEntries(logs.map((e) => [e.message, e.level]))
    assert.equal(byMsg['msg-info'], 'info')
    assert.equal(byMsg['msg-warn'], 'warn')
    assert.equal(byMsg['msg-error'], 'error')
    assert.equal(byMsg['msg-debug'], 'info') // debug folds to info on wire
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// GUI state:set on stdin fires watchers in script
// ---------------------------------------------------------------------------

test('GUI state write via state:set stdin message fires script watcher', async () => {
  const dir = await tmpWorkspace()
  try {
    const script = join(dir, 'gui-state-set.mjs')
    await writeFile(
      script,
      `import { z } from 'zod'
       export const state = z.object({ q: z.string().default('') })
       export async function onLoad(_p, runtime) {
         const seen = []
         runtime.state.watch('q', (v) => seen.push(v))
         await new Promise((r) => setTimeout(r, 200))
         runtime.log('seen:' + JSON.stringify(seen), 'info')
       }`,
    )
    const { events, exitCode } = await runShim({
      script,
      stdinLines: [JSON.stringify({ type: 'state:set', key: 'q', value: 'from-gui' })],
      waitMs: 600,
    })
    assert.equal(exitCode, 0)
    const log = events.find((e) => e.type === 'log' && e.message.startsWith('seen:'))
    assert.ok(log?.message.includes('from-gui'), `got: ${log?.message}`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
