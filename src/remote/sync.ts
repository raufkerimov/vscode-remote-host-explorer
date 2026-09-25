import * as fs from 'fs';
import * as path from 'path';
import type * as vscode from 'vscode';
import { isIgnored, mappingRootForLocalPath, type ServerProfile } from '../config/serverConfig';
import type { RemoteClient, RemoteFileEntry } from './RemoteClient';
import { changedOnServerSince, type KnownFileState, type KnownFileStates } from './remoteState';
import { CancelledError } from './transfer';
import { joinRemote, toSafeRelativePath } from '../util/remotePath';

/**
 * How a file differs between a local folder and its server folder:
 * - `localOnly` / `remoteOnly` — exists on one side.
 * - `localChanged` / `remoteChanged` / `bothChanged` — changed since this extension last transferred it.
 * - `differs` — never transferred by this extension, and the sizes differ.
 */
export type SyncStatus = 'localOnly' | 'remoteOnly' | 'localChanged' | 'remoteChanged' | 'bothChanged' | 'differs';

export interface LocalFileState {
	size: number;
	modifiedAt: number;
}

export interface SyncItem {
	/** POSIX path relative to the compared folders. */
	relativePath: string;
	localPath: string;
	remotePath: string;
	status: SyncStatus;
}

/** Local timestamps are exact, but a copy or checkout may round them; one second is still "unchanged". */
const LOCAL_TOLERANCE_MS = 1000;

/**
 * Compares one file's two copies against what was recorded after the last transfer; `undefined` means
 * they match. Files never transferred by this extension can only be compared by size, so equal sizes
 * count as a match. Pure so it can be unit tested.
 */
export function classifySyncItem(
	local: LocalFileState | undefined,
	remote: RemoteFileEntry | undefined,
	known: KnownFileState | undefined,
	protocol: string
): SyncStatus | undefined {
	if (!remote) {
		return local ? 'localOnly' : undefined;
	}
	if (!local) {
		return 'remoteOnly';
	}
	if (!known) {
		return local.size === remote.size ? undefined : 'differs';
	}
	const remoteChanged = changedOnServerSince(known, remote, protocol) || remote.size !== known.size;
	const localChanged = local.modifiedAt > known.localModifiedAt + LOCAL_TOLERANCE_MS || local.size !== known.size;
	if (remoteChanged && localChanged) {
		return 'bothChanged';
	}
	return remoteChanged ? 'remoteChanged' : localChanged ? 'localChanged' : undefined;
}

export interface CompareOptions {
	server: ServerProfile;
	client: RemoteClient;
	localRoot: string;
	remoteRoot: string;
	knownFiles: KnownFileStates;
	token: vscode.CancellationToken;
	/** Reports the folder being read; comparing a large tree over FTP takes a while. */
	onFolder?: (relativePath: string) => void;
}

/**
 * Lists every file that differs between a local folder and a server folder, in path order. Both sides
 * skip what the profile's ignore patterns exclude, and neither follows symbolic links to folders, so a
 * link loop cannot make it run forever.
 */
export async function compareFolders(options: CompareOptions): Promise<SyncItem[]> {
	const { server, client, localRoot, remoteRoot, knownFiles, token } = options;
	// Ignore patterns are relative to the mapping's local folder, even when comparing a folder inside it.
	const ignoreBase = mappingRootForLocalPath(server, localRoot) ?? localRoot;
	const ignored = (relativePath: string) =>
		isIgnored(server, path.relative(ignoreBase, path.join(localRoot, ...relativePath.split('/'))).replace(/\\/g, '/'));
	const throwIfCancelled = () => {
		if (token.isCancellationRequested) {
			throw new CancelledError();
		}
	};

	const localFiles = new Map<string, LocalFileState>();
	const walkLocal = async (relativeDir: string): Promise<void> => {
		throwIfCancelled();
		options.onFolder?.(relativeDir);
		const directory = path.join(localRoot, ...relativeDir.split('/').filter(Boolean));
		let items: fs.Dirent[];
		try {
			items = await fs.promises.readdir(directory, { withFileTypes: true });
		} catch {
			return;
		}
		for (const item of items) {
			const relativePath = relativeDir ? `${relativeDir}/${item.name}` : item.name;
			if (ignored(relativePath)) {
				continue;
			}
			if (item.isDirectory()) {
				await walkLocal(relativePath);
				continue;
			}
			const stats = await fs.promises.stat(path.join(directory, item.name)).catch(() => undefined);
			if (stats?.isFile()) {
				localFiles.set(relativePath, { size: stats.size, modifiedAt: stats.mtimeMs });
			}
		}
	};

	const remoteFiles = new Map<string, RemoteFileEntry>();
	const walkRemote = async (relativeDir: string): Promise<void> => {
		throwIfCancelled();
		options.onFolder?.(relativeDir);
		let entries: RemoteFileEntry[];
		try {
			entries = await client.list(relativeDir ? joinRemote(remoteRoot, relativeDir) : remoteRoot);
		} catch {
			return;
		}
		for (const entry of entries) {
			// Names come from the server; one that isn't a plain name has no safe local counterpart.
			if (toSafeRelativePath(entry.name) !== entry.name) {
				continue;
			}
			const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
			if (ignored(relativePath)) {
				continue;
			}
			if (entry.isDirectory) {
				if (!entry.isSymbolicLink) {
					await walkRemote(relativePath);
				}
				continue;
			}
			remoteFiles.set(relativePath, entry);
		}
	};

	await walkLocal('');
	await walkRemote('');

	const items: SyncItem[] = [];
	for (const relativePath of new Set([...localFiles.keys(), ...remoteFiles.keys()])) {
		const remotePath = joinRemote(remoteRoot, relativePath);
		const status = classifySyncItem(
			localFiles.get(relativePath),
			remoteFiles.get(relativePath),
			knownFiles.get(server.id, remotePath),
			server.protocol
		);
		if (status) {
			items.push({ relativePath, localPath: path.join(localRoot, ...relativePath.split('/')), remotePath, status });
		}
	}
	return items.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}
