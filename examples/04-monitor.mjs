// Example 4 — System monitor
//
// Exercises: env whitelist, timeoutMs, onExit cleanup, runtime.signal-aware
// async loop (polling with cancellation), timeline with logTarget
// (auto-appends runtime.log to a timeline), live-updating line chart
// (bounded push), custom async formatter, built-in formatters (number,
// percent, ms), meta.returnsInto, stat with delta, alert, tabs, image,
// shortcuts, runtime.on lifecycle events, openExternal, badge.
//
// Launch: aperture ./examples/04-monitor.mjs
// First run will prompt to approve `USER` / `LANG` env access.
//
// @aperture-version 0.1

import { z } from 'zod'

export const schema = z.object({
  intervalMs: z.coerce.number().min(250).max(10_000).default(1000),
})

export const state = z.object({
  intervalMs: z.number().default(1000),
  paused: z.boolean().default(false),
  tickCount: z.number().default(0),
  loadSamples: z.array(z.any()).default([]),
  memPercent: z.number().default(0),
  memPercentDelta: z.string().default(''),
  loadNow: z.number().default(0),
  uptimeMs: z.number().default(0),
  activity: z.array(z.any()).default([]),
  envInfo: z.string().default(''),
  lastError: z.string().default(''),
  probeResult: z.string().default(''),
  chartSmooth: z.boolean().default(true),
})

export const window = { title: 'System Monitor', width: 820, height: 780 }

// Whitelist the env vars we plan to read. First launch triggers the
// approval dialog; subsequent launches remember the decision.
export const env = ['USER', 'LANG']

// Hard timeout — if the process survives 30 minutes for any reason, bail.
export const timeoutMs = 30 * 60 * 1000

// Tell the runtime what probeUrl returns so it writes into state automatically.
export const meta = {
  probeUrl: { returnsInto: 'probeResult' },
}

export const formatters = {
  // Async custom formatter — resolves after a microtask, demonstrating the
  // shimmer-then-resolve code path.
  async friendlyMs(value) {
    await Promise.resolve()
    const ms = Number(value) || 0
    if (ms < 1000) return `${ms}ms`
    const s = Math.floor(ms / 1000)
    if (s < 60) return `${s}s`
    const m = Math.floor(s / 60)
    return `${m}m ${s % 60}s`
  },
}

export const ui = {
  type: 'column',
  gap: 12,
  children: [
    {
      type: 'card',
      title: 'Monitor',
      children: [
        {
          type: 'row',
          gap: 12,
          align: 'center',
          children: [
            { type: 'label', text: 'Interval (ms):' },
            {
              type: 'number',
              bind: 'intervalMs',
              min: 250,
              max: 10_000,
              step: 250,
            },
            { type: 'checkbox', bind: 'paused', label: 'Paused' },
            {
              type: 'button',
              label: 'Pause/Resume',
              onClick: 'togglePaused',
              shortcut: 'Space',
            },
            {
              type: 'button',
              label: 'Probe anthropic.com',
              onClick: 'probeUrl',
              variant: 'secondary',
            },
            {
              type: 'button',
              label: 'Open docs',
              onClick: 'openDocs',
              variant: 'secondary',
            },
          ],
        },
        {
          type: 'alert',
          bind: 'lastError',
          level: 'warning',
          visibleWhen: { bind: 'lastError', not: '' },
        },
      ],
    },

    {
      type: 'card',
      title: 'At a glance',
      children: [
        {
          type: 'row',
          gap: 20,
          children: [
            { type: 'stat', bind: 'tickCount', label: 'Ticks' },
            { type: 'stat', bind: 'memPercent', label: 'Mem %', delta: 'memPercentDelta' },
            { type: 'stat', bind: 'loadNow', label: 'Load' },
            {
              type: 'label',
              bind: 'uptimeMs',
              format: 'friendlyMs',
            },
          ],
        },
        { type: 'divider', label: 'Environment (whitelisted)' },
        { type: 'code', bind: 'envInfo', language: 'text' },
        {
          type: 'label',
          bind: 'probeResult',
          visibleWhen: { bind: 'probeResult', not: '' },
        },
      ],
    },

    {
      type: 'tabs',
      items: [
        {
          label: 'Load chart',
          children: [
            {
              type: 'row',
              gap: 8,
              align: 'center',
              children: [
                { type: 'checkbox', bind: 'chartSmooth', label: 'Smooth' },
                {
                  type: 'badge',
                  bind: 'paused',
                  variants: {
                    true: 'paused',
                    false: 'live',
                  },
                },
              ],
            },
            {
              type: 'chart',
              bind: 'loadSamples',
              chartType: 'line',
              xKey: 't',
              series: [{ key: 'load', label: '1-min load', color: '#38bdf8' }],
              height: 260,
              tooltip: true,
              grid: true,
              maxEntries: 120,
            },
          ],
        },
        {
          label: 'Activity',
          children: [
            // timeline.logTarget causes runtime.log() to auto-append here.
            {
              type: 'timeline',
              bind: 'activity',
              logTarget: 'activity',
              eventKey: 'id',
              timestampFormat: 'relative',
              autoScroll: true,
              maxEntries: 200,
              filterLevels: true,
            },
          ],
        },
      ],
    },
  ],
}

