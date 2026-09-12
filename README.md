# Remote Host Explorer

Browse, edit, upload, and download files on your servers without leaving VS Code — a deployment
workflow in the spirit of PhpStorm's Remote Host tool. Works over **SFTP**, **FTPS**, and **FTP**.

## Features

- **Remote Hosts view** in the Activity Bar: browse server folders, open a file, edit it, and save to
  upload it back.
- **Safe saving**: if a file changed or was deleted on the server since you opened it, you're asked
  before anything is overwritten.
- **File operations**: create, rename, delete, copy, paste, back up, and move — for one item or
  many at once.
- **Upload and download** files and whole folders between your project and the server, including
  **upload on save**.
- **Project or global servers**: each project shows only its own servers, unless you make a server
  available everywhere.
- **Secure by default**: credentials in your system's secure storage, SSH host key checks, and
  certificate checks for FTPS. See [Security](#security).

## Getting started

1. Open your project folder in VS Code. If asked, choose **Trust** — the extension only runs in
   trusted folders.
2. Click the **Remote Host Explorer** icon in the Activity Bar, then **Add Server...**.
3. Fill in the form:
   - **Available in** — *This project only* (default) or *All projects*.
   - **Protocol** — SFTP, FTPS, or FTP; then the host, port, and username.
   - **Authentication** — a password, or for SFTP a private key file.
   - **Remote root path** — the server folder to show. **Browse...** lets you pick it.
   - **Local mapped folder** — optional, but needed for uploading and downloading. Usually your
     project folder.
4. Click **Test Connection**, then **Add Server**.
5. Click the plug icon next to the server to connect, then expand it to browse.

The first time you connect to an SFTP server, VS Code shows the server's key fingerprint. Accept it if
it matches what your hosting provider or administrator gives you.

## Using the Remote Hosts view

- **Open a file** by clicking it. Saving uploads your changes.
- **Right-click** a file, folder, or server for all actions.
- **Select several items** with `Cmd`-click / `Ctrl`-click or `Shift`-click to delete, copy, back up, or
  download them together.
- **Move items** by dragging them onto a folder, or with **Cut** then **Paste**.
- **Keyboard shortcuts** (while the view is focused):

  | Action | Windows / Linux | macOS |
  | --- | --- | --- |
  | Copy | `Ctrl+C` | `Cmd+C` |
  | Cut | `Ctrl+X` | `Cmd+X` |
  | Paste | `Ctrl+V` | `Cmd+V` |
  | Delete | `Delete` | `Cmd+Backspace` |

- **Create Backup** makes a timestamped copy next to the file, such as `index_2026-09-13_142501.php`.

## Uploading and downloading

Uploading and downloading need a **Local mapped folder** on the server. It links a folder on your
computer to the server's remote root, so `my-project/app/index.php` maps to `/var/www/app/index.php`.

- **Upload**: right-click files or folders in the Explorer and choose **Upload to Remote Host**, or use
  the cloud icon in the editor title bar (shown for files inside a mapped folder).
- **Upload on save**: turn on **Auto-upload on save** for the server.
- **Download**: right-click items in the Remote Hosts view, or files in the Explorer, and choose
  **Download to Local**. For servers without a local folder, this action is greyed out.
- **Existing local files are never replaced silently.** If a download would overwrite a file on your
  computer, you choose **Overwrite**, **Skip**, or apply either to all remaining files.
- **Large transfers** show progress and can be cancelled.

### Ignore patterns

Ignore patterns keep files from being uploaded on save or included in folder uploads and downloads.
New servers start with:

```text
**/.git/**        **/node_modules/**   **/.vscode/**
**/.env           **/.env.*            **/.ssh/**
**/*.pem          **/*.key
```

These keep version control data, dependencies, editor settings, environment files, and keys off your
server. Edit them in the server form, one pattern per line. `*` matches within a folder name, `**`
matches any number of folders, and `?` matches one character.

A file you upload explicitly — by right-clicking it — is uploaded even if it matches a pattern.

### Faster uploads with rsync (SFTP only)

Turn on **Use rsync for uploads** to upload with `rsync` over SSH, which is faster for many files.
Browsing and downloading still use SFTP. This is the only feature that needs extra software on your
computer:

| | Windows | macOS | Linux |
| --- | --- | --- | --- |
| `rsync` | Install via WSL, Git for Windows, MSYS2, or Cygwin | Included; newer via `brew install rsync` | Usually included; else `apt install rsync` |
| `ssh` | Included in Windows 10 and later | Included | Usually included; else `apt install openssh-client` |

rsync can't answer password prompts, so the server must accept your SSH key without one.

## Project and global servers

| Available in | Saved in | Appears |
| --- | --- | --- |
| **This project only** | The project's `.vscode/remote-hosts.json` | Only when that project is open |
| **All projects** | Your VS Code user settings | In every window, marked `global` |

To change a server's scope, edit it and change **Available in**. Hover over a server to see its scope
and local folder.

`.vscode/remote-hosts.json` contains server names, hosts, usernames, and paths — never passwords. If
you commit it, teammates get the same server list and enter their own credentials. If you don't want
that, add `.vscode/remote-hosts.json` to `.gitignore`. Your other VS Code settings stay unaffected.

If several folders are open, a new server is saved in the folder that contains its local mapped
folder, or in the first folder otherwise.

Servers saved by earlier versions in `.vscode/settings.json`, a `.code-workspace` file, or the old
`remoteHostViewer.servers` setting are moved to their new place automatically, together with their
saved passwords.

## Security

- **Passwords and key passphrases** are stored in your operating system's secure credential storage
  (macOS Keychain, Windows Credential Manager, or the Linux keyring). They are never written to
  settings files and never synced by Settings Sync. Removing a server deletes them.
- **Private keys** stay where they are. Only the file's path is saved; the key is read when you
  connect and is never copied or uploaded.
- **SSH host keys** are remembered the first time you connect. If a server's key later changes, you
  get a prominent warning, because that can mean the connection is being intercepted.
- **FTPS** checks the server's TLS certificate and refuses invalid or self-signed ones.
- **FTP** sends your password and files **unencrypted**. The form warns you when you select it. Use
  SFTP or FTPS whenever the server supports them.
- **Saved credentials stay with their server.** If you change the protocol, host, port, or username in
  the form, the saved password is not used — you'll need to enter it again.
- **Trusted folders only.** The extension is disabled in Restricted Mode, because a project's
  `.vscode/remote-hosts.json` can define servers and upload destinations.
- **What can leave your computer:**
  - With Settings Sync on, **All projects** servers sync to your account — names, hosts, usernames,
    and paths, but never credentials.
  - If you commit `.vscode/remote-hosts.json`, **This project only** servers are shared with your
    repository.
- **Local copies**: files you open from a server are downloaded to VS Code's storage for this
  extension so you can edit them. They stay on your computer until you remove them.

## Settings reference

**All projects** servers are saved in the `remoteHostExplorer.servers` user setting, and **This project
only** servers in the project's `.vscode/remote-hosts.json`:

```jsonc
{
  "servers": [
    { "id": "staging", "name": "Staging", "protocol": "sftp", "host": "staging.example.com", "remoteRoot": "/var/www" }
  ]
}
```

Using the form is recommended; you can also edit the JSON directly, and VS Code suggests the fields as
you type. Each server needs a unique `id`, which its saved password is linked to.

| Field | Description |
| --- | --- |
| `name` | Name shown in the Remote Hosts view. |
| `protocol` | `sftp`, `ftps`, or `ftp`. |
| `host`, `port` | Server address. The port defaults to `22` for SFTP and `21` for FTP and FTPS. |
| `username` | Login name. |
| `privateKeyPath` | SFTP only. Path to a private key file; when set, key authentication is used. |
| `remoteRoot` | Server folder shown as the root. |
| `localPath` | Local folder linked to `remoteRoot`. Needed for uploads and downloads. |
| `autoUpload` | Upload files in `localPath` when you save them. |
| `ignoreGlobs` | Patterns to skip. If omitted, the defaults above apply. Use `[]` to skip nothing. |
| `useRsyncForUpload` | SFTP only. Upload with `rsync` over SSH. |
| `rsyncOptions` | Extra `rsync` options, one per line in the form. |

Passwords and passphrases are not settings; enter them in the form.

## Troubleshooting

Details of every upload and error are written to **View → Output → Remote Host Explorer**.

**The Remote Hosts view is empty or does nothing.**
Make sure the folder is trusted: run **Workspaces: Manage Workspace Trust** from the Command Palette.

**"Couldn't read .vscode/remote-hosts.json in "…": …"**
The file isn't valid JSON, so its servers aren't shown. The message names the problem and its line.
Until it is fixed, saving a server to that project fails with ".vscode/remote-hosts.json in "…" can't
be read" — the extension won't overwrite a file it can't read.

**"Couldn't move saved servers to their new location: …"**
Servers from an earlier version couldn't be moved into `.vscode/remote-hosts.json`, often because that
file can't be read. They stay where they were, so nothing is lost; fix the problem and reload the window.

**A server I added in another project doesn't show up.**
It was saved as *This project only*. Open that project, edit the server, and set **Available in** to
**All projects**.

**"The authenticity of host … can't be established."**
Normal the first time you connect to an SFTP server. Compare the fingerprint with the one from your
hosting provider, then choose **Connect and Remember**.

**"REMOTE HOST IDENTIFICATION HAS CHANGED"**
The server presented a different key than last time. If your provider rebuilt or migrated the server,
choose **Trust the New Key**. If you don't know why it changed, don't connect — ask your provider.

**FTPS fails with "self-signed certificate".**
The server's certificate isn't trusted, so the connection is refused on purpose. Use SFTP if the
server supports it, or ask your hosting provider for a valid certificate.

**"Could not read the private key at …"**
Check that the path in **Private key path** exists and that your user can read the file.

**"Download to Local" is greyed out.**
The server has no local folder. Edit the server and set **Local mapped folder**.

**The upload icon isn't in the editor title bar.**
It appears only for files inside a server's local mapped folder.

**A file wasn't uploaded on save.**
Check that **Auto-upload on save** is on for the server, the file is inside its local folder, and it
doesn't match an ignore pattern. The Output panel records skipped files.

**"rsync was not found on PATH" or "rsync exited with code …"**
Install `rsync` (see the table above), or turn off **Use rsync for uploads**. For exit errors, check
that `ssh` can log in to the server with your key without asking for a password.

## Requirements

- VS Code **1.90** or later.
- Windows, macOS, or Linux.
- Access to an SFTP, FTPS, or FTP server.
- Everything else is built into the extension; only the optional rsync feature needs extra software.

## Known limitations

- A few operations aren't available yet:
  - Comparing local and remote files.
  - Syncing a whole folder.
  - Changing file permissions.
  - Copying or moving between two different servers.
- SSH agents (ssh-agent, Pageant) and `~/.ssh/config` host aliases aren't used yet; enter the host
  and key file directly.
- FTPS supports explicit TLS only (usually port 21), not implicit TLS on port 990.
- Some FTP servers don't report when a file was modified. With those, the extension can't warn you
  that a file changed on the server before you save over it.
- On FTP, browsing waits while a transfer is running.
- Very large files are held in memory while being copied or backed up on the server.
- Rename uses an input box rather than editing the name in place.
- In Remote-SSH, WSL, and Dev Container windows, the extension runs on your own computer, so
  **Local mapped folder** refers to a folder on your computer.

## License

[MIT](LICENSE)
