import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ConnectionManager } from '../remote/ConnectionManager';
import type { ServerProfile } from '../config/serverConfig';
import type { RemoteFileEntry } from '../remote/RemoteClient';
import { rsyncUpload } from '../remote/rsyncUpload';
import { remoteLabel } from '../remote/transfer';
import { transferLog } from '../remote/transferLog';
import { confirmProductionChange } from '../config/productionGuard';
import { isSameOrInside, normalizeRemote, toSafeRelativePath } from '../util/remotePath';

const STATE_KEY = 'remoteHostExplorer.trackedRemoteFiles';

interface TrackedFile {
	serverId: string;
	remotePath: string;
	remoteModifiedAt: number;
}

type TrackedFiles = Record<string, TrackedFile>;

/**
 * Downloads remote files into a per-server cache directory and re-uploads them on save, with an mtime
 * conflict check.
 *
 * Tracking is persisted: VS Code restores editors across a window reload, and an untracked cache file
 * would silently become an ordinary local file whose saves go nowhere.
 */
export class RemoteFileCache {
	private trackedFiles: TrackedFiles;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly connections: ConnectionManager,
		private readonly outputChannel: vscode.OutputChannel
	) {
		this.trackedFiles = context.globalState.get<TrackedFiles>(STATE_KEY, {});
	}

	private async persist(): Promise<void> {
		await this.context.globalState.update(STATE_KEY, this.trackedFiles);
	}

	/** Drops entries whose cache file was removed externally, keeping persisted state from growing forever. */
	async pruneMissingFiles(): Promise<void> {
		const survivors: TrackedFiles = {};
		await Promise.all(
			Object.entries(this.trackedFiles).map(async ([cachePath, tracked]) => {
				const stillExists = await fs.promises
					.access(cachePath)
					.then(() => true)
					.catch(() => false);
				if (stillExists) {
					survivors[cachePath] = tracked;
				}
			})
		);
		this.trackedFiles = survivors;
		await this.persist();
	}

	async openRemoteFile(server: ServerProfile, entry: RemoteFileEntry): Promise<void> {
		const client = await this.connections.getClient(server);
		const cachePath = this.getCachePath(server.id, entry.path);
		await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
		await client.get(entry.path, cachePath);

		this.trackedFiles[cachePath] = {
			serverId: server.id,
			remotePath: entry.path,
			remoteModifiedAt: entry.modifiedAt,
		};
		await this.persist();

		const document = await vscode.workspace.openTextDocument(cachePath);
		await vscode.window.showTextDocument(document);
	}

	/**
	 * Stops tracking a remote path and, when it was a directory, everything beneath it — e.g. after a
	 * delete on the server.
	 */
	async untrack(serverId: string, remotePath: string): Promise<void> {
		const removed = normalizeRemote(remotePath);
		let changed = false;
		for (const [cachePath, tracked] of Object.entries(this.trackedFiles)) {
			if (tracked.serverId === serverId && isSameOrInside(removed, tracked.remotePath)) {
				delete this.trackedFiles[cachePath];
				changed = true;
			}
		}
		if (changed) {
			await this.persist();
		}
	}

	/**
	 * Follows a remote rename or move so open editors keep uploading to the right path. Moving a
	 * directory re-points every tracked file inside it.
	 */
	async retrack(serverId: string, fromPath: string, toPath: string): Promise<void> {
		const from = normalizeRemote(fromPath);
		const to = normalizeRemote(toPath);
		let changed = false;
		for (const tracked of Object.values(this.trackedFiles)) {
			const current = normalizeRemote(tracked.remotePath);
			if (tracked.serverId === serverId && isSameOrInside(from, current)) {
				tracked.remotePath = to + current.slice(from.length);
				changed = true;
			}
		}
		if (changed) {
			await this.persist();
		}
	}

	async handleSave(document: vscode.TextDocument, servers: ServerProfile[]): Promise<void> {
		const cachePath = document.uri.fsPath;
		const tracked = this.trackedFiles[cachePath];
		if (!tracked) {
			return;
		}

		const server = servers.find(candidate => candidate.id === tracked.serverId);
		if (!server) {
			// The profile was deleted while the editor stayed open; stop pretending this file is remote.
			await this.untrack(tracked.serverId, tracked.remotePath);
			vscode.window.showWarningMessage(
				`"${path.basename(cachePath)}" is no longer linked to a server profile, so it was not uploaded.`
			);
			return;
		}

		if (!(await confirmProductionChange(server, `Save ${tracked.remotePath}.`, { repeated: true }))) {
			vscode.window.showInformationMessage(`"${path.basename(cachePath)}" was saved locally but not uploaded to ${server.name}.`);
			return;
		}
		const client = await this.connections.getClient(server);
		const current = await client.stat(tracked.remotePath);

		if (!current) {
			// Uploading here would silently re-create a file the user deleted on the server.
			const choice = await vscode.window.showWarningMessage(
				`"${tracked.remotePath}" no longer exists on ${server.name}.`,
				{ modal: true, detail: 'Saving will re-create it on the server.' },
				'Re-create'
			);
			if (choice !== 'Re-create') {
				return;
			}
		} else if (current.modifiedAt > tracked.remoteModifiedAt) {
			const choice = await vscode.window.showWarningMessage(
				`"${tracked.remotePath}" changed on the server since it was opened. Overwrite remote with your local changes?`,
				{ modal: true },
				'Overwrite'
			);
			if (choice !== 'Overwrite') {
				return;
			}
		}

		const record = transferLog.start(`Saving ${path.basename(cachePath)} to ${server.name}`);
		const entry = { from: cachePath, to: remoteLabel(server, tracked.remotePath), localPath: cachePath };
		try {
			if (server.protocol === 'sftp' && server.useRsyncForUpload) {
				await rsyncUpload(
					server,
					{ localPath: cachePath, remotePath: tracked.remotePath, isDirectory: false },
					this.outputChannel
				);
			} else {
				await client.put(cachePath, tracked.remotePath);
			}
		} catch (err) {
			transferLog.add(record, { ...entry, status: 'failed', error: (err as Error).message });
			transferLog.finish(record, 'failed', (err as Error).message);
			throw err;
		}
		transferLog.add(record, { ...entry, status: 'done' });
		transferLog.finish(record, 'done');

		const updated = await client.stat(tracked.remotePath);
		tracked.remoteModifiedAt = updated?.modifiedAt ?? Date.now();
		await this.persist();
		this.outputChannel.appendLine(`Uploaded ${cachePath} -> ${server.name}:${tracked.remotePath}`);
	}

	private getCachePath(serverId: string, remotePath: string): string {
		const cacheRoot = path.join(this.context.globalStorageUri.fsPath, 'cache');
		// Remote paths come from the server and may contain `..` or other traversal attempts.
		const safeServerId = toSafeRelativePath(serverId) || 'unknown-server';
		const safeRemotePath = toSafeRelativePath(remotePath);
		const resolved = path.resolve(cacheRoot, safeServerId, safeRemotePath);

		if (resolved !== cacheRoot && !resolved.startsWith(cacheRoot + path.sep)) {
			throw new Error(`Refusing to cache "${remotePath}" outside the extension cache directory.`);
		}
		return resolved;
	}
}
