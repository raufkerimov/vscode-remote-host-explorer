# CLAUDE.md — Agent Developer Guide for Remote Host Explorer

Welcome to **Remote Host Explorer**, a PhpStorm-style Remote Host / Deployment manager extension for VS Code.

## Project Overview
Remote Host Explorer provides a sidebar GUI to browse, edit, upload, download, and sync remote files over
SFTP, FTPS, or FTP (and rsync-over-SSH for uploads), featuring project- or globally-scoped server
profiles, path mappings, credential security via SecretStorage, SSH host key verification,
multi-select file operations, and background upload-on-save.

---

## Documentation

- `README.md` is the Marketplace page: user-facing only, plain language, no build or implementation
  details. Keep its Security and Troubleshooting sections accurate — troubleshooting entries quote the
  exact messages the extension shows, so update them if you change a message.
- `CONTRIBUTING.md` holds build, test, bundling, and publishing notes for developers.
- `CHANGELOG.md` is written for users: one section per released version, describing what changed for
  them rather than internal fixes to unreleased code.

---

## Tech Stack & Tooling
- **Language**: TypeScript (`^6.0.0`), targeting Node.js (`CommonJS` format)
- **Bundler**: `esbuild` (`esbuild.js`) — produces a single self-contained `dist/extension.js`
- **Linting**: ESLint with type-aware rules (`eslint.config.mjs`)
- **Testing**: `@vscode/test-cli` + Mocha, running in a real VS Code host
- **Key Dependencies**:
  - `ssh2-sftp-client` / `ssh2` — SFTP transport (bundled; pure JavaScript)
  - `basic-ftp` — FTP / explicit-TLS FTPS transport (bundled; pure JavaScript)
  - `vscode` API — Activity Bar, TreeView, Webview, SecretStorage, Clipboard, DragAndDrop

---

## Essential Commands

```bash
# Type-check, lint, and build the extension bundle
npm run compile

# Type-check only
npm run check-types

# Lint source code (type-aware; requires a valid tsconfig)
npm run lint

# Build everything and run the test suite in a VS Code host
npm test

# Watch mode for live esbuild & tsc compilation during extension debug (F5)
npm run watch
```

> `.npmrc` sets `ignore-scripts=true`. That **also disables npm's implicit `pre`/`post` lifecycle
> hooks**, so build steps are chained explicitly inside the scripts (e.g. `test` calls `test:build`).
> Do not reintroduce a `pretest` hook and expect it to run.

---

## Project Structure

