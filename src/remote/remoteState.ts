import type * as vscode from 'vscode';
import { normalizeRemote } from '../util/remotePath';

/** What a file looked like right after this extension last uploaded or downloaded it. */
export interface KnownFileState {
	/** The server's modification time of its copy, as the server reports it. */
	remoteModifiedAt: number;
	/** Local modification time of the local copy at that moment. */
	localModifiedAt: number;
	size: number;
}

/** Stored compactly: `[remoteModifiedAt, localModifiedAt, size, recordedAt]`. */
type StoredState = [number, number, number, number];

const STORAGE_KEY = 'remoteHostExplorer.knownFileStates';
/** Oldest records are dropped beyond this, so the store cannot grow without bound. */
export const MAX_KNOWN_FILES = 20_000;
const PERSIST_DELAY_MS = 1000;

/**
 * Remembers each file's state after a transfer. Comparing against it tells "changed on the server since
 * you last uploaded or downloaded it" apart from "just different clocks": a server stamps an uploaded file
 * with its own time, so comparing server and local timestamps directly would always look newer.
 */
export class KnownFileStates {
	private states = new Map<string, StoredState>();
	private memento: vscode.Memento | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;

	/** Loads persisted states; until then (and in tests) the store lives in memory only. */
	attach(memento: vscode.Memento): void {
		this.memento = memento;
		const stored = memento.get<Record<string, StoredState>>(STORAGE_KEY) ?? {};
		this.states = new Map(Object.entries(stored).filter(([, value]) => Array.isArray(value) && value.length === 4));
	}

	private key(serverId: string, remotePath: string): string {
		return `${serverId}::${normalizeRemote(remotePath)}`;
	}

	get(serverId: string, remotePath: string): KnownFileState | undefined {
		const stored = this.states.get(this.key(serverId, remotePath));
		return stored ? { remoteModifiedAt: stored[0], localModifiedAt: stored[1], size: stored[2] } : undefined;
	}

	set(serverId: string, remotePath: string, state: KnownFileState): void {
		const key = this.key(serverId, remotePath);
		// Re-inserting moves the key to the end, so iteration order is oldest first.
		this.states.delete(key);
		this.states.set(key, [state.remoteModifiedAt, state.localModifiedAt, state.size, Date.now()]);
		for (const oldest of this.states.keys()) {
			if (this.states.size <= MAX_KNOWN_FILES) {
				break;
			}
			this.states.delete(oldest);
		}
		this.schedulePersist();
	}

	private schedulePersist(): void {
		if (!this.memento || this.timer) {
			return;
		}
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.memento?.update(STORAGE_KEY, Object.fromEntries(this.states));
		}, PERSIST_DELAY_MS);
	}

	/** Writes pending changes now; called when the extension deactivates. */
	async flush(): Promise<void> {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
			await this.memento?.update(STORAGE_KEY, Object.fromEntries(this.states));
		}
	}
}

export const knownFileStates = new KnownFileStates();

/**
 * How far a server timestamp may move without counting as a change. FTP listings often only have
 * minute precision, while SFTP reports seconds.
 */
export function timestampTolerance(protocol: string): number {
	return protocol === 'sftp' ? 1000 : 60_000;
}

/** True when the server copy changed since the recorded transfer. Unknown files or times never count. */
export function changedOnServerSince(
	known: KnownFileState | undefined,
	current: { modifiedAt: number; size: number },
	protocol: string
): boolean {
	if (!known || current.modifiedAt === 0 || known.remoteModifiedAt === 0) {
		return false;
	}
	return current.modifiedAt > known.remoteModifiedAt + timestampTolerance(protocol) || current.size !== known.size;
}
