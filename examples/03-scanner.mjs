// Example 3 — Directory scanner
//
// Exercises: filePicker invoke, createWorker (scan a directory in a worker
// thread), worker-side emit/get, state.push, state.setIn, tree element with
// nodeDataAs + actions, chart (bar), tabs, alert, code, badge, built-in
// formatters (bytes, number), state.watch deriving aggregate stats,
// clipboard invoke, openExternal invoke.
//
// Launch: aperture ./examples/03-scanner.mjs
//
// @aperture-version 0.1

import { z } from 'zod'

export const schema = z.object({})

export const state = z.object({
  rootPath: z.string().default(''),
  scanning: z.boolean().default(false),
  scanProgress: z.number().default(0),
  scanLabel: z.string().default(''),
  tree: z.array(z.any()).default([]).stream(),
  files: z.array(z.any()).default([]).stream(),
  topExtensions: z.array(z.any()).default([]),
  totalFiles: z.number().default(0),
  totalBytes: z.number().default(0),
  errorMsg: z.string().default(''),
  selectedPath: z.string().default(''),
})

export const window = { title: 'Directory Scanner', width: 900, height: 760 }

export const ui = {
  type: 'column',
  gap: 12,
  children: [
    {
      type: 'card',
      title: 'Root',
      children: [
        {
          type: 'row',
          gap: 8,
          align: 'center',
          children: [
            { type: 'label', bind: 'rootPath' },
            {
              type: 'button',
              label: 'Pick Directory…',
              onClick: 'pickRoot',
              variant: 'primary',
              disabledWhen: 'scanning',
            },
            {
              type: 'button',
              label: 'Scan',
              onClick: 'startScan',
              variant: 'secondary',
              visibleWhen: { bind: 'rootPath', not: '' },
              disabledWhen: 'scanning',
            },
          ],
        },
        {
          type: 'progress',
          bind: 'scanProgress',
          visibleWhen: 'scanning',
        },
        {
          type: 'label',
          bind: 'scanLabel',
          visibleWhen: 'scanning',
        },
      ],
    },

    {
      type: 'alert',
      bind: 'errorMsg',
      level: 'error',
      visibleWhen: { bind: 'errorMsg', not: '' },
    },

    {
      type: 'card',
      title: 'Results',
      visibleWhen: { bind: 'totalFiles', gt: 0 },
      children: [
        {
          type: 'row',
          gap: 16,
          children: [
            { type: 'stat', bind: 'totalFiles', label: 'Files' },
            {
              type: 'label',
              bind: 'totalBytes',
              format: 'bytes',
            },
          ],
        },
        { type: 'divider' },
        {
          type: 'tabs',
          items: [
            {
              label: 'Tree',
              children: [
                {
                  type: 'tree',
                  bind: 'tree',
                  nodeKey: 'path',
                  labelKey: 'name',
                  childrenKey: 'children',
                  defaultExpanded: 'all',
                  nodeDataAs: 'node',
                  onSelect: 'selectNode',
                  actions: [
                    {
                      label: 'Copy path',
                      onClick: 'copyPath',
                      nodeDataAs: 'node',
                    },
                    {
                      label: 'Open',
                      onClick: 'openNode',
                      nodeDataAs: 'node',
                    },
                  ],
                },
                {
                  type: 'code',
                  bind: 'selectedPath',
                  visibleWhen: { bind: 'selectedPath', not: '' },
                },
              ],
            },
            {
              label: 'Top extensions',
              children: [
                {
                  type: 'chart',
                  bind: 'topExtensions',
                  chartType: 'bar',
                  nameKey: 'ext',
                  valueKey: 'count',
                  height: 280,
                  tooltip: true,
                  legend: false,
                },
              ],
            },
            {
              label: 'All files',
              children: [
                {
                  type: 'table',
                  bind: 'files',
                  rowKey: 'path',
                  columns: [
                    { key: 'name', label: 'Name', sortable: true, filter: true },
                    {
                      key: 'size',
                      label: 'Size',
                      width: 120,
                      sortable: true,
                      format: 'bytes',
                    },
                    { key: 'ext', label: 'Ext', width: 80, sortable: true },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
}

// --- callbacks ---------------------------------------------------------------

export async function onLoad(_params, runtime) {
  runtime.log('scanner ready — pick a directory to start')
}

export async function pickRoot(_args, runtime) {
  const result = await runtime.invoke('filePicker', { mode: 'directory' })
  if (!result || !result.paths || result.paths.length === 0) return
  runtime.state.set('rootPath', result.paths[0])
  runtime.state.set('errorMsg', '')
}

export async function startScan(_args, runtime) {
  const root = runtime.state.get('rootPath')
  if (!root) return
  runtime.state.set('scanning', true)
  runtime.state.set('scanProgress', 0)
  runtime.state.set('scanLabel', 'scanning…')
  runtime.state.set('errorMsg', '')
  runtime.state.set('tree', [])
  runtime.state.set('files', [])
  runtime.state.set('totalFiles', 0)
  runtime.state.set('totalBytes', 0)

  // Worker fn is serialized via fn.toString() — no outer-scope closures.
  const worker = runtime.createWorker(
    async (data, { emit }) => {
      const { readdir, stat } = await import('node:fs/promises')
      const { join, extname, basename } = await import('node:path')

      let fileCount = 0
      let byteTotal = 0
      const files = []

      async function walk(dir) {
        let entries
        try {
          entries = await readdir(dir, { withFileTypes: true })
        } catch {
          return null
        }
        const node = { name: basename(dir), path: dir, children: [] }
        for (const ent of entries) {
          const full = join(dir, ent.name)
          if (ent.isDirectory()) {
            const child = await walk(full)
            if (child) node.children.push(child)
          } else if (ent.isFile()) {
            try {
              const s = await stat(full)
              const info = {
                name: ent.name,
                path: full,
                size: s.size,
                ext: extname(ent.name).toLowerCase() || '(none)',
              }
              files.push(info)
              node.children.push({ ...info, children: [] })
              fileCount += 1
              byteTotal += s.size
              if (fileCount % 50 === 0) {
                emit('progress', { count: fileCount, bytes: byteTotal })
              }
            } catch {
              /* skip unreadable */
            }
          }
        }
        return node
      }

      const tree = await walk(data.root)
      return { tree: tree ? [tree] : [], files, fileCount, byteTotal }
    },
    { name: 'scan' },
  )

  worker.on('progress', (msg) => {
    const count = msg?.data?.count ?? 0
    runtime.state.set('scanLabel', `scanning… ${count} files so far`)
    // Indeterminate spinner feel: bounce value between 0-100.
    runtime.state.set('scanProgress', count % 100)
  })

  try {
    const result = await worker.run({ root })
    runtime.state.set('tree', result.tree)
    runtime.state.set('files', result.files)
    runtime.state.set('totalFiles', result.fileCount)
    runtime.state.set('totalBytes', result.byteTotal)

    // Derive top extensions.
    const extCounts = new Map()
    for (const f of result.files) {
      extCounts.set(f.ext, (extCounts.get(f.ext) ?? 0) + 1)
    }
    const top = [...extCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([ext, count]) => ({ ext, count }))
    runtime.state.set('topExtensions', top)

    runtime.log(
      `scan complete — ${result.fileCount} files, ${result.byteTotal} bytes`,
    )
  } catch (err) {
    runtime.state.set('errorMsg', `Scan failed: ${err?.message ?? err}`)
    runtime.log(`scan error: ${err?.message ?? err}`, 'error')
  } finally {
    runtime.state.set('scanning', false)
    runtime.state.set('scanProgress', 100)
    runtime.state.set('scanLabel', '')
  }
}

export async function selectNode(args, runtime) {
  const node = args?.node
  if (node?.path) runtime.state.set('selectedPath', node.path)
}

export async function copyPath(args, runtime) {
  const node = args?.node
  if (!node?.path) return
  await runtime.invoke('clipboard', { op: 'write', text: node.path })
  await runtime.invoke('notification', {
    title: 'Copied',
    body: node.path,
    level: 'success',
  })
}

export async function openNode(args, runtime) {
  const node = args?.node
  if (!node?.path) return
  await runtime.invoke('openExternal', { url: `file://${node.path}` })
}
