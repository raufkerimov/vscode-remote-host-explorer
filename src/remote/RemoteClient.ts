export interface RemoteFileEntry {
	name: string;
	path: string;
	isDirectory: boolean;
	/** True when the entry is a symlink; `isDirectory` then reflects what it points at. */
	isSymbolicLink?: boolean;
	size: number;
	modifiedAt: number;
}

export interface RemoteClient {
	connect(): Promise<void>;
	disconnect(): Promise<void>;
	isConnected(): boolean;
	list(remotePath: string): Promise<RemoteFileEntry[]>;
	/** Resolves to `undefined` only when the path does not exist; other failures reject. */
	stat(remotePath: string): Promise<RemoteFileEntry | undefined>;
	exists(remotePath: string): Promise<boolean>;
	get(remotePath: string, localPath: string): Promise<void>;
	put(localPath: string, remotePath: string): Promise<void>;
	/** Writes in-memory contents directly, without staging a local temp file. */
	writeFile(remotePath: string, contents: Buffer): Promise<void>;
	/** Copies one remote file to another remote path on the same connection. */
	copy(fromPath: string, toPath: string): Promise<void>;
	mkdir(remotePath: string): Promise<void>;
	delete(remotePath: string, isDirectory: boolean): Promise<void>;
	rename(fromPath: string, toPath: string): Promise<void>;
}

export interface HostKeyPolicy {
	/** Synchronous, runs inside the handshake: is this exact key already trusted? */
	isTrusted(hostKey: Buffer): boolean;
	/** Runs outside the handshake: ask the user, and persist the decision when accepted. */
	confirm(hostKey: Buffer): Promise<boolean>;
}

export interface RemoteConnectionOptions {
	host: string;
	port?: number;
	username?: string;
	password?: string;
	privateKeyPath?: string;
	passphrase?: string;
	/**
	 * Two-phase host key verification. Omitting it disables verification entirely, which ssh2 would
	 * otherwise do silently.
	 *
	 * The split exists because ssh2's `readyTimeout` keeps running throughout the handshake: asking the
	 * user inside the verifier would let a slow answer time the connection out. So the in-handshake
	 * check is synchronous, and anything it cannot approve is confirmed afterwards and retried.
	 */
	hostKeyPolicy?: HostKeyPolicy;
}

/**
 * Recognises the assorted ways ssh2 reports a connection that is no longer usable, so callers can drop
 * the pooled client instead of retrying against a dead channel.
 */
export function isConnectionLostError(error: unknown): boolean {
	const message = String((error as Error)?.message || '');
	return (
		message.includes('close') ||
		message.includes('closed') ||
		message.includes('ended') ||
		message.includes('No SFTP') ||
		message.includes('Not connected') ||
		message.includes('timed out') ||
		message.includes('ECONNRESET')
	);
}

/** ssh2/sftp reports a missing path as code 2 (SSH_FX_NO_SUCH_FILE) or a `No such file` message. */
export function isMissingPathError(error: unknown): boolean {
	const candidate = error as { code?: number | string; message?: string } | undefined;
	if (candidate?.code === 2 || candidate?.code === 'ENOENT') {
		return true;
	}
	const message = String(candidate?.message || '');
	return message.includes('No such file') || message.includes('no such file');
}
