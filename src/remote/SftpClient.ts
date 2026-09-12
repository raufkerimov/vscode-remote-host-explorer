import * as fs from 'fs';
import SftpClientLib from 'ssh2-sftp-client';
import {
	isConnectionLostError,
	isMissingPathError,
	type RemoteClient,
	type RemoteConnectionOptions,
	type RemoteFileEntry,
} from './RemoteClient';
import { joinRemote, normalizeRemote } from '../util/remotePath';

/** Keeps idle sessions alive through NAT/firewall timeouts instead of failing on the next operation. */
const KEEPALIVE_INTERVAL_MS = 20_000;
const READY_TIMEOUT_MS = 15_000;

export class SftpRemoteClient implements RemoteClient {
	private client: SftpClientLib;
	private connected = false;

	constructor(
		private readonly options: RemoteConnectionOptions,
		private readonly onClose?: () => void
	) {
		this.client = this.createClient();
	}

	/**
	 * A failed handshake leaves the underlying ssh2 client unusable, so each attempt gets a fresh
	 * instance. Listeners from a discarded one are harmless: `handleClosed` only acts while connected.
	 */
	private createClient(): SftpClientLib {
		const client = new SftpClientLib();
		client.on('end', () => this.handleClosed());
		client.on('close', () => this.handleClosed());
		client.on('error', () => this.handleClosed());
		return client;
	}

	private handleClosed(): void {
		if (this.connected) {
			this.connected = false;
			this.onClose?.();
		}
	}

	private async readPrivateKey(): Promise<Buffer | undefined> {
		if (!this.options.privateKeyPath) {
			return undefined;
		}
		try {
			// Read asynchronously: a synchronous read here blocks the entire Extension Host.
			return await fs.promises.readFile(this.options.privateKeyPath);
		} catch (err) {
			throw new Error(
				`Could not read the private key at "${this.options.privateKeyPath}": ${(err as Error).message}`
			);
		}
	}

	async connect(): Promise<void> {
		this.connected = false;
		const privateKey = await this.readPrivateKey();
		const policy = this.options.hostKeyPolicy;

		/** Host key the server presented that the policy could not approve without asking the user. */
		let unapprovedKey: Buffer | undefined;

		const attempt = async (): Promise<void> => {
			unapprovedKey = undefined;
			await this.client.end().catch(() => {});
			this.client = this.createClient();

			await this.client.connect({
				host: this.options.host,
				port: this.options.port ?? 22,
				username: this.options.username,
				password: this.options.password,
				privateKey,
				passphrase: this.options.passphrase,
				readyTimeout: READY_TIMEOUT_MS,
				keepaliveInterval: KEEPALIVE_INTERVAL_MS,
				...(policy
					? {
						hostVerifier: (hostKey: Buffer, callback: (accepted: boolean) => void) => {
							// Must answer immediately: `readyTimeout` is running for the whole handshake,
							// so anything needing user input is deferred to the retry below.
							if (policy.isTrusted(hostKey)) {
								callback(true);
								return;
							}
							unapprovedKey = hostKey;
							callback(false);
						},
					}
					: {}),
			});
		};

		try {
			await attempt();
		} catch (err) {
			if (!policy || !unapprovedKey) {
				throw err;
			}
			// Ask outside the handshake, where the user can take as long as they need.
			const accepted = await policy.confirm(unapprovedKey);
			if (!accepted) {
				throw new Error('Host key verification was declined; the connection was not established.');
			}
			// The policy has recorded the key, so the verifier now approves it synchronously.
			await attempt();
		}

		this.connected = true;
	}

	async disconnect(): Promise<void> {
		this.connected = false;
		try {
			await this.client.end();
		} catch {
			// ignore cleanup error
		}
	}

	isConnected(): boolean {
		return this.connected;
	}

	private async wrapOp<T>(operation: () => Promise<T>): Promise<T> {
		try {
			return await operation();
		} catch (err) {
			if (isConnectionLostError(err)) {
				this.handleClosed();
			}
			throw err;
		}
	}

	async list(remotePath: string): Promise<RemoteFileEntry[]> {
		return this.wrapOp(async () => {
			const base = normalizeRemote(remotePath);
			const entries = await this.client.list(base);
			return Promise.all(
				entries.map(async entry => {
					const entryPath = joinRemote(base, entry.name);
					const isSymbolicLink = entry.type === 'l';
					let isDirectory = entry.type === 'd';

					if (isSymbolicLink) {
						// A symlink's own type says nothing about its target. Resolve it so linked
						// directories are expandable in the tree instead of appearing as plain files.
						try {
							const target = await this.client.stat(entryPath);
							isDirectory = target.isDirectory;
						} catch {
							// Broken or unreadable link: leave it presented as a file.
						}
					}

					return {
						name: entry.name,
						path: entryPath,
						isDirectory,
						isSymbolicLink,
						size: entry.size,
						modifiedAt: entry.modifyTime,
					};
				})
			);
		});
	}

	async stat(remotePath: string): Promise<RemoteFileEntry | undefined> {
		return this.wrapOp(async () => {
			try {
				const info = await this.client.stat(remotePath);
				return {
					name: remotePath.split('/').pop() ?? remotePath,
					path: remotePath,
					isDirectory: info.isDirectory,
					isSymbolicLink: info.isSymbolicLink,
					size: info.size,
					modifiedAt: info.modifyTime,
				};
			} catch (err) {
				// Only a genuinely absent path is "no result". Permission and I/O errors must propagate,
				// otherwise callers such as the save-conflict check read them as "nothing to compare".
				if (isMissingPathError(err)) {
					return undefined;
				}
				throw err;
			}
		});
	}

	async exists(remotePath: string): Promise<boolean> {
		return this.wrapOp(async () => Boolean(await this.client.exists(remotePath)));
	}

	async get(remotePath: string, localPath: string): Promise<void> {
		await this.wrapOp(() => this.client.fastGet(remotePath, localPath));
	}

	async put(localPath: string, remotePath: string): Promise<void> {
		await this.wrapOp(() => this.client.fastPut(localPath, remotePath));
	}

	async writeFile(remotePath: string, contents: Buffer): Promise<void> {
		await this.wrapOp(() => this.client.put(contents, remotePath));
	}

	async copy(fromPath: string, toPath: string): Promise<void> {
		await this.wrapOp(async () => {
			// SFTP has no portable server-side copy, so the bytes round-trip through memory. That is still
			// better than staging a local temp file: no disk writes, no temp-name collisions, no cleanup.
			const contents = (await this.client.get(fromPath)) as Buffer;
			await this.client.put(contents, toPath);
		});
	}

	async mkdir(remotePath: string): Promise<void> {
		await this.wrapOp(() => this.client.mkdir(remotePath, true));
	}

	async delete(remotePath: string, isDirectory: boolean): Promise<void> {
		await this.wrapOp(() => (isDirectory ? this.client.rmdir(remotePath, true) : this.client.delete(remotePath)));
	}

	async rename(fromPath: string, toPath: string): Promise<void> {
		await this.wrapOp(() => this.client.rename(fromPath, toPath));
	}
}
