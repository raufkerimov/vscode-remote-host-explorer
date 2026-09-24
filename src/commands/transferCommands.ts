import * as path from 'path';
import * as vscode from 'vscode';
import { isIgnored, localPathForRemote, resolveServerForLocalPath } from '../config/serverConfig';
import { downloadPath, uploadPath, withTransferProgress, type TransferSummary } from '../remote/transfer';
import { withoutNestedSelections, type FileNode, type TreeNode } from '../tree/RemoteTreeProvider';
import { dirnameRemote, toSafeRelativePath } from '../util/remotePath';
import { guarded, resolveSelection, type CommandServices } from './shared';

const NO_MAPPING_MESSAGE =
	'No server mapping found for this file. Add a folder mapping to a server profile first.';

/** All selected Explorer items, or the active editor when invoked without an Explorer item. */
function localTargets(clicked?: vscode.Uri, selected?: vscode.Uri[]): vscode.Uri[] {
	if (clicked instanceof vscode.Uri) {
		return selected && selected.length > 0 && selected.some(uri => uri.toString() === clicked.toString())
			? selected
			: [clicked];
	}
	const active = vscode.window.activeTextEditor?.document.uri;
	return active ? [active] : [];
}

/** Pairs each local target with its server mapping, dropping targets that no profile maps. */
function withMappings(targets: readonly vscode.Uri[]) {
	return targets.flatMap(uri => {
		const resolution = resolveServerForLocalPath(uri.fsPath);
		return resolution ? [{ uri, resolution }] : [];
	});
}

function summarize(verb: string, summary: TransferSummary, unmapped: number, destination = ''): string {
	const extras = [
		summary.skipped ? `${summary.skipped} ignored` : '',
		summary.keptLocal ? `${summary.keptLocal} existing local file(s) kept` : '',
		unmapped ? `${unmapped} without a local folder mapping` : '',
	].filter(Boolean);
	return `${verb} ${summary.transferred} item(s)${destination}${extras.length ? ` (${extras.join(', ')})` : ''}.`;
}

export function registerTransferCommands(services: CommandServices): vscode.Disposable[] {
	const { context, connections, outputChannel, treeProvider, treeView } = services;

	return [
		vscode.commands.registerCommand(
			'remoteHostExplorer.uploadFile',
			guarded('Upload failed', async (clicked?: vscode.Uri, selected?: vscode.Uri[]) => {
				const targets = localTargets(clicked, selected);
				const mapped = withMappings(targets);
				const unmapped = targets.length - mapped.length;

				if (mapped.length === 0) {
					if (targets.length > 0) {
						vscode.window.showWarningMessage(NO_MAPPING_MESSAGE);
					}
					return;
				}

				const summary = await withTransferProgress(`Uploading ${mapped.length} item(s)`, async run => {
					for (const { uri, resolution } of mapped) {
						await uploadPath(resolution.server, connections, outputChannel, uri.fsPath, resolution.remotePath, run);
					}
				});
				if (!summary) {
					vscode.window.showInformationMessage('Upload cancelled.');
					return;
				}

				vscode.window.showInformationMessage(summarize('Uploaded', summary, unmapped));
				for (const { resolution } of mapped) {
					treeProvider.refreshDirectory(resolution.server, dirnameRemote(resolution.remotePath));
				}
			})
		),

		// Remote Hosts tree: download selected remote items into the server's local folder mapping.
		vscode.commands.registerCommand(
			'remoteHostExplorer.downloadRemoteItem',
			guarded('Download failed', async (clicked?: TreeNode, selected?: TreeNode[]) => {
				const nodes = selectedFileNodes(clicked, selected);
				const mapped = nodes.flatMap(node => {
					const localTarget = localPathForRemote(node.server, node.entry.path);
					return localTarget ? [{ node, localTarget }] : [];
				});
				const unmapped = nodes.length - mapped.length;

				if (mapped.length === 0) {
					if (nodes.length > 0) {
						vscode.window.showWarningMessage(
							'Only items inside one of the server\'s folder mappings can be downloaded to it. Use "Download to Folder..." to save them anywhere else.'
						);
					}
					return;
				}

				const summary = await withTransferProgress(`Downloading ${mapped.length} item(s)`, async run => {
					for (const { node, localTarget } of mapped) {
						const client = await connections.getClient(node.server);
						await downloadPath(node.server, client, node.entry.path, localTarget, node.entry.isDirectory, run);
					}
				});
				if (!summary) {
					vscode.window.showInformationMessage('Download cancelled.');
					return;
				}
				vscode.window.showInformationMessage(summarize('Downloaded', summary, unmapped));
			})
		),

		// Remote Hosts tree: download selected remote items into any folder, mapped or not.
		vscode.commands.registerCommand(
			'remoteHostExplorer.downloadRemoteItemTo',
			guarded('Download failed', async (clicked?: TreeNode, selected?: TreeNode[]) => {
				const nodes = selectedFileNodes(clicked, selected);
				if (nodes.length === 0) {
					return;
				}
				const folder = await pickDownloadFolder(context, nodes.length);
				if (!folder) {
					return;
				}

				const summary = await withTransferProgress(`Downloading ${nodes.length} item(s)`, async run => {
					for (const node of nodes) {
						// Entry names come from the server and are never trusted as path components.
						const name = toSafeRelativePath(node.entry.name);
						if (!name) {
							run.summary.skipped += 1;
							continue;
						}
						const client = await connections.getClient(node.server);
						await downloadPath(node.server, client, node.entry.path, path.join(folder, name), node.entry.isDirectory, run);
					}
				});
				if (!summary) {
					vscode.window.showInformationMessage('Download cancelled.');
					return;
				}
				vscode.window.showInformationMessage(summarize('Downloaded', summary, 0, ` to ${folder}`));
			})
		),
	];

	function selectedFileNodes(clicked: TreeNode | undefined, selected: TreeNode[] | undefined): FileNode[] {
		return withoutNestedSelections(
			resolveSelection(clicked, selected, treeView.selection).filter((node): node is FileNode => node.kind === 'file')
		);
	}
}

