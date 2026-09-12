import * as path from 'path';
import * as vscode from 'vscode';
import { isIgnored, resolveServerForLocalPath, type ServerProfile } from '../config/serverConfig';
import { downloadPath, uploadPath, withTransferProgress, type TransferSummary } from '../remote/transfer';
import { withoutNestedSelections, type FileNode, type TreeNode } from '../tree/RemoteTreeProvider';
import { dirnameRemote, normalizeRemote, toSafeRelativePath } from '../util/remotePath';
import { guarded, resolveSelection, type CommandServices } from './shared';

const NO_MAPPING_MESSAGE =
	'No server mapping found for this file. Add a "Local mapped folder" to a server profile first.';

/** Local destination for a tree download, derived from the server's path mapping. */
function localTargetFor(server: ServerProfile, remotePath: string): string | undefined {
	if (!server.localPath) {
		return undefined;
	}
	const root = normalizeRemote(server.remoteRoot);
	const normalized = normalizeRemote(remotePath);
	const relative = normalized === root ? '' : normalized.slice(root === '/' ? 1 : root.length + 1);
	return relative ? path.join(server.localPath, toSafeRelativePath(relative)) : server.localPath;
}

/** Explorer/editor targets: all selected Explorer items, or the active editor when invoked elsewhere. */
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

function summarize(verb: string, summary: TransferSummary, unmapped: number): string {
	const extras = [
		summary.skipped ? `${summary.skipped} ignored` : '',
		summary.keptLocal ? `${summary.keptLocal} existing local file(s) kept` : '',
		unmapped ? `${unmapped} without a local folder mapping` : '',
	].filter(Boolean);
	return `${verb} ${summary.transferred} item(s)${extras.length ? ` (${extras.join(', ')})` : ''}.`;
}

export function registerTransferCommands(services: CommandServices): vscode.Disposable[] {
	const { connections, outputChannel, treeProvider, treeView } = services;

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

		// Explorer / editor: download the remote counterpart of local files.
		vscode.commands.registerCommand(
			'remoteHostExplorer.downloadFile',
			guarded('Download failed', async (clicked?: vscode.Uri, selected?: vscode.Uri[]) => {
				const targets = localTargets(clicked, selected);
				const resolved = withMappings(targets);
				const unmapped = targets.length - resolved.length;

				if (resolved.length === 0) {
					if (targets.length > 0) {
						vscode.window.showWarningMessage(NO_MAPPING_MESSAGE);
					}
					return;
				}

				const missing: string[] = [];
				const summary = await withTransferProgress(`Downloading ${resolved.length} item(s)`, async run => {
					for (const { uri, resolution } of resolved) {
						const client = await connections.getClient(resolution.server);
						const remoteInfo = await client.stat(resolution.remotePath);
						if (!remoteInfo) {
							missing.push(resolution.remotePath);
							continue;
						}
						await downloadPath(resolution.server, client, resolution.remotePath, uri.fsPath, remoteInfo.isDirectory, run);
					}
				});
				if (!summary) {
					vscode.window.showInformationMessage('Download cancelled.');
					return;
				}
				if (missing.length > 0) {
					vscode.window.showWarningMessage(`Not found on the server: ${missing.join(', ')}`);
				}
				vscode.window.showInformationMessage(summarize('Downloaded', summary, unmapped));
			})
		),

		// Remote Hosts tree: download selected remote items into the server's local folder mapping.
		vscode.commands.registerCommand(
			'remoteHostExplorer.downloadRemoteItem',
			guarded('Download failed', async (clicked?: TreeNode, selected?: TreeNode[]) => {
				const nodes = withoutNestedSelections(
					resolveSelection(clicked, selected, treeView.selection).filter((node): node is FileNode => node.kind === 'file')
				);
				const mapped = nodes.filter(node => node.server.localPath);
				const unmapped = nodes.length - mapped.length;

				if (mapped.length === 0) {
					if (nodes.length > 0) {
						vscode.window.showWarningMessage(
							'Set a "Local mapped folder" on this server to download items from the tree.'
						);
					}
					return;
				}

				const summary = await withTransferProgress(`Downloading ${mapped.length} item(s)`, async run => {
					for (const node of mapped) {
						const localTarget = localTargetFor(node.server, node.entry.path);
						if (!localTarget) {
							continue;
						}
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
	];
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
