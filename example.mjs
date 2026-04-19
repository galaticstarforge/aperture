// @aperture-version 0.1.0
//
// example.mjs — Browse home-directory folders and inspect their contents.
//
// Usage:
//   aperture ./example.mjs

import { z } from 'zod'
import { homedir } from 'os'

export const schema = z.object({})

export const state = z.object({
  view: z.enum(['folders', 'log']).default('folders'),
  folders: z.array(z.object({ name: z.string(), path: z.string() })).default([]),
  selectedFolder: z.string().default(''),
  logLines: z.array(z.any()).default([]),
})

export const ui = {
  type: 'column',
  gap: 12,
  children: [
    {
      type: 'card',
      title: 'Home Directory',
      visibleWhen: { bind: 'view', value: 'folders' },
      children: [
        {
          type: 'table',
          bind: 'folders',
          rowKey: 'path',
          rowDataAs: 'folder',
          columns: [
            { key: 'name', label: 'Folder' },
            {
              key: '_browse',
              label: '',
              cell: {
                type: 'button',
                label: 'Browse',
                onClick: 'openFolder',
                variant: 'secondary',
              },
            },
          ],
        },
      ],
    },
    {
      type: 'card',
      visibleWhen: { bind: 'view', value: 'log' },
      children: [
        {
          type: 'row',
          gap: 8,
          align: 'center',
          children: [
            {
              type: 'button',
              label: '← Back',
              onClick: 'closeLog',
              variant: 'secondary',
            },
            {
              type: 'label',
              bind: 'selectedFolder',
            },
          ],
        },
        {
          type: 'timeline',
          bind: 'logLines',
          eventKey: 'id',
          autoScroll: true,
          timestampFormat: 'relative',
        },
      ],
    },
  ],
}

export async function onLoad(params, runtime) {
  const { readdir } = await import('fs/promises')
  const home = homedir()

  const entries = await readdir(home, { withFileTypes: true })
  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, path: `${home}/${e.name}` }))

  runtime.state.set('folders', dirs)
}

export async function openFolder(args, runtime) {
  const { path } = args.folder
  runtime.state.set('selectedFolder', path)
  runtime.state.set('logLines', [])
  runtime.state.set('view', 'log')

  try {
    const { exec } = await import('child_process')
    const { promisify } = await import('util')
    const execAsync = promisify(exec)
    const { stdout } = await execAsync(`ls -la "${path}"`)

    const events = stdout
      .split('\n')
      .filter(Boolean)
      .map((line, i) => ({
        id: i,
        timestamp: Date.now() + i,
        level: 'info',
        message: line,
      }))

    runtime.state.set('logLines', events)
  } catch (err) {
    runtime.state.set('logLines', [
      { id: 0, timestamp: Date.now(), level: 'error', message: err.message },
    ])
  }
}

export async function closeLog(args, runtime) {
  runtime.state.set('view', 'folders')
  runtime.state.set('logLines', [])
  runtime.state.set('selectedFolder', '')
}
