import { Client as BasicFtpClient, FileType, type FileInfo } from 'basic-ftp';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable, Writable } from 'stream';
import {
	isConnectionLostError,
	type RemoteClient,
	type RemoteConnectionOptions,
	type RemoteFileEntry,
} from './RemoteClient';
import { formatOctal } from '../util/permissions';
import { basenameRemote, dirnameRemote, joinRemote, normalizeRemote } from '../util/remotePath';

export const DEFAULT_FTP_PORT = 21;
/** The port FTPS servers use for implicit TLS, where the connection is encrypted from the first byte. */
export const IMPLICIT_FTPS_PORT = 990;

/** `true` = explicit TLS (AUTH TLS), `'implicit'` = TLS from the start, `false` = plain FTP. */
export type FtpSecurity = boolean | 'implicit';

/** FTPS on port 990 is implicit TLS by convention; every other FTPS port negotiates explicit TLS. */
export function ftpSecurityFor(protocol: 'ftp' | 'ftps', port: number): FtpSecurity {
	if (protocol === 'ftp') {
		return false;
	}
	return port === IMPLICIT_FTPS_PORT ? 'implicit' : true;
}
const TIMEOUT_MS = 30_000;

/** FTP reply code for "file unavailable" — used by servers for both "not found" and "no access". */
const FTP_FILE_UNAVAILABLE = 550;

function isFtpFileUnavailable(error: unknown): boolean {
	return (error as { code?: number } | undefined)?.code === FTP_FILE_UNAVAILABLE;
}

/**
 * FTP / FTPS (explicit or implicit TLS) client backed by `basic-ftp`.
 *
 * Three properties of FTP drive the design:
 * - A control connection runs exactly one command at a time; `basic-ftp` throws if a second task starts.
 *   Every operation therefore goes through a serial queue.
 * - So that browsing isn't stuck behind a long transfer, file contents move over a second connection
 *   with its own queue (`runTransfer`). Many shared hosts limit connections per user; when the second
 *   one is refused, transfers share the first.
 * - Some commands (`ensureDir`, `cd`) change the server-side working directory. Relative paths are
 *   therefore resolved against the directory the server put us in at login, never against the current one.
 */
export class FtpRemoteClient implements RemoteClient {
	private client = new BasicFtpClient(TIMEOUT_MS);
	private connected = false;
	private homeDir = '/';
	private queue: Promise<unknown> = Promise.resolve();
	private transferClient: BasicFtpClient | undefined;
	private transferQueue: Promise<unknown> = Promise.resolve();
	/** Set once the server refused a second connection; transfers then use the main queue. */
	private singleConnectionOnly = false;

	constructor(
		private readonly options: RemoteConnectionOptions,
		private readonly secure: FtpSecurity,
		private readonly onClose?: () => void
	) {}

	private markClosed(): void {
		if (this.connected) {
			this.connected = false;
			this.onClose?.();
		}
	}

	/** Absolute path on the server; relative paths are anchored to the login directory. */
	private resolve(remotePath: string): string {
		return remotePath.startsWith('/') ? normalizeRemote(remotePath) : joinRemote(this.homeDir, remotePath);
	}

	/**
	 * Runs one operation after all previously queued ones. Operations must use the `client` they are given
	 * and must not call other public methods, which would enqueue behind themselves and deadlock.
	 */
	private run<T>(operation: (client: BasicFtpClient) => Promise<T>): Promise<T> {
		const task = this.queue.then(async () => {
			if (!this.isConnected()) {
				this.markClosed();
				throw new Error('Not connected to the FTP server.');
			}
			try {
				return await operation(this.client);
			} catch (err) {
				if (this.client.closed || isConnectionLostError(err)) {
					this.markClosed();
				}
				throw err;
			}
		});
		// Keep the chain alive after a failure so later operations still run.
		this.queue = task.catch(() => undefined);
		return task;
	}

	private accessOptions() {
		return {
			host: this.options.host,
			port: this.options.port ?? DEFAULT_FTP_PORT,
			user: this.options.username,
			password: this.options.password,
			// Certificate verification stays on for both TLS modes: a self-signed certificate is rejected
			// rather than silently trusted.
			secure: this.secure,
		};
	}

