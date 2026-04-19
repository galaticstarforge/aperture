# @aperture/cli

CLI launcher for [Aperture](https://github.com/galaticstarforge/aperture). On
first invocation it downloads the platform-specific binary (plus runtime-shim)
from GitHub Releases, caches it under `~/.aperture/bin/`, and exec's it with
the arguments you passed.

## Install

```sh
npm install -g @aperture/cli
```

## Run

```sh
aperture run example.mjs ./
```

All arguments after `aperture` are forwarded verbatim to the native binary, so
every subcommand (`run`, `dev`, `validate`, `docs`, `new`, …) works identically.

## Supported platforms

| Platform           | Arch    |
| ------------------ | ------- |
| Linux              | x86_64  |
| macOS              | x86_64  |
| macOS              | aarch64 |
| Windows            | x86_64  |

`tar` must be on `PATH` (bundled with modern Windows 10+, macOS, and every
major Linux distro) to extract the release archive.

## Environment variables

| Variable              | Purpose                                                                 |
| --------------------- | ----------------------------------------------------------------------- |
| `APERTURE_CHANNEL`    | Release channel. Defaults to `nightly` (rolling build from `main`).     |
| `APERTURE_VERSION`    | Pin a specific tag (e.g. `0.1.0`). Overrides `APERTURE_CHANNEL`.        |
| `APERTURE_REPO`       | `owner/repo` to fetch from. Defaults to `galaticstarforge/aperture`.    |
| `APERTURE_CACHE_DIR`  | Override the cache location (default `~/.aperture/bin`).                |
| `APERTURE_NODE`       | Path to `node` used by the binary. Defaults to the Node running the CLI.|

## How it works

1. The CLI resolves your platform → `aperture-<platform>-<arch>.tar.gz`.
2. It downloads the archive from
   `https://github.com/<owner>/<repo>/releases/download/<tag>/<archive>`,
   following redirects.
3. It extracts the archive into `~/.aperture/bin/<tag>/aperture-<platform>-<arch>/`.
4. It spawns `aperture ...args` from the extracted directory, inheriting stdio.
5. Subsequent runs skip the download and reuse the cached binary.

The archive ships the `runtime-shim/` directory next to the binary, which the
native runner loads when executing your `.mjs` scripts.

## Clearing the cache

```sh
rm -rf ~/.aperture/bin
```
