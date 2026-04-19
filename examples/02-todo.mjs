// Example 2 — Todo tracker
//
// Exercises: zod schema params (launch-time + URL query), persisted state,
// inputs (input, checkbox, select), shortcuts, tabs, badge, stat, divider,
// progress, built-in formatters (relative), custom formatter, visibleWhen,
// disabledWhen, meta.returnsInto, invoke (confirm, notification), callbacks.
//
// Launch: aperture ./examples/02-todo.mjs
// Persisted across restarts because the script declares @aperture-version.
// Filter via URL query: aperture './examples/02-todo.mjs?filter=active'
//
// @aperture-version 0.1

import { z } from 'zod'

export const schema = z.object({
  filter: z.enum(['all', 'active', 'done']).default('all'),
})

export const state = z.object({
  todos: z
    .array(
      z.object({
        id: z.string(),
        text: z.string(),
        done: z.boolean(),
        createdAt: z.number(),
      }),
    )
    .default([])
    .persist(),
  draft: z.string().default(''),
  filter: z.enum(['all', 'active', 'done']).default('all'),
  visible: z.array(z.any()).default([]),
  totalCount: z.number().default(0),
  doneCount: z.number().default(0),
  percentDone: z.number().default(0),
})

export const window = { title: 'Todo Tracker', width: 640, height: 720 }

export const formatters = {
  // Custom formatter: returns `{ text, color }`.
  doneBadge(_value, row) {
    return row?.done
      ? { text: 'done', color: '#22c55e' }
      : { text: 'open', color: '#fbbf24' }
  },
}

export const ui = {
  type: 'column',
  gap: 12,
  children: [
    {
      type: 'card',
      title: 'New Task',
      children: [
        {
          type: 'row',
          gap: 8,
          align: 'center',
          children: [
            {
              type: 'input',
              bind: 'draft',
              placeholder: 'What needs doing?',
              shortcut: 'Enter',
            },
            {
              type: 'button',
              label: 'Add',
              onClick: 'addTodo',
              variant: 'primary',
              disabledWhen: { bind: 'draft', value: '' },
              shortcut: 'cmd+enter',
            },
          ],
        },
      ],
    },

    {
      type: 'card',
      title: 'Overview',
      children: [
        {
          type: 'row',
          gap: 16,
          children: [
            { type: 'stat', bind: 'totalCount', label: 'Total' },
            { type: 'stat', bind: 'doneCount', label: 'Done' },
            { type: 'stat', bind: 'percentDone', label: '% Complete' },
          ],
        },
        { type: 'divider' },
        { type: 'progress', bind: 'percentDone' },
      ],
    },

    {
      type: 'card',
      title: 'Tasks',
      children: [
        {
          type: 'row',
          gap: 8,
          align: 'center',
          children: [
            { type: 'label', text: 'Filter:' },
            {
              type: 'select',
              bind: 'filter',
              options: [
                { value: 'all', label: 'All' },
                { value: 'active', label: 'Active' },
                { value: 'done', label: 'Done' },
              ],
            },
            {
              type: 'button',
              label: 'Clear Done',
              onClick: 'clearDone',
              variant: 'danger',
              visibleWhen: { bind: 'doneCount', gt: 0 },
            },
          ],
        },
        { type: 'divider' },
        {
          type: 'table',
          bind: 'visible',
          rowKey: 'id',
          rowDataAs: 'todo',
          columns: [
            {
              key: 'done',
              label: 'Status',
              width: 90,
              format: 'doneBadge',
            },
            { key: 'text', label: 'Task' },
            {
              key: 'createdAt',
              label: 'Created',
              width: 140,
              format: 'relative',
            },
            {
              key: '_toggle',
              label: '',
              width: 110,
              cell: {
                type: 'button',
                label: 'Toggle',
                onClick: 'toggleTodo',
                variant: 'secondary',
              },
            },
            {
              key: '_remove',
              label: '',
              width: 110,
              cell: {
                type: 'button',
                label: 'Remove',
                onClick: 'confirmRemove',
                variant: 'danger',
              },
            },
          ],
        },
      ],
    },
  ],
}

// --- callbacks ---------------------------------------------------------------

export async function onLoad(params, runtime) {
  runtime.log(`onLoad filter=${params.filter}`)
  // Apply launch-time filter param into state so the select reflects it.
  runtime.state.set('filter', params.filter)
  recompute(runtime)

  // Watch triggers for recomputing derived state.
  runtime.state.watch('todos', () => recompute(runtime))
  runtime.state.watch('filter', () => recompute(runtime))
}

export async function addTodo(_args, runtime) {
  const draft = String(runtime.state.get('draft') ?? '').trim()
  if (!draft) return
  const todo = {
    id: `t-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    text: draft,
    done: false,
    createdAt: Date.now(),
  }
  const prev = runtime.state.get('todos') ?? []
  runtime.state.set('todos', [...prev, todo])
  runtime.state.set('draft', '')
  runtime.log(`added: ${todo.text}`)
  await runtime.invoke('notification', {
    title: 'Task added',
    body: todo.text,
    level: 'info',
  })
  await runtime.state.persist()
}

export async function toggleTodo(args, runtime) {
  const { todo } = args
  if (!todo) return
  const list = (runtime.state.get('todos') ?? []).map((t) =>
    t.id === todo.id ? { ...t, done: !t.done } : t,
  )
  runtime.state.set('todos', list)
  await runtime.state.persist()
}

export async function confirmRemove(args, runtime) {
  const { todo } = args
  if (!todo) return
  const { confirmed } = await runtime.invoke('confirm', {
    message: `Remove "${todo.text}"?`,
  })
  if (!confirmed) return
  const list = (runtime.state.get('todos') ?? []).filter((t) => t.id !== todo.id)
  runtime.state.set('todos', list)
  runtime.log(`removed: ${todo.text}`, 'warn')
  await runtime.state.persist()
}

export async function clearDone(_args, runtime) {
  const { confirmed } = await runtime.invoke('confirm', {
    message: 'Remove all completed tasks?',
  })
  if (!confirmed) return
  const list = (runtime.state.get('todos') ?? []).filter((t) => !t.done)
  runtime.state.set('todos', list)
  await runtime.state.persist()
}

// --- helpers -----------------------------------------------------------------

function recompute(runtime) {
  const todos = runtime.state.get('todos') ?? []
  const filter = runtime.state.get('filter') ?? 'all'
  const visible =
    filter === 'all'
      ? todos
      : filter === 'active'
        ? todos.filter((t) => !t.done)
        : todos.filter((t) => t.done)
  const total = todos.length
  const done = todos.filter((t) => t.done).length
  const pct = total === 0 ? 0 : Math.round((done / total) * 100)
  runtime.state.set('visible', visible)
  runtime.state.set('totalCount', total)
  runtime.state.set('doneCount', done)
  runtime.state.set('percentDone', pct)
}
