import * as vscode from 'vscode';
import type { ServerProfile } from '../config/serverConfig';
import type { SecretsManager } from '../config/secrets';
import { createRemoteClient } from './clientFactory';
import type { HostKeyStore } from './hostKeys';
import type { RemoteClient } from './RemoteClient';

/** Keeps one live connection per server so tree browsing, editing, and uploads share the same session. */
export class ConnectionManager {
	private readonly clients = new Map<string, RemoteClient>();
	/** In-flight connection attempts, so concurrent callers share one handshake instead of racing. */
	private readonly pending = new Map<string, Promise<RemoteClient>>();
	/**
	 * Servers connected and not explicitly disconnected. When such a connection drops (network change,
	 * server idle timeout), the tree keeps the server open and reconnects the next time it is used.
	 */
	private readonly sessions = new Set<string>();
	private readonly onDidChangeConnectionEmitter = new vscode.EventEmitter<string>();
	/** Fires with the server id whenever a connection is established or torn down, from any code path. */
	readonly onDidChangeConnection = this.onDidChangeConnectionEmitter.event;

	constructor(
		private readonly secrets: SecretsManager,
		private readonly hostKeys: HostKeyStore
	) {}

	async getClient(server: ServerProfile): Promise<RemoteClient> {
		const existing = this.clients.get(server.id);
		if (existing?.isConnected()) {
			return existing;
		}

		// Without this, a tree expansion and an upload-on-save firing together would each build their own
		// client; the second would overwrite the first in the map and leak its connection.
		const inFlight = this.pending.get(server.id);
		if (inFlight) {
			return inFlight;
		}

		const attempt = this.establish(server).finally(() => this.pending.delete(server.id));
		this.pending.set(server.id, attempt);
		return attempt;
	}

	private async establish(server: ServerProfile): Promise<RemoteClient> {
		const stale = this.clients.get(server.id);
		if (stale) {
			this.clients.delete(server.id);
			await stale.disconnect().catch(() => {});
		}

		const client = await createRemoteClient(server, this.secrets, this.hostKeys, () =>
			this.handleClientClosed(server.id)
		);

		try {
			await client.connect();
		} catch (err) {
			// A failed reconnect ends the session. Otherwise the tree would refresh, try again, fail, and
			// refresh again in a loop of error messages.
			this.sessions.delete(server.id);
			this.onDidChangeConnectionEmitter.fire(server.id);
			throw err;
		}

		this.sessions.add(server.id);
		this.clients.set(server.id, client);
		this.onDidChangeConnectionEmitter.fire(server.id);
		return client;
	}

	private handleClientClosed(serverId: string): void {
		if (this.clients.has(serverId)) {
			this.clients.delete(serverId);
			this.onDidChangeConnectionEmitter.fire(serverId);
		}
	}

	async disconnect(serverId: string): Promise<void> {
		const hadSession = this.sessions.delete(serverId);
		const client = this.clients.get(serverId);
		if (client) {
			this.clients.delete(serverId);
			await client.disconnect().catch(() => {});
		}
		if (client || hadSession) {
			this.onDidChangeConnectionEmitter.fire(serverId);
		}
	}

	isConnected(serverId: string): boolean {
		const client = this.clients.get(serverId);
		return client?.isConnected() ?? false;
	}

	/** True when the server was connected and not disconnected, even if the connection has since dropped. */
	hasSession(serverId: string): boolean {
		return this.sessions.has(serverId);
	}

	/**
	 * The client for a server the user is working with: the live one, or a fresh one when the session's
	 * connection dropped. `undefined` for a server that was never connected, so browsing never opens a
	 * connection the user didn't ask for.
	 */
	async getSessionClient(server: ServerProfile): Promise<RemoteClient | undefined> {
		const existing = this.getExistingClient(server.id);
		if (existing) {
			return existing;
		}
		return this.sessions.has(server.id) ? this.getClient(server) : undefined;
	}

	/** Returns the live client only if already connected; never establishes a new connection. */
	getExistingClient(serverId: string): RemoteClient | undefined {
		const client = this.clients.get(serverId);
		return client?.isConnected() ? client : undefined;
	}

	async disposeAll(): Promise<void> {
		const clients = [...this.clients.values()];
		this.clients.clear();
		this.sessions.clear();
		await Promise.all(clients.map(client => client.disconnect().catch(() => {})));
	}
}
