# AGENTS.md — Instructions for AI Coding Agents

> **IMPORTANT**: Please refer to [CLAUDE.md](./CLAUDE.md) for full project architecture, build commands, directory structure, coding conventions, and safety guidelines for this repository.

## Instructions for AI Agents
- Always consult [CLAUDE.md](./CLAUDE.md) before making structural changes or adding new dependencies.
- Ensure `npm run compile` (which runs `tsc --noEmit`, `eslint src`, and `esbuild.js`) passes cleanly with zero errors after any code edits, and run `npm test` for anything touching path handling, globs, or rsync arguments.
- Never store passwords or secrets in `settings.json` — use `SecretsManager` (`SecretStorage`).
- Never write a secret into webview state, and never interpolate profile data into webview markup.
- Do not enable build scripts or native compilation for `cpu-features` or `ssh2`; leave `.npmrc`'s `ignore-scripts=true` in place.
- Keep `dist/extension.js` self-contained: it must require nothing beyond Node built-ins and `vscode`, because `node_modules` is not shipped in the `.vsix`.
- Remember that `ignore-scripts=true` disables npm `pre`/`post` hooks — chain build steps explicitly in `package.json`.
- Real SFTP sessions must always pass a `verifyHostKey` callback; do not disable host key verification.
