import { spawn } from 'child_process';
import type * as vscode from 'vscode';
import type { ServerProfile } from '../config/serverConfig';
import { expandHome } from '../util/localPath';

export interface RsyncUploadOptions {
	localPath: string;
	remotePath: string;
	/** Directories must be transferred as "contents of", not "this folder into". */
	isDirectory: boolean;
	/**
	 * Directory uploads only: a file listing the paths (relative to `localPath`) to send. rsync knows
	 * nothing about the profile's ignore patterns, so the list is built with the extension's own
	 * matcher and rsync is told to send exactly those files.
	 */
	filesFrom?: string;
}

/** rsync re-splits the `-e` string on whitespace but honours shell quoting, so every argument is quoted. */
function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Guards against a host/username/path that begins with `-` being read as an rsync or ssh flag. */
function assertNotOptionLike(label: string, value: string): void {
	if (value.startsWith('-')) {
		throw new Error(`${label} must not start with "-" (got "${value}").`);
	}
}

export function buildRsyncArgs(server: ServerProfile, options: RsyncUploadOptions): string[] {
	assertNotOptionLike('Host', server.host);
	if (server.username) {
		assertNotOptionLike('Username', server.username);
	}

	const sshCommand = ['ssh'];
	if (server.port) {
		sshCommand.push('-p', String(server.port));
	}
	if (server.privateKeyPath) {
		// Quoting stops the shell-less `-e` parsing from expanding `~`, so expand it here.
		sshCommand.push('-i', shellQuote(expandHome(server.privateKeyPath)));
	}
	// Never let ssh block on an interactive prompt: rsync runs detached from any terminal, so a host-key
	// or password prompt would hang the transfer forever instead of failing.
	sshCommand.push('-o', 'BatchMode=yes');

	// `rsync -a src dest` creates `dest/src` for a directory source; a trailing slash means "the contents
	// of src", which is what a path mapping implies.
	const source = options.isDirectory ? options.localPath.replace(/[/\\]+$/, '') + '/' : options.localPath;
	const destination = `${server.username ? server.username + '@' : ''}${server.host}:${options.remotePath}`;

	return [
		'-az',
		...(server.rsyncOptions ?? []),
		'-e',
		sshCommand.join(' '),
		...(options.isDirectory && options.filesFrom ? [`--files-from=${options.filesFrom}`] : []),
		// `--` stops flag parsing so a path starting with `-` is treated as a path.
		'--',
		source,
		destination,
	];
}

/**
 * rsync is the one feature that depends on software the user must install themselves, so a missing
 * binary gets a platform-specific explanation rather than a bare ENOENT.
 */
export function missingRsyncMessage(platform: NodeJS.Platform = process.platform): string {
	const fallback = 'Alternatively, turn off "Use rsync for uploads" on the server profile to upload over SFTP instead.';
	switch (platform) {
		case 'win32':
			return `"rsync" was not found on PATH. Windows does not ship it: install it through WSL, Git for Windows, MSYS2, or Cygwin, and make sure both "rsync" and "ssh" are on PATH. ${fallback}`;
		case 'darwin':
			return `"rsync" was not found on PATH. macOS normally provides /usr/bin/rsync; if it is missing, install it with Homebrew ("brew install rsync"). ${fallback}`;
		default:
			return `"rsync" was not found on PATH. Install it with your package manager (for example "apt install rsync" or "dnf install rsync"). ${fallback}`;
	}
}

/** Uploads a single file/folder via `rsync` over ssh, using the server's own host/port/key for transport. */
export function rsyncUpload(
	server: ServerProfile,
	options: RsyncUploadOptions,
	outputChannel: vscode.OutputChannel,
	token?: vscode.CancellationToken
): Promise<void> {
	const args = buildRsyncArgs(server, options);

	return new Promise((resolve, reject) => {
		const proc = spawn('rsync', args);
		outputChannel.appendLine(`$ rsync ${args.join(' ')}`);

		const cancellation = token?.onCancellationRequested(() => proc.kill('SIGTERM'));
		const finish = (finalize: () => void) => {
			cancellation?.dispose();
			finalize();
		};

		proc.stdout.on('data', (data: Buffer) => outputChannel.append(data.toString()));
		proc.stderr.on('data', (data: Buffer) => outputChannel.append(data.toString()));

		proc.on('error', (err: NodeJS.ErrnoException) => {
			finish(() =>
				reject(
					new Error(
						err.code === 'ENOENT' ? missingRsyncMessage() : `Failed to start rsync: ${err.message}`
					)
				)
			);
		});
		proc.on('close', (code, signal) => {
			finish(() => {
				if (code === 0) {
					resolve();
				} else if (signal) {
					reject(new Error(`rsync was cancelled (${signal}).`));
				} else {
					reject(new Error(`rsync exited with code ${code}. See the Remote Host Explorer output for details.`));
				}
			});
		});
	});
}