```
remote-host-explorer/
├── package.json              # Extension manifest, commands, menus, configuration schema
├── esbuild.js                # Bundler config (native optional deps stubbed, not externalised)
├── .npmrc                    # ignore-scripts=true — blocks native addon builds
├── media/                    # Webview assets + icons (shipped in the .vsix)
│   ├── icon.png              # Marketplace icon — must stay PNG (vsce rejects SVG here)
│   ├── remote-host-explorer.svg # Activity Bar icon — must stay SVG (theme-tinted)
│   ├── remote-hosts.schema.json # Schema for .vscode/remote-hosts.json (items mirror the setting)
│   ├── serverForm.html       # Form markup; extension substitutes {{CSP}}/{{NONCE}}/{{...}} tokens
│   ├── serverForm.css
│   └── serverForm.js         # Webview script; reads state from a JSON bootstrap block
├── src/
│   ├── extension.ts          # Activation only: wiring, context keys, save listener
│   ├── commands/
│   │   ├── shared.ts         # CommandServices, clipboard, `resolveSelection`, `guarded()`, server picker
│   │   ├── serverCommands.ts # add/edit/remove/test/connect/disconnect
│   │   ├── fileCommands.ts   # open/new/rename/delete/copy/cut/paste/backup/copy-path (multi-select)
│   │   └── transferCommands.ts # upload/download (tree + Explorer, multi-select) + auto-upload-on-save
│   ├── config/
│   │   ├── serverConfig.ts   # ServerProfile, project/global scoped storage, legacy settings migration
│   │   ├── projectServerFile.ts # `.vscode/remote-hosts.json` parsing (JSONC) + watched in-memory store
│   │   ├── legacyState.ts    # Moves 0.1.0 `remoteHostViewer.*` globalState keys on activation
│   │   └── secrets.ts        # SecretStorage wrapper for passwords & key passphrases
│   ├── remote/
│   │   ├── RemoteClient.ts   # RemoteClient interface, file entry types, error predicates
│   │   ├── SftpClient.ts     # SFTP implementation (ssh2-sftp-client)
│   │   ├── FtpClient.ts      # FTP/FTPS implementation (basic-ftp) with a serial operation queue
│   │   ├── clientFactory.ts  # Client factory by protocol, default ports
│   │   ├── moveItems.ts      # Shared move logic for drag-and-drop and cut/paste
│   │   ├── ConnectionManager.ts # Connection pool, in-flight dedupe, state change events
│   │   ├── hostKeys.ts       # Trust-on-first-use SSH host key store
│   │   ├── transfer.ts       # Recursive upload/download/copy with progress + cancellation
│   │   └── rsyncUpload.ts    # rsync-over-ssh uploads (argument construction is unit tested)
│   ├── tree/
│   │   └── RemoteTreeProvider.ts # TreeDataProvider + drag/drop; caches node identity
│   ├── editing/
│   │   └── RemoteFileCache.ts # Local cache, persisted tracking, save-listener re-uploader
│   ├── util/
│   │   ├── localPath.ts      # Local path normalisation + case-aware containment
│   │   ├── remotePath.ts     # POSIX remote path helpers + cache path sanitiser
│   │   └── glob.ts           # Minimal glob matcher for ignoreGlobs
│   ├── webview/
│   │   └── ServerFormPanel.ts # Webview host for the server form (no markup in TS)
│   └── test/                 # Mocha suites (pure logic + an activation smoke test)
```

---

## Architecture & Conventions

### 1. Connection Management
- Connections are pooled and managed by `ConnectionManager`.
- Always request clients via `connections.getClient(server)`.
- Concurrent callers share a single in-flight handshake; never bypass this by constructing a client
  directly (the server form is the one exception — it uses throwaway connections for Test/Browse).
- `ConnectionManager` emits `onDidChangeConnection`; `extension.ts` subscribes to keep the tree's
  connected indicator accurate.
- `SftpRemoteClient` listens to `close`/`end`/`error` and clears broken connections automatically.
- `FtpRemoteClient`: an FTP control connection runs **one command at a time** (`basic-ftp` throws
  otherwise), so every public method goes through `run()`, a serial queue. Inside `run()`, use the
  `client` argument and private `...With(client, …)` helpers only — calling another public method
  enqueues behind itself and deadlocks.
- FTP commands like `ensureDir`/`cd` change the server working directory, so FTP paths are resolved
  against the login directory captured at connect (`resolve()`), never the current one.
- Host keys, private keys, and rsync are SFTP-only; guard those paths with `protocol === 'sftp'`.

### 2. Secrets & Credentials Security
- Passwords and key passphrases **MUST NEVER** be stored in settings or `remote-hosts.json`. Use
  `SecretsManager` (`vscode.SecretStorage`).
- Never persist a secret into webview state — `media/serverForm.js` deliberately excludes them.
- Stored credentials are only reused for a form-initiated connection when the form still targets the
  same protocol/host/port/username (`targetsSameEndpoint`). Do not relax this: it is what stops a
  typed-in host from receiving the saved password, and stops an SFTP password being sent over plain FTP.
