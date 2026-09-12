# Contributing to Remote Host Explorer

Thanks for helping out. This guide covers building, testing, and packaging the extension. For
architecture and code conventions, see [CLAUDE.md](CLAUDE.md).

## Setup

```bash
npm install      # dependency install scripts are disabled on purpose — see below
npm run compile  # type-check, lint, and bundle into dist/extension.js
npm run watch    # rebuild on change; press F5 in VS Code to launch the extension
npm test         # build, then run the test suite inside VS Code
```

To run the tests against the oldest supported VS Code:

```bash
npm run test:build && npx vscode-test --code-version 1.90.0
```

## Why install scripts are disabled

`.npmrc` sets `ignore-scripts=true`, so `ssh2`'s optional native `cpu-features` addon is never compiled
with node-gyp. Locally built `.node` binaries crash the VS Code Extension Host on macOS, and `ssh2`
works without them.

This also turns off npm's automatic `pre`/`post` hooks. Chain build steps explicitly in `package.json`
scripts — for example, `test` calls `test:build` — rather than adding a `pretest` hook, which would
never run.

## Bundling

esbuild bundles everything into one self-contained `dist/extension.js`; `node_modules` is not shipped
in the `.vsix`. The bundle may depend only on Node.js built-ins and `vscode`. The two optional native
modules `ssh2` tries to load are replaced at build time with a stub that throws, which `ssh2` already
handles.

## Supported VS Code versions

`engines.vscode` is `^1.90.0` because `ssh2-sftp-client` requires Node.js 18.20.4 or later, and VS Code
1.90 is the first release that runs extensions on Node.js 20. Keep `@types/vscode` at the same
minimum — vsce refuses to package when the types are newer than `engines.vscode`.

## Icons

- `media/remote-host-explorer.svg` — the Activity Bar icon. It must stay SVG so VS Code can tint it for
  the current theme.
- `media/icon.png` — the Marketplace icon (128×128). It must be PNG: vsce rejects an SVG in the
  manifest's top-level `icon` field.

## Packaging and publishing

```bash
npx @vscode/vsce package   # builds remote-host-explorer-<version>.vsix
npx @vscode/vsce publish   # requires a Marketplace publisher and personal access token
```

Before publishing:

1. Update `version` in `package.json` and add a matching section to `CHANGELOG.md`.
2. Run `npm test`.
3. Push your changes, so links from the Marketplace listing to the repository work.
