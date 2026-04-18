// End-to-end bootstrap tests — spawn the shim as a real child process and
// assert on the NDJSON stdout stream. These cover the phase-2 acceptance
// criteria that require the full runtime stack (schema merge, persist
// across restart, chunked stream emission, error surfacing).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SHIM_ROOT = resolve(__dirname, '..')
const LOADER = join(SHIM_ROOT, 'loader.mjs')
const BOOTSTRAP = join(SHIM_ROOT, 'bootstrap.mjs')
const REPO_ROOT = resolve(SHIM_ROOT, '..')

/**
 * Spawn the bootstrap against a user script and collect stdout NDJSON
 * events until the child exits.
 *
 * Returns `{ events, exitCode, stderr }`.
 */
async function runShim({
  script,
  cliFlags = {},
  source = null,
  cacheKey = '',
  stateDir = '',
  timeout = 5000,
  stdinLines = [],
  waitMs = 250,
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
  child.stdin.on('error', () => {
    // Silently ignore EPIPE: child may have exited before we flushed stdin.
  })

  // Register the exit listener *before* any timers fire so we never miss
  // a fast exit (validation failures exit in ~100ms).
  const exitPromise = new Promise((resolveExit, rejectExit) => {
    const t = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {}
      rejectExit(new Error('child timed out'))
    }, timeout)
    child.on('exit', (code) => {
      clearTimeout(t)
      resolveExit(code)
    })
  })

  for (const line of stdinLines) {
    try {
      child.stdin.write(line + '\n')
    } catch {
      // child already exited — harmless for these tests.
    }
  }
  // Let the script run briefly, then close stdin so onExit fires.
  await new Promise((r) => setTimeout(r, waitMs))
  try {
    child.stdin.end()
  } catch {}

  const exitCode = await exitPromise

  const events = stdout
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return { __malformed: l }
      }
    })
  return { events, exitCode, stderr }
}

async function tmpWorkspace() {
  return mkdtemp(join(tmpdir(), 'aperture-e2e-'))
}

// -----------------------------------------------------------------------------