- Profiles have a scope: `project` (`.vscode/remote-hosts.json` in a workspace folder) or `global`
  (the `remoteHostExplorer.servers` **user** setting). Read with `getScopedServerProfiles()` and write
  with `upsertServerProfile(profile, scope)` / `removeServerProfile(id)`, which move a profile between
  stores. Never read the setting with a plain `get()` (a workspace value would replace the user value).
- `ProjectServerStore` serves project profiles synchronously from memory, refreshed by file watchers.
  Anything that runs early (tree root, save listener, server picker) must `await
  whenServerProfilesLoaded()` first. Every write re-reads the file and refuses to save over one that
  doesn't parse — never treat a broken file as empty. Use `vscode.workspace.fs`, not `node:fs`.
- Changes to either store arrive through `onDidChangeServerProfiles`; don't listen for the setting.
- Workspace values of `remoteHostExplorer.servers` and both scopes of 0.1.0's `remoteHostViewer.servers`
  are migrated on load and on change (`migrateLegacySettings`): write the new home first, then clear the
  old value. `remoteHostViewer.servers` stays registered (deprecated) because VS Code refuses to update
  an unregistered setting. 0.1.0 secrets move lazily in `SecretsManager`; globalState in `legacyState.ts`.
- `media/remote-hosts.schema.json` duplicates the setting's `items` schema; a test asserts they match.

### 3. SSH Host Keys
- Every pooled connection passes a `hostKeyPolicy` built by `HostKeyStore.policyFor()` (trust on first
  use, stored in `globalState`). Never construct a `SftpRemoteClient` without one for a real session.
- The policy is deliberately two-phase: `isTrusted()` answers synchronously inside the handshake
  because ssh2's `readyTimeout` is running, and `confirm()` prompts afterwards so a slow human answer
  cannot time the connection out. Do not collapse these back into one async verifier.

### 4. Runtime Placement & External Binaries
- `"extensionKind": ["ui"]` pins the extension to the **local** machine, including in Remote-SSH/WSL/
  Dev Container/Codespaces windows. SSH sockets, the private key file, the host key store, and `rsync`
  therefore always come from the user's own computer.
- Consequence to respect when adding features: in those windows the workspace files live on the remote,
  so Node `fs` sees the *local* filesystem. Anything that must read workspace content regardless of
  placement should use `vscode.workspace.fs`, not `node:fs`.
- `rsync` (which itself invokes `ssh`) is the **only** external executable this extension depends on,
  and it is opt-in via `useRsyncForUpload`. Everything else ships in the bundle. If another external
  binary is ever introduced, give it the same treatment as `missingRsyncMessage`: detect `ENOENT` and
  explain how to install it per platform, and document it in the README (see its rsync table).
- `engines.vscode` is `^1.90.0`: `ssh2-sftp-client` needs Node ≥ 18.20.4 and VS Code 1.90 is the first
  release on Node 20. Keep `@types/vscode` at the same minimum (vsce rejects newer types) and don't use
  VS Code APIs newer than 1.90 without raising both. Verify with `npx vscode-test --code-version 1.90.0`.

### 5. Native Addons & macOS Stability
- `cpu-features` and `ssh2`'s native `.node` bindings must **NOT** be compiled via node-gyp or shipped.
- Native binaries built against system Node crash the Electron Extension Host on macOS (hardened
  runtime / code signing).
- Both are behind `try { require(...) } catch {}` inside `ssh2`. `esbuild.js` resolves them to a
  throwing stub, so `ssh2` falls back to its JavaScript implementations.
- `.npmrc` (`ignore-scripts=true`) blocks the install-time build.
- **Everything else is bundled.** `dist/extension.js` must depend on nothing but Node built-ins and
  `vscode`; `node_modules` is not shipped in the `.vsix`.
- `jsonc-parser`'s UMD entry uses a dynamic `require` esbuild can't follow, so `esbuild.js` aliases it
  to the ESM build. The activation smoke test is what catches this kind of breakage.

