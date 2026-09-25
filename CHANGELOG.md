# Change Log

All notable changes to Remote Host Explorer are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [0.1.8] - 2026-09-25

- **Production servers**: tick **Production server** on a live site. It's shown in red, and uploads,
  saves, deletes, moves, renames, new files, pastes, and permission changes on it ask first.
- **Changed on the server?** An upload now asks before replacing a file that changed on the server
  since you last uploaded or downloaded it, for example a hotfix made there.
- **Sync with Server**: compare a mapped folder with the server, review what's new or changed on each
  side, and upload or download the files you tick.
- **Upload Git Changes to Remote Host...** uploads every added or modified file, from the Source
  Control view or the Command Palette.
- **Status bar**: for a file in a mapped folder, shows where saving uploads to, and turns auto-upload
  on or off per server.
- **Reveal in Remote Hosts** from the Explorer or an editor tab selects the file in the Remote Hosts
  view.
- **From SSH Config...** in the server form fills in host, port, user, and key from `~/.ssh/config`.
- **Change Permissions...** in the Remote Hosts view, for SFTP and for FTP servers that support it.
  File tooltips show the current permissions.
- Copying and backing up large files on the server no longer loads them into memory.
- FTP transfers run on a second connection, so you can keep browsing while a file uploads. Servers
  that allow only one connection keep working as before.
- **Show Transfers** now opens the Transfers panel with the transfer you were notified about selected
  and expanded, and every transfer in the panel can be expanded to its files. It's also available as
  **Remote Host Explorer: Show Transfers** in the Command Palette.
- Right after an update, **Show Transfers** offers to reload the window if VS Code hasn't loaded the
  panel yet, instead of doing nothing.
- **Browse...** for the remote root and mapping folders lists folders alphabetically. Both it and the
  Remote Hosts view ignore letter case and sort numbers by value, so `v2` comes before `v10`.

## [0.1.7] - 2026-09-25

- **Choose the server** when several servers map the same folder (for example dev and prod): Upload to
  Remote Host and Compare with Remote ask which one to use. With a single server nothing changes.
- **Auto-upload on save** now uploads to every server that maps the file and has it turned on. Before,
  only one of them was used.
- **Transfers panel** at the bottom lists each upload, download, and copy file by file, with where it
  came from and where it went. Notifications have a **Show Transfers** button.
- Server rows in the Remote Hosts view no longer shift sideways when another server connects or
  disconnects.

## [0.1.6] - 2026-09-24

- **Several folder mappings per server**: link more than one local folder to server folders, for
  example a theme and a plugin of the same site. Servers from earlier versions keep their mapping.
- **Download to Folder...** in the Remote Hosts view saves files and folders into any folder you pick,
  even when the server has no mapping. Existing files are only replaced if you choose to.
- **Upload to Remote Host** now lives only in the Explorer's context menu, and is greyed out for items
  outside every mapped folder instead of warning afterwards. The editor title bar button is gone.
- **Download to Local** is now only in the Remote Hosts view; it no longer appears in the Explorer.

## [0.1.5] - 2026-09-15

- **Remote mapped folder**: map your local folder to a folder inside the one you browse, for example to
  see a whole WordPress install while uploading and downloading only your theme.
- The private key path now starts as `~/.ssh/id_rsa`, and `~` works in key paths, so a shared
  `remote-hosts.json` points at each person's own key.
- **Duplicate Server...** creates a copy of a server to change, for example the same server with
  different folders. The saved password is reused while the host and login stay the same.
- The Add/Edit Server form uses two columns, connection details and folders side by side, so it fits
  without scrolling. Narrow editors still show one column.

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
