# Aperture — Phased Implementation Plan

A six-phase delivery plan for the Aperture v2 design (`design.md`). Each phase is
a self-contained, demoable increment that strictly depends on the phases before
it. Scope is deliberately kept conservative: no phase ships features that rely
on plumbing from a later phase.

| # | Phase | Theme | Ships |
|---|---|---|---|
| 1 | [Foundation & Process Model](./phase-1-foundation-and-process-model.md) | Shell, IPC framing, lifecycle skeleton | Empty-window scripts run end-to-end; death screen on throw |
| 2 | [State, Schema & Reactivity](./phase-2-state-schema-and-reactivity.md) | zod schema/state, watch, persist, stream | Bidirectional state with persistence and coalesced updates |
| 3 | [UI Rendering: Inputs, Layout, Display](./phase-3-ui-rendering-basics.md) | Renderer + 20 basic elements | Fully composable GUIs from the basic element set |
| 4 | [Runtime Services & Invoke Suite](./phase-4-runtime-services-and-invoke.md) | `invoke`, `invokeStream`, formatters, cancellation | Scripts drive OS-level UI; structured logs; AbortSignal wired end-to-end |
| 5 | [Advanced Data Elements & Workers](./phase-5-data-elements-and-workers.md) | table, tree, chart, timeline, workers | Rich data views at scale; concurrent workers with identity |
| 6 | [CLI Tooling, Caching & Distribution](./phase-6-cli-caching-and-distribution.md) | `new`/`dev`/`validate`/`run`/`docs`, bun deps, semver cache, single-binary | Ship-ready binaries for macOS/Windows/Linux x86_64 |

## Dependency Chain

```
Phase 1 ──► Phase 2 ──► Phase 3 ──► Phase 4 ──► Phase 5 ──► Phase 6
           (schema      (renderer    (runtime     (data       (tooling &
            + state)     + basics)    services)    + workers)  packaging)
```

Phases 3+4 could be parallelized once Phase 2 lands (renderer and runtime
services are largely orthogonal), but are serialized here so that demos in
each phase exercise the full surface built up to that point.

## What Every Phase Contains

- **Goal** — the one-sentence outcome that defines "done".
- **Scope (in)** — design-doc sections the phase implements.
- **Scope (out)** — design-doc sections deliberately deferred.
- **Work items** — the concrete engineering tasks.
- **Acceptance criteria** — observable behaviors to verify at sign-off.
- **Risks & open questions** — known unknowns referencing design.md §
  "Remaining Open Questions" where applicable.

## Out-of-Scope Across All Phases (v1)

These items from the design remain explicitly deferred beyond v1:

- Accessibility (ARIA, screen readers, focus management)
- Hot reload (a manual "Reload Script" button in the death screen covers v1)
- `runtime.openWindow` / multi-window scripts
- `runtime.spawn(otherScript)` / script-to-script composition
- Node inspector / breakpoint debugging
- TypeScript in scripts (`.mjs` only)
- Local file imports from scripts (single-file constraint)
- Workers spawning workers (flat hierarchy only)
- Platforms other than macOS/Windows/Linux x86_64