	/** The transfer connection, opened on first use; `undefined` when the server won't allow a second one. */
	private async openTransferClient(): Promise<BasicFtpClient | undefined> {
		if (this.transferClient && !this.transferClient.closed) {
			return this.transferClient;
		}
		if (this.singleConnectionOnly) {
			return undefined;
		}
		const client = new BasicFtpClient(TIMEOUT_MS);
		try {
			await client.access(this.accessOptions());
			this.transferClient = client;
			return client;
		} catch {
			client.close();
			this.singleConnectionOnly = true;
			return undefined;
		}
	}

	/**
	 * Like `run`, for moving file contents: on the transfer connection when there is one, so listings on
	 * the main connection don't wait for it. The same rule applies — use only the given `client`.
	 */
	private runTransfer<T>(operation: (client: BasicFtpClient) => Promise<T>): Promise<T> {
		const task = this.transferQueue.then(async () => {
			if (!this.isConnected()) {
				this.markClosed();
				throw new Error('Not connected to the FTP server.');
			}
			const client = await this.openTransferClient();
			if (!client) {
				return this.run(operation);
			}
			try {
				return await operation(client);
			} catch (err) {
				if (client.closed) {
					// Reopened on the next transfer; the main connection is unaffected.
					this.transferClient = undefined;
				}
				throw err;
			}
		});
		this.transferQueue = task.catch(() => undefined);
		return task;
	}

	private closeTransferClient(): void {
		this.transferClient?.close();
		this.transferClient = undefined;
	}

	async connect(): Promise<void> {
		this.connected = false;
		this.client.close();
		this.closeTransferClient();
		this.singleConnectionOnly = false;
		this.client = new BasicFtpClient(TIMEOUT_MS);

		try {
			await this.client.access(this.accessOptions());
			this.homeDir = normalizeRemote(await this.client.pwd()) || '/';
		} catch (err) {
			this.client.close();
			throw err;
		}

		this.connected = true;
	}

	async disconnect(): Promise<void> {
		// An explicit disconnect is not a dropped connection, so `onClose` is intentionally not fired.
		this.connected = false;
		this.client.close();
		this.closeTransferClient();
	}

	isConnected(): boolean {
		return this.connected && !this.client.closed;
	}

	private toEntry(basePath: string, info: FileInfo, isDirectory: boolean): RemoteFileEntry {
		return {
			name: info.name,
			// Keep the caller's path form (relative or absolute) so tree comparisons stay consistent.
			path: joinRemote(basePath, info.name),
			isDirectory,
			isSymbolicLink: info.type === FileType.SymbolicLink,
			size: info.size,
			modifiedAt: info.modifiedAt?.getTime() ?? 0,
			permissions: info.permissions
				? (info.permissions.user << 6) | (info.permissions.group << 3) | info.permissions.world
				: undefined,
		};
	}

	/** Symlinks report no target type over FTP; a successful `CWD` is the portable way to detect a directory. */
	private async isDirectoryLink(client: BasicFtpClient, absolutePath: string): Promise<boolean> {
		try {
			await client.cd(absolutePath);
			return true;
		} catch {
			return false;
		}
	}

	async list(remotePath: string): Promise<RemoteFileEntry[]> {
		return this.run(async client => {
			const infos = (await client.list(this.resolve(remotePath))).filter(
				info => info.name !== '.' && info.name !== '..'
			);
			const entries: RemoteFileEntry[] = [];
			for (const info of infos) {
				const isDirectory = info.type === FileType.SymbolicLink
					? await this.isDirectoryLink(client, joinRemote(this.resolve(remotePath), info.name))
					: info.isDirectory;
				entries.push(this.toEntry(remotePath, info, isDirectory));
			}
			return entries;
		});
	}

