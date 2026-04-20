import { spawn } from 'node:child_process'
import { ensureBinary } from './download.mjs'

export async function main(argv) {
  const binary = await ensureBinary()

  const env = { ...process.env }
  // The aperture binary shells out to `node` to run the user's script. Pin it
  // to the same Node that launched us so users don't need an extra `node` on
  // their PATH — `npm install -g @aperture/cli` already guarantees one.
  if (!env.APERTURE_NODE) {
    env.APERTURE_NODE = process.execPath
  }

  const child = spawn(binary, argv, { stdio: 'inherit', env })

  const forwardSignal = (sig) => {
    try {
      child.kill(sig)
    } catch {
      // Child may have already exited — swallow.
    }
  }
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP']
  for (const sig of signals) process.on(sig, () => forwardSignal(sig))

  child.on('error', (err) => {
    process.stderr.write(`aperture: failed to spawn binary: ${err.message}\n`)
    process.exit(1)
  })

  child.on('exit', (code, signal) => {
    if (signal) {
      // Re-raise on ourselves so the shell sees the correct exit cause.
      process.kill(process.pid, signal)
      return
    }
    process.exit(code ?? 0)
  })
}