// --- lifecycle ---------------------------------------------------------------

export async function onLoad(params, runtime) {
  runtime.state.set('intervalMs', params.intervalMs)

  // Mirror a few whitelisted env vars into state for display.
  const envInfo = [
    `USER=${process.env.USER ?? '(unset)'}`,
    `LANG=${process.env.LANG ?? '(unset)'}`,
  ].join('\n')
  runtime.state.set('envInfo', envInfo)

  // Subscribe to lifecycle cancel via runtime.on.
  runtime.on('cancel', (reason) => {
    runtime.log(`cancel received: ${reason}`, 'warn')
  })

  // Derive memPercent delta whenever memPercent changes.
  let lastMem = 0
  runtime.state.watch('memPercent', (v) => {
    const diff = Number(v) - lastMem
    lastMem = Number(v)
    const s = diff >= 0 ? `+${diff.toFixed(1)}` : diff.toFixed(1)
    runtime.state.set('memPercentDelta', s)
  })

  runtime.log('monitor started', 'info')
  // Kick off the polling loop — no await (runs for the life of the process).
  void pollLoop(runtime)
}

export async function onExit(runtime) {
  runtime.log('onExit — shutting down cleanly', 'warn')
  await runtime.state.persist()
}

// --- callbacks ---------------------------------------------------------------

export async function togglePaused(_args, runtime) {
  const cur = runtime.state.get('paused')
  runtime.state.set('paused', !cur)
  runtime.log(`paused=${!cur}`)
}

// Returned value flows into state.probeResult via meta.returnsInto.
export async function probeUrl(_args, runtime) {
  const start = Date.now()
  try {
    const res = await fetch('https://www.anthropic.com', {
      signal: runtime.signal,
      method: 'HEAD',
    })
    const ms = Date.now() - start
    runtime.log(`probe ${res.status} in ${ms}ms`)
    return `anthropic.com → ${res.status} (${ms}ms)`
  } catch (err) {
    if (runtime.signal.aborted) return 'probe cancelled'
    runtime.log(`probe failed: ${err?.message ?? err}`, 'error')
    return `probe failed: ${err?.message ?? err}`
  }
}

export async function openDocs(_args, runtime) {
  await runtime.invoke('openExternal', { url: 'https://docs.anthropic.com' })
  runtime.log('opened docs')
}

// --- polling loop ------------------------------------------------------------

async function pollLoop(runtime) {
  const os = await import('node:os')
  const startedAt = Date.now()

  while (!runtime.signal.aborted) {
    try {
      if (runtime.state.get('paused')) {
        await sleep(200, runtime.signal)
        continue
      }

      const free = os.freemem()
      const total = os.totalmem()
      const memPct = Number((((total - free) / total) * 100).toFixed(1))
      const load = os.loadavg()[0]

      runtime.state.set('memPercent', memPct)
      runtime.state.set('loadNow', Number(load.toFixed(2)))
      runtime.state.set('uptimeMs', Date.now() - startedAt)

      // Bounded push — the maxEntries on the chart handles trimming display-side,
      // but keep memory under control here too.
      const samples = runtime.state.get('loadSamples') ?? []
      const next = [...samples, { t: new Date().toLocaleTimeString(), load }]
      while (next.length > 200) next.shift()
      runtime.state.set('loadSamples', next)

      runtime.state.set('tickCount', (runtime.state.get('tickCount') ?? 0) + 1)
    } catch (err) {
      runtime.state.set('lastError', String(err?.message ?? err))
    }

    const interval = Math.max(250, Number(runtime.state.get('intervalMs')) || 1000)
    await sleep(interval, runtime.signal)
  }
  runtime.log('poll loop exited', 'warn')
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(t)
        resolve()
      }, { once: true })
    }
  })
}
