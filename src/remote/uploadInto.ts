import * as path from 'path';
import * as vscode from 'vscode';
import type { ServerProfile } from '../config/serverConfig';
import { confirmProductionChange } from '../config/productionGuard';
import type { ConnectionManager } from './ConnectionManager';
import { promptForConflict } from './moveItems';
import { compareEntries, type RemoteClient } from './RemoteClient';
import { CancelledError, uploadPath, withTransferProgress } from './transfer';
import { notifyTransfer } from './transferLog';
import { dirnameRemote, joinRemote, normalizeRemote } from '../util/remotePath';

/**
 * Uploads local files and folders into one remote folder under their own names, with no folder mapping
 * involved: drops on the tree, Upload Here..., and Explorer uploads of unmapped items. An existing item
 * on the server is only replaced after Replace or Skip.
 */
export async function uploadIntoFolder(
	server: ServerProfile,
	connections: ConnectionManager,
	outputChannel: vscode.OutputChannel,
	localPaths: readonly string[],
	targetDir: string
): Promise<void> {
	if (!(await confirmProductionChange(server, `Upload ${localPaths.length} item(s) to ${targetDir}.`))) {
		return;
	}
	// An explicit request, so it may open a connection the tree doesn't have yet.
	const client = await connections.getClient(server);
	const summary = await withTransferProgress(`Uploading ${localPaths.length} item(s) to ${server.name}`, async run => {
		// Every existing item below is confirmed with Replace or Skip, so a second question about
		// server changes would only repeat it.
		run.remoteConflicts = 'overwrite';
		for (const localPath of localPaths) {
			const name = path.basename(localPath);
			const remotePath = joinRemote(targetDir, name);
			const existing = await client.stat(remotePath);
			if (existing) {
				const decision = await promptForConflict(
					name,
					targetDir,
					existing.isDirectory
						? 'Files with the same names inside it will be replaced; other files on the server are kept.'
						: 'Uploading replaces the file on the server.'
				);
				if (decision === 'cancel') {
					throw new CancelledError();
				}
				if (decision === 'skip') {
					run.summary.skipped += 1;
					continue;
				}
			}
			await uploadPath(server, connections, outputChannel, localPath, remotePath, run);
		}
	});
	if (!summary) {
		vscode.window.showInformationMessage('Upload cancelled.');
		return;
	}
	const skipped = summary.skipped ? ` (${summary.skipped} skipped)` : '';
	void notifyTransfer(`Uploaded ${summary.transferred} item(s) to ${targetDir}${skipped}.`);
}

/**
 * Lets the user walk the server's folders from `start` and choose one to upload into; `undefined` when
 * dismissed. Folder names come from the server and are only shown, never used as local paths.
 */
export async function pickRemoteFolder(client: RemoteClient, start: string, title: string): Promise<string | undefined> {
	let current = normalizeRemote(start) || '/';
	for (;;) {
		const directory = current;
		const items = client.list(directory).then(entries => {
			const folders = entries
				.filter(entry => entry.isDirectory && entry.name !== '.' && entry.name !== '..')
				.sort(compareEntries);
			return [
				{ label: '$(cloud-upload) Upload Here', description: directory, path: directory, choose: true },
				...(directory !== '/' ? [{ label: '$(arrow-up) ..', description: '', path: dirnameRemote(directory), choose: false }] : []),
				...folders.map(folder => ({ label: `$(folder) ${folder.name}`, description: '', path: folder.path, choose: false })),
			];
		});
		const picked = await vscode.window.showQuickPick(items, { title, placeHolder: directory });
		if (!picked) {
			return undefined;
		}
		if (picked.choose) {
			return directory;
		}
		current = normalizeRemote(picked.path);
	}
}