### 6. Remote Editing Workflow
- Remote files are fetched to `globalStorageUri/cache/<serverId>/<path>`; paths are sanitised through
  `toSafeRelativePath` because remote listings are untrusted input.
- `RemoteFileCache` persists its tracking in `globalState` so it survives a window reload.
- Delete/rename/move must call `fileCache.untrack`/`retrack`, or a later save resurrects or misdirects
  the file. Both are prefix-aware, so passing a directory path covers every tracked file inside it.
- `handleSave` stats the remote file first and prompts before overwriting a changed file or
  re-creating a deleted one.

### 7. Commands, Menus & Errors
- Command handlers are registered in `src/commands/` and wrapped in `guarded()` so a rejection becomes
  a notification rather than an unhandled rejection.
- Commands that require a tree node must be hidden from the Command Palette via a
  `menus.commandPalette` entry with `"when": "false"`.
- `remoteHostExplorer.activeEditorMapped` / `remoteHostExplorer.hasMappings` context keys gate the
  editor-title and Explorer contributions; they are refreshed in `extension.ts`.
- **Multi-select**: the tree uses `canSelectMany`, so context-menu handlers receive
  `(clickedNode, selectedNodes)` and keybindings receive nothing. Always resolve targets with
  `resolveSelection(clicked, selected, treeView.selection)`, and drop children of selected folders with
  `withoutNestedSelections` before acting. Single-item actions (rename, new file, paste target) use
  `!listMultiSelection` in their `when` clause.
- File/directory rows have context values `remoteHostExplorer.{file|directory}.{mapped|unmapped}` (see
  `fileContextValue`). Match them with a regex, never `==`. Actions that need a `localPath` use a
  command `enablement` of `viewItem =~ /\.mapped$/` so they appear greyed out rather than hidden.
- Menus and keybindings for the tree must use tree-specific commands (e.g. `downloadRemoteItem`) rather
  than sharing an Explorer command, because `enablement` applies everywhere a command appears.

### 8. Transfers
- All recursive work lives in `remote/transfer.ts` and runs inside `withTransferProgress`, which
  provides the progress notification and cancellation token. Honour `run.token`.
- `ignoreGlobs` are evaluated relative to the profile's `localPath` and apply to auto-upload and
  recursive transfers, not to an explicitly requested single-file upload.
- `DEFAULT_IGNORE_GLOBS` in `config/serverConfig.ts` is the single source of the defaults (the form and
  `isIgnored` use it; keep the `package.json` schema default in sync). A profile with no `ignoreGlobs`
  field gets the defaults; an explicit `[]` ignores nothing.
- **Downloads never overwrite a local file silently.** Every local write in a download goes through
  `mayWriteLocalFile(run, …)`, which asks Overwrite / Overwrite All / Skip / Skip All and remembers "All"
  answers on the run. Don't call `client.get` onto an existing path without it.
- rsync doesn't know the ignore patterns. Directory uploads via rsync pass an explicit file list
  (`collectUploadFiles` → `--files-from`) built with the extension's own matcher. Never hand rsync a
  whole folder, and don't translate our globs into rsync exclude syntax — the `**` rules differ.

### 9. Tree
- `RemoteTreeProvider` caches node instances; VS Code matches elements by identity, so never hand it a
  freshly constructed equivalent node.
- Prefer `refreshDirectory(server, dir)` over `refresh()` so unrelated expanded folders are not
  re-listed.
- Drag-and-drop and cut/paste both move through `moveRemoteItems` (`remote/moveItems.ts`), which owns
  the no-op, move-into-itself, and replace/skip/cancel conflict rules. Don't reimplement a move loop.

### 10. Webview
- No user or profile data may be interpolated into markup. `media/serverForm.html` is a static
  template with `{{TOKEN}}` placeholders; values reach the page through the JSON bootstrap block.
- CSP: `default-src 'none'`, styles from `webview.cspSource`, scripts by cryptographic nonce only.