test('AC#1 — CLI flag becomes params.targetDir', async () => {
  const dir = await tmpWorkspace()
  try {
    const script = join(dir, 'ac1.mjs')
    await writeFile(
      script,
      `
      import { z } from 'zod'
      export const schema = z.object({ targetDir: z.string() })
      export async function onLoad(params, runtime) {
        runtime.log('targetDir:' + params.targetDir, 'info')
      }
    `,
    )
    const { events, exitCode } = await runShim({
      script,
      cliFlags: { targetDir: './src' },
    })
    assert.equal(exitCode, 0)
    const log = events.find((e) => e.type === 'log' && e.message.startsWith('targetDir:'))
    assert.equal(log?.message, 'targetDir:./src')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('AC#2 — CLI wins over URL query on collision', async () => {
  const dir = await tmpWorkspace()
  try {
    const script = join(dir, 'ac2.mjs')
    await writeFile(
      script,
      `
      import { z } from 'zod'
      export const schema = z.object({ targetDir: z.string() })
      export async function onLoad(params, runtime) {
        runtime.log('targetDir:' + params.targetDir, 'info')
      }
    `,
    )
    const { events, exitCode } = await runShim({
      script,
      source: 'https://example.com/ac2.mjs?targetDir=./foo',
      cliFlags: { targetDir: './bar' },
    })
    assert.equal(exitCode, 0)
    const log = events.find((e) => e.type === 'log' && e.message.startsWith('targetDir:'))
    assert.equal(log?.message, 'targetDir:./bar')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('AC#3 — complex CLI value parses to array', async () => {
  const dir = await tmpWorkspace()
  try {
    const script = join(dir, 'ac3.mjs')
    await writeFile(
      script,
      `
      import { z } from 'zod'
      export const schema = z.object({ filters: z.array(z.string()) })
      export async function onLoad(params, runtime) {
        runtime.log('filters:' + JSON.stringify(params.filters), 'info')
      }
    `,
    )
    const { events, exitCode } = await runShim({
      script,
      cliFlags: { filters: '["*.js","*.ts"]' },
    })
    assert.equal(exitCode, 0)
    const log = events.find((e) => e.type === 'log' && e.message.startsWith('filters:'))
    assert.equal(log?.message, 'filters:["*.js","*.ts"]')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('AC#4 — schema.safeParse failure routes to structured error', async () => {
  const dir = await tmpWorkspace()
  try {
    const script = join(dir, 'ac4.mjs')
    await writeFile(
      script,
      `
      import { z } from 'zod'
      export const schema = z.object({ targetDir: z.string() })
      export async function onLoad(params, runtime) {
        runtime.log('should not fire', 'info')
      }
    `,
    )
    const { events, exitCode } = await runShim({
      script,
      // No targetDir → required-field failure.
      cliFlags: {},
    })
    assert.notEqual(exitCode, 0)
    const err = events.find((e) => e.type === 'error')
    assert.ok(err, 'expected an error event')
    assert.match(err.message, /schema validation failed/)
    assert.ok(err.data?.issues?.length >= 1, 'expected structured issues')
    assert.equal(err.data.issues[0].path, 'targetDir')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('AC#7 — large streamed state:set is chunked and interleaves with log', async () => {
  const dir = await tmpWorkspace()
  try {
    const script = join(dir, 'ac7.mjs')
    await writeFile(
      script,
      `
      import { z } from 'zod'
      export const state = z.object({
        bigReport: z.any().default(null).stream(),
      })
      export async function onLoad(_params, runtime) {
        const big = 'x'.repeat(250 * 1024) // ~250KB
        runtime.log('before-big', 'info')
        runtime.state.set('bigReport', big)
        runtime.log('after-big', 'info')
      }
    `,
    )
    const { events, exitCode } = await runShim({ script })
    assert.equal(exitCode, 0)
    const chunks = events.filter((e) => e.type === 'state:set:chunk' && e.key === 'bigReport')
    assert.ok(chunks.length >= 2, 'expected multiple chunks for 250KB payload')
    assert.equal(chunks.at(-1).final, true)
    // Log events should appear in the stream too (before and after the chunks).
    const beforeLog = events.findIndex(
      (e) => e.type === 'log' && e.message === 'before-big',
    )
    const afterLog = events.findIndex(
      (e) => e.type === 'log' && e.message === 'after-big',
    )
    assert.ok(beforeLog >= 0 && afterLog >= 0, 'both logs present')
    assert.ok(beforeLog < afterLog, 'ordering preserved')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('AC#8/9 — persistKeys survive restart; version bump resets', async () => {
  const work = await tmpWorkspace()
  const stateDir = join(work, 'state')
  try {
    await writeFile(
      join(work, 'v1.mjs'),
      `
      // @aperture-version 1.0.0
      import { z } from 'zod'
      export const state = z.object({
        threshold: z.number().default(50).persist(),
        volatile: z.number().default(0),
      })
      export async function onLoad(_p, runtime) {
        runtime.state.set('threshold', 99)
        runtime.state.set('volatile', 7)
      }
      export async function onExit(runtime) {
        await runtime.state.persist()
      }
    `,
    )
    const cacheKeyV1 = 'test-v1-1.0'
    const cacheKeyV2 = 'test-v1-1.1'
    const firstRun = await runShim({
      script: join(work, 'v1.mjs'),
      cacheKey: cacheKeyV1,
      stateDir,
    })
    assert.equal(firstRun.exitCode, 0)
    // Restart — persistKey should be restored.
    await writeFile(
      join(work, 'v2.mjs'),
      `
      // @aperture-version 1.0.0
      import { z } from 'zod'
      export const state = z.object({
        threshold: z.number().default(50).persist(),
        volatile: z.number().default(0),
      })
      export async function onLoad(_p, runtime) {
        runtime.log('threshold:' + runtime.state.get('threshold'), 'info')
        runtime.log('volatile:' + runtime.state.get('volatile'), 'info')
      }
    `,
    )
    const secondRun = await runShim({
      script: join(work, 'v2.mjs'),
      cacheKey: cacheKeyV1,
      stateDir,
    })
    assert.equal(secondRun.exitCode, 0)
    const getLog = (prefix) =>
      secondRun.events.find((e) => e.type === 'log' && e.message.startsWith(prefix))
    assert.equal(getLog('threshold:')?.message, 'threshold:99')
    assert.equal(getLog('volatile:')?.message, 'volatile:0')

    // Version bump → different cache key → no snapshot → defaults.
    const thirdRun = await runShim({
      script: join(work, 'v2.mjs'),
      cacheKey: cacheKeyV2,
      stateDir,
    })
    assert.equal(thirdRun.exitCode, 0)
    const thirdLog = thirdRun.events.find(
      (e) => e.type === 'log' && e.message.startsWith('threshold:'),
    )
    assert.equal(thirdLog?.message, 'threshold:50')
  } finally {
    await rm(work, { recursive: true, force: true })
  }
})

test('AC#10 — state backed by schema key is readable via runtime.state.get', async () => {
  const dir = await tmpWorkspace()
  try {
    const script = join(dir, 'ac10.mjs')
    await writeFile(
      script,
      `
      import { z } from 'zod'
      export const schema = z.object({ targetDir: z.string() })
      export const state = z.object({ targetDir: z.string().default('./default') })
      export async function onLoad(_p, runtime) {
        runtime.log('live:' + runtime.state.get('targetDir'), 'info')
        const evs = []
        runtime.state.watch('targetDir', (v) => evs.push(v))
        runtime.state.set('targetDir', './edited')
        // Drain the per-key watcher chain. The store defers watcher
        // invocation onto a promise chain so one microtask flush isn't
        // enough — sleep briefly to let the queued async work resolve.
        await new Promise((r) => setTimeout(r, 20))
        runtime.log('watched:' + JSON.stringify(evs), 'info')
      }
    `,
    )
    const { events, exitCode } = await runShim({
      script,
      cliFlags: { targetDir: './from-cli' },
      // Bootstrap startup inside the test runner is slower; give onLoad
      // (which has a 20ms internal wait) enough headroom to complete.
      waitMs: 600,
    })
    assert.equal(exitCode, 0)
    const live = events.find((e) => e.type === 'log' && e.message.startsWith('live:'))
    assert.equal(live?.message, 'live:./from-cli')
    const watched = events.find((e) => e.type === 'log' && e.message.startsWith('watched:'))
    assert.ok(watched?.message.includes('./edited'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('GUI → script state writes land through stdin', async () => {
  const dir = await tmpWorkspace()
  try {
    const script = join(dir, 'gui-write.mjs')
    await writeFile(
      script,
      `
      import { z } from 'zod'
      export const state = z.object({
        q: z.string().default(''),
      })
      export async function onLoad(_p, runtime) {
        const seen = []
        runtime.state.watch('q', (v) => seen.push(v))
        // Wait for stdin events to arrive.
        await new Promise((r) => setTimeout(r, 150))
        runtime.log('seen:' + JSON.stringify(seen), 'info')
      }
    `,
    )
    const { events, exitCode } = await runShim({
      script,
      stdinLines: [
        JSON.stringify({ type: 'state:changed', key: 'q', value: 'hello' }),
      ],
      waitMs: 500,
      timeout: 4000,
    })
    assert.equal(exitCode, 0)
    const seen = events.find((e) => e.type === 'log' && e.message.startsWith('seen:'))
    assert.ok(seen?.message.includes('hello'), `got: ${seen?.message}`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
