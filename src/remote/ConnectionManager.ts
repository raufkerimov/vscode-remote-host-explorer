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
			this.onDidChangeConnectionEmitter.fire(server.id);
			throw err;
		}

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
		const client = this.clients.get(serverId);
		if (client) {
			this.clients.delete(serverId);
			await client.disconnect().catch(() => {});
			this.onDidChangeConnectionEmitter.fire(serverId);
		}
	}

	isConnected(serverId: string): boolean {
		const client = this.clients.get(serverId);
		return client?.isConnected() ?? false;
	}

	/** Returns the live client only if already connected; never establishes a new connection. */
	getExistingClient(serverId: string): RemoteClient | undefined {
		const client = this.clients.get(serverId);
		return client?.isConnected() ? client : undefined;
	}

	async disposeAll(): Promise<void> {
		const clients = [...this.clients.values()];
		this.clients.clear();
		await Promise.all(clients.map(client => client.disconnect().catch(() => {})));
	}
}
