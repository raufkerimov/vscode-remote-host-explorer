import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getServerProfile, localPathForRemote, resolveServerForLocalPath, type ServerProfile } from '../config/serverConfig';
import type { TreeNode } from '../tree/RemoteTreeProvider';
import { basenameRemote } from '../util/remotePath';
import { guarded, type CommandServices } from './shared';

/** Scheme of the read-only documents that show a server's copy of a file in a diff. */
export const REMOTE_DOCUMENT_SCHEME = 'remotehostexplorer-remote';

let compareCounter = 0;

/**
 * URI for the server copy of a file. The counter makes every comparison a new document, because VS Code
 * caches provided content per URI and would otherwise keep showing the version fetched the first time.
 */
export function remoteDocumentUri(serverId: string, remotePath: string): vscode.Uri {
	const query = new URLSearchParams({ server: serverId, v: String(++compareCounter) }).toString();
	return vscode.Uri.from({ scheme: REMOTE_DOCUMENT_SCHEME, path: remotePath, query });
}

async function localFileExists(fsPath: string): Promise<boolean> {
	try {
		return (await fs.promises.stat(fsPath)).isFile();
	} catch {
		return false;
	}
}

async function showDiff(server: ServerProfile, remotePath: string, localUri: vscode.Uri): Promise<void> {
	const name = basenameRemote(remotePath);
	await vscode.commands.executeCommand(
		'vscode.diff',
		remoteDocumentUri(server.id, remotePath),
		localUri,
		`${name} (${server.name}) ↔ ${name} (local)`
	);
}

export function registerCompareCommands(services: CommandServices): vscode.Disposable[] {
	const { connections, treeView } = services;

	const provider: vscode.TextDocumentContentProvider = {
		async provideTextDocumentContent(uri) {
			const serverId = new URLSearchParams(uri.query).get('server') ?? '';
			const server = getServerProfile(serverId);
			if (!server) {
				throw new Error('The server for this comparison no longer exists.');
			}
			const client = await connections.getClient(server);
			return (await client.readFile(uri.path)).toString('utf8');
		},
	};

	return [
		vscode.workspace.registerTextDocumentContentProvider(REMOTE_DOCUMENT_SCHEME, provider),

		// Explorer / editor: compare a local file with its counterpart on the mapped server.
		vscode.commands.registerCommand(
			'remoteHostExplorer.compareWithRemote',
			guarded('Compare failed', async (clicked?: vscode.Uri) => {
				const localUri = clicked instanceof vscode.Uri ? clicked : vscode.window.activeTextEditor?.document.uri;
				if (!localUri) {
					return;
				}
				const resolution = resolveServerForLocalPath(localUri.fsPath);
				if (!resolution) {
					vscode.window.showWarningMessage(
						'No server mapping found for this file. Add a "Local mapped folder" to a server profile first.'
					);
					return;
				}
				if (!(await localFileExists(localUri.fsPath))) {
					vscode.window.showWarningMessage('Compare works on files, not folders.');
					return;
				}
				const client = await connections.getClient(resolution.server);
				const remote = await client.stat(resolution.remotePath);
				if (!remote || remote.isDirectory) {
					vscode.window.showWarningMessage(`Not found on the server: ${resolution.remotePath}`);
					return;
				}
				await showDiff(resolution.server, resolution.remotePath, localUri);
			})
		),

		// Remote Hosts tree: compare a remote file with the local copy in the server's mapped folder.
		vscode.commands.registerCommand(
			'remoteHostExplorer.compareRemoteItem',
			guarded('Compare failed', async (clicked?: TreeNode) => {
				const node = clicked ?? treeView.selection[0];
				if (node?.kind !== 'file' || node.entry.isDirectory) {
					return;
				}
				const localPath = localPathForRemote(node.server, node.entry.path);
				if (!localPath) {
					vscode.window.showWarningMessage(
						'Only files inside the server\'s remote mapped folder can be compared. Set a "Local mapped folder" on the server first.'
					);
					return;
				}
				if (!(await localFileExists(localPath))) {
					vscode.window.showWarningMessage(`"${path.basename(localPath)}" doesn't exist in your local folder: ${localPath}`);
					return;
				}
				await showDiff(node.server, node.entry.path, vscode.Uri.file(localPath));
			})
		),
	];
}
