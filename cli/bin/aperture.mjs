#!/usr/bin/env node
import { main } from '../lib/index.mjs'

main(process.argv.slice(2)).catch((err) => {
  const msg = err && err.message ? err.message : String(err)
  process.stderr.write(`aperture: ${msg}\n`)
  process.exit(1)
})