const LAST_DOWNLOAD_FOLDER_KEY = 'remoteHostExplorer.lastDownloadFolder';

/** Asks where to download to, starting from the last folder used in this workspace. */
async function pickDownloadFolder(context: vscode.ExtensionContext, count: number): Promise<string | undefined> {
	const last = context.workspaceState.get<string>(LAST_DOWNLOAD_FOLDER_KEY);
	const workspaceFolder = vscode.workspace.workspaceFolders?.find(folder => folder.uri.scheme === 'file')?.uri;
	const picked = await vscode.window.showOpenDialog({
		canSelectFiles: false,
		canSelectFolders: true,
		canSelectMany: false,
		defaultUri: last ? vscode.Uri.file(last) : workspaceFolder,
		openLabel: 'Download Here',
		title: `Download ${count === 1 ? '1 item' : `${count} items`} to`,
	});
	const folder = picked?.[0];
	if (!folder) {
		return undefined;
	}
	if (folder.scheme !== 'file') {
		vscode.window.showWarningMessage('Choose a folder on this computer.');
		return undefined;
	}
	await context.workspaceState.update(LAST_DOWNLOAD_FOLDER_KEY, folder.fsPath);
	return folder.fsPath;
}

/** Uploads a saved document when its server profile has `autoUpload` enabled. */
export async function autoUploadOnSave(
	document: vscode.TextDocument,
	services: CommandServices
): Promise<void> {
	const { connections, outputChannel, treeProvider } = services;
	const resolution = resolveServerForLocalPath(document.uri.fsPath);
	if (!resolution || !resolution.server.autoUpload) {
		return;
	}

	// Unlike an explicit upload, auto-upload is implicit, so ignore patterns apply.
	if (isIgnored(resolution.server, resolution.relativePath)) {
		outputChannel.appendLine(
			`Skipped auto-upload of ${document.uri.fsPath} (matches an ignore pattern).`
		);
		return;
	}

	try {
		const summary = await withTransferProgress(`Auto-uploading to ${resolution.server.name}`, run =>
			uploadPath(
				resolution.server,
				connections,
				outputChannel,
				document.uri.fsPath,
				resolution.remotePath,
				run
			)
		);
		if (!summary) {
			return;
		}
		outputChannel.appendLine(
			`Auto-uploaded ${document.uri.fsPath} -> ${resolution.server.name}:${resolution.remotePath}`
		);
		treeProvider.refreshDirectory(resolution.server, dirnameRemote(resolution.remotePath));
	} catch (err) {
		outputChannel.appendLine(`Auto-upload failed for ${document.uri.fsPath}: ${(err as Error).message}`);
		vscode.window.showErrorMessage(`Auto-upload failed: ${(err as Error).message}`);
	}
}
