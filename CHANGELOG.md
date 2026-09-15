# Change Log

All notable changes to Remote Host Explorer are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [0.1.4] - 2026-09-15

- **New Folder...** in the Remote Hosts view.
- **Compare with Remote** (Explorer and editor tab) and **Compare with Local** (Remote Hosts view) show
  a local file and the server's copy side by side.
- **Drag files and folders** from your file manager or the Explorer onto a remote folder to upload them.
- **Faster folder transfers** over SFTP: up to four files are sent at once.
- **Open SSH Terminal** on an SFTP server or folder, using the existing connection.
- **SSH agent** authentication for SFTP servers.
- **Implicit TLS** for FTPS servers on port 990.
- A connection that drops is re-established the next time you use the server, instead of the server
  showing as disconnected.

## [0.1.3] - 2026-09-15

- **This project only** servers are now saved in `.vscode/remote-hosts.json` instead of
  `.vscode/settings.json`, so you can keep them out of Git without also ignoring your other settings.
  Comments in the file are kept when a server is saved.
- Servers saved by earlier versions are moved automatically, including servers stored under the old
  `remoteHostViewer` name by 0.1.0, together with their saved passwords, trusted host keys, and open
  remote files.

## [0.1.2] - 2026-09-15

- No longer marked as a preview.

## [0.1.1] - 2026-09-14

- Added support for FTP/FTPS

## [0.1.0] - 2026-09-13

First public release, published as a **preview**.

### Servers

- Add, edit, and remove servers in a form, with **Test Connection** and a remote folder browser.
- Connect over **SFTP** (password or private key), **FTPS** (FTP over explicit TLS), or **FTP**.
- **Project or global servers**: keep a server in the open project only, or make it available in
  every window. New servers default to the open project.
- Connect and disconnect explicitly; the tree shows each server's connection state.

### Working with remote files

- Browse remote folders, including symbolic links, in the **Remote Hosts** view.
- Open a remote file in the editor; saving uploads it. If the file changed or was deleted on the
  server since you opened it, you are asked before anything is overwritten.
- Create, rename, delete, copy, paste, and back up files and folders.
- **Multi-select** to act on several items at once.
- **Move** items by drag-and-drop or with **Cut** and **Paste**.
- Shortcuts in the Remote Hosts view: `Cmd/Ctrl+C`, `Cmd/Ctrl+X`, `Cmd/Ctrl+V`, and `Delete`.

### Uploading and downloading

- Map a server to a local folder to upload and download files and whole folders, from the Remote
  Hosts view, the Explorer, or the editor title bar.
- **Upload on save**, per server.
- Downloads ask before replacing a file that already exists on your computer.
- Ignore patterns skip `.git`, `node_modules`, `.vscode`, `.env` files, SSH keys, and certificates by
  default.
- Cancellable progress for long transfers.
- Optional `rsync` over SSH for faster SFTP uploads.

### Security

- Passwords and key passphrases are stored in your operating system's secure credential storage,
  never in settings files.
- SSH host keys are remembered on first connection, with a warning if a server's key ever changes.
- FTPS verifies the server certificate.
- Saved credentials are never sent to a different host, port, user, or protocol than they were saved
  for.
- Runs only in trusted workspaces.