	/** FTP has no STAT for arbitrary paths, so the entry is found by listing its parent directory. */
	private async statWith(client: BasicFtpClient, remotePath: string): Promise<RemoteFileEntry | undefined> {
		const absolute = this.resolve(remotePath);
		if (absolute === '/') {
			return { name: '/', path: remotePath, isDirectory: true, size: 0, modifiedAt: 0 };
		}

		let infos: FileInfo[];
		try {
			infos = await client.list(dirnameRemote(absolute));
		} catch (err) {
			// 550 is ambiguous (missing or forbidden); an unlistable parent is treated as "not found".
			if (isFtpFileUnavailable(err)) {
				return undefined;
			}
			throw err;
		}

		const info = infos.find(candidate => candidate.name === basenameRemote(absolute));
		if (!info) {
			return undefined;
		}

		const isDirectory = info.type === FileType.SymbolicLink
			? await this.isDirectoryLink(client, absolute)
			: info.isDirectory;
		const entry = this.toEntry(dirnameRemote(remotePath), info, isDirectory);
		entry.path = remotePath;

		// Plain LIST output often lacks a parseable timestamp; MDTM gives the one the save-conflict check needs.
		if (!isDirectory && entry.modifiedAt === 0) {
			try {
				entry.modifiedAt = (await client.lastMod(absolute)).getTime();
			} catch {
				// Server does not support MDTM; conflict detection degrades to "never conflicts".
			}
		}
		return entry;
	}

	async stat(remotePath: string): Promise<RemoteFileEntry | undefined> {
		return this.run(client => this.statWith(client, remotePath));
	}

	async exists(remotePath: string): Promise<boolean> {
		return this.run(async client => (await this.statWith(client, remotePath)) !== undefined);
	}

	async get(remotePath: string, localPath: string): Promise<void> {
		await this.runTransfer(client => client.downloadTo(localPath, this.resolve(remotePath)));
	}

	async readFile(remotePath: string): Promise<Buffer> {
		return this.run(client => this.readWith(client, remotePath));
	}

	private async readWith(client: BasicFtpClient, remotePath: string): Promise<Buffer> {
		const chunks: Buffer[] = [];
		const sink = new Writable({
			write(chunk: Buffer, _encoding, callback) {
				chunks.push(chunk);
				callback();
			},
		});
		await client.downloadTo(sink, this.resolve(remotePath));
		return Buffer.concat(chunks);
	}

	async put(localPath: string, remotePath: string): Promise<void> {
		await this.runTransfer(client => client.uploadFrom(localPath, this.resolve(remotePath)));
	}

	async writeFile(remotePath: string, contents: Buffer): Promise<void> {
		await this.run(client => client.uploadFrom(Readable.from(contents), this.resolve(remotePath)));
	}

	async copy(fromPath: string, toPath: string): Promise<void> {
		await this.runTransfer(async client => {
			// FTP has no server-side copy, and one connection can't download and upload at the same time.
			// A temporary file keeps a large file out of memory.
			const staging = path.join(os.tmpdir(), `remote-host-explorer-copy-${crypto.randomUUID()}`);
			try {
				await client.downloadTo(staging, this.resolve(fromPath));
				await client.uploadFrom(staging, this.resolve(toPath));
			} finally {
				await fs.promises.rm(staging, { force: true });
			}
		});
	}

	async mkdir(remotePath: string): Promise<void> {
		// ensureDir also changes the working directory; harmless because every path is resolved absolutely.
		await this.run(client => client.ensureDir(this.resolve(remotePath)));
	}

	async delete(remotePath: string, isDirectory: boolean): Promise<void> {
		await this.run(async client => {
			if (isDirectory) {
				await client.removeDir(this.resolve(remotePath));
			} else {
				await client.remove(this.resolve(remotePath));
			}
		});
	}

	async rename(fromPath: string, toPath: string): Promise<void> {
		await this.run(client => client.rename(this.resolve(fromPath), this.resolve(toPath)));
	}

	async chmod(remotePath: string, mode: number): Promise<void> {
		// Not part of the FTP standard; servers that lack it answer with an error, which is shown as is.
		await this.run(client => client.send(`SITE CHMOD ${formatOctal(mode)} ${this.resolve(remotePath)}`));
	}
}
