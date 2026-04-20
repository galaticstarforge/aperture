import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import https from 'node:https'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO = process.env.APERTURE_REPO || 'galaticstarforge/aperture'

// When APERTURE_VERSION is set, we resolve to that tag (e.g. "v0.1.0" or
// "nightly"). Otherwise we use APERTURE_CHANNEL (default: "nightly") which
// tracks the rolling release produced by the build workflow on every push to
// main. A pinned release can be targeted with e.g. `APERTURE_VERSION=0.1.0`.
const CHANNEL = process.env.APERTURE_CHANNEL || 'nightly'
const VERSION_OVERRIDE = process.env.APERTURE_VERSION

const HERE = path.dirname(fileURLToPath(import.meta.url))

function platformSlug() {
  const { platform, arch } = process
  if (platform === 'linux' && arch === 'x64') return 'linux-x64'
  if (platform === 'darwin' && arch === 'x64') return 'darwin-x64'
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64'
  if (platform === 'win32' && arch === 'x64') return 'win32-x64'
  throw new Error(
    `unsupported platform/arch: ${platform}-${arch}. ` +
      `Supported: linux-x64, darwin-x64, darwin-arm64, win32-x64.`,
  )
}

function binaryName() {
  return process.platform === 'win32' ? 'aperture.exe' : 'aperture'
}

function resolveTag() {
  if (VERSION_OVERRIDE) {
    return VERSION_OVERRIDE.startsWith('v') || VERSION_OVERRIDE === 'nightly'
      ? VERSION_OVERRIDE
      : `v${VERSION_OVERRIDE}`
  }
  return CHANNEL
}

function cacheRoot() {
  if (process.env.APERTURE_CACHE_DIR) return process.env.APERTURE_CACHE_DIR
  return path.join(os.homedir(), '.aperture', 'bin')
}

function safeName(s) {
  return s.replace(/[^A-Za-z0-9._-]/g, '_')
}

export async function ensureBinary() {
  const slug = platformSlug()
  const tag = resolveTag()
  const bundleName = `aperture-${slug}`
  const bundleFile = `${bundleName}.tar.gz`

  const targetDir = path.join(cacheRoot(), safeName(tag), bundleName)
  const binaryPath = path.join(targetDir, binaryName())

  if (fs.existsSync(binaryPath)) return binaryPath

  await fsp.mkdir(targetDir, { recursive: true })

  const url = `https://github.com/${REPO}/releases/download/${tag}/${bundleFile}`
  const tarPath = path.join(path.dirname(targetDir), `${bundleName}.tar.gz.downloading`)

  process.stderr.write(`aperture: fetching ${url}\n`)
  await downloadWithRedirects(url, tarPath)

  try {
    await extractTar(tarPath, path.dirname(targetDir))
  } finally {
    await fsp.rm(tarPath, { force: true })
  }

  if (!fs.existsSync(binaryPath)) {
    throw new Error(
      `binary not found after extraction: ${binaryPath}. ` +
        `The release archive may be malformed.`,
    )
  }
  if (process.platform !== 'win32') {
    await fsp.chmod(binaryPath, 0o755)
  }
  return binaryPath
}

function downloadWithRedirects(url, dest, redirects = 5) {
  return new Promise((resolve, reject) => {
    if (redirects < 0) {
      reject(new Error('too many redirects while downloading binary'))
      return
    }
    const req = https.get(
      url,
      { headers: { 'user-agent': 'aperture-cli', accept: 'application/octet-stream' } },
      (res) => {
        const status = res.statusCode || 0
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume()
          resolve(downloadWithRedirects(res.headers.location, dest, redirects - 1))
          return
        }
        if (status !== 200) {
          res.resume()
          reject(
            new Error(
              `failed to download ${url}: HTTP ${status}. ` +
                `If this is a pinned version, make sure a matching release exists.`,
            ),
          )
          return
        }
        const file = fs.createWriteStream(dest)
        res.pipe(file)
        file.on('finish', () => file.close(() => resolve()))
        file.on('error', (err) => {
          file.close(() => reject(err))
        })
      },
    )
    req.on('error', reject)
  })
}

function extractTar(tarPath, cwd) {
  // `tar` is available on Linux/macOS and modern Windows (bundled since
  // Windows 10 1803). Using the system tool keeps this package dependency-free.
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xzf', tarPath, '-C', cwd], {
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    child.on('error', (err) => {
      reject(new Error(`failed to invoke tar: ${err.message}. Ensure tar is on PATH.`))
    })
    child.on('exit', (code, signal) => {
      if (signal) reject(new Error(`tar killed by signal ${signal}`))
      else if (code !== 0) reject(new Error(`tar exited with code ${code}`))
      else resolve()
    })
  })
}

// Exposed for tests.
export const _internals = { platformSlug, resolveTag, cacheRoot, binaryName }
// Silence unused-var lint when tree-shaken.
void HERE
