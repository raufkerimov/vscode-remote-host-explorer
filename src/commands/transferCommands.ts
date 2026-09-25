import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
	isIgnored,
	localPathForRemote,
	resolveServerForLocalPathIn,
	resolveServersForLocalPath,
	type ServerProfile,
} from '../config/serverConfig';
import { downloadPath, uploadPath, withTransferProgress, type TransferSummary } from '../remote/transfer';
import { withoutNestedSelections, type FileNode, type TreeNode } from '../tree/RemoteTreeProvider';
import { dirnameRemote, toSafeRelativePath } from '../util/remotePath';
import { notifyTransfer } from '../remote/transferLog';
import { confirmProductionChange } from '../config/productionGuard';
import { guarded, pickServerForLocalFiles, resolveSelection, type CommandServices } from './shared';

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

/** Pairs each local target with its mapping on `server`, dropping targets that server doesn't map. */
function mappedOn(server: ServerProfile, targets: readonly vscode.Uri[]) {
	return targets.flatMap(uri => {
		const resolution = resolveServerForLocalPathIn([server], uri.fsPath);
		return resolution ? [{ uri, resolution }] : [];
	});
}

function summarize(verb: string, summary: TransferSummary, unmapped: number, destination = ''): string {
	const extras = [
		summary.skipped ? `${summary.skipped} ignored` : '',
		summary.keptLocal ? `${summary.keptLocal} existing local file(s) kept` : '',
		summary.keptRemote ? `${summary.keptRemote} newer server file(s) kept` : '',
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
				if (targets.length === 0) {
					return;
				}
				const resolutions = targets.flatMap(uri => resolveServersForLocalPath(uri.fsPath));
				if (resolutions.length === 0) {
					vscode.window.showWarningMessage(NO_MAPPING_MESSAGE);
					return;
				}
				const server = await pickServerForLocalFiles(
					resolutions,
					targets.length === 1 ? `Upload "${path.basename(targets[0].fsPath)}" to which server?` : `Upload ${targets.length} items to which server?`
				);
				if (!server) {
					return;
				}
				const mapped = mappedOn(server, targets);
				const unmapped = targets.length - mapped.length;
				if (!(await confirmProductionChange(server, `Upload ${mapped.length} item(s) to ${server.name}.`))) {
					return;
				}

				const summary = await withTransferProgress(`Uploading ${mapped.length} item(s) to ${server.name}`, async run => {
					for (const { uri, resolution } of mapped) {
						await uploadPath(server, connections, outputChannel, uri.fsPath, resolution.remotePath, run);
					}
				});
				if (!summary) {
					vscode.window.showInformationMessage('Upload cancelled.');
					return;
				}

				void notifyTransfer(summarize('Uploaded', summary, unmapped, ` to ${server.name}`));
				for (const { resolution } of mapped) {
					treeProvider.refreshDirectory(server, dirnameRemote(resolution.remotePath));
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
				void notifyTransfer(summarize('Downloaded', summary, unmapped));
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
				void notifyTransfer(summarize('Downloaded', summary, 0, ` to ${folder}`));
			})
		),

		// Explorer / Source Control / palette: upload every file Git reports as changed.
		vscode.commands.registerCommand(
			'remoteHostExplorer.uploadGitChanges',
			guarded('Upload failed', async (sourceControl?: { rootUri?: vscode.Uri }) => {
				const changed = await gitChangedFiles(sourceControl?.rootUri);
				if (!changed) {
					return;
				}
				const pairs = changed.flatMap(uri => resolveServersForLocalPath(uri.fsPath).map(resolution => ({ uri, resolution })));
				if (pairs.length === 0) {
					vscode.window.showInformationMessage(
						changed.length === 0 ? 'Git reports no changed files.' : 'None of the changed files is inside a folder mapping.'
					);
					return;
				}
				const server = await pickServerForLocalFiles(
					pairs.map(pair => pair.resolution),
					`Upload ${changed.length} changed file(s) to which server?`
				);
				if (!server) {
					return;
				}
				const onServer = pairs.filter(pair => pair.resolution.server === server);
				// Like auto-upload this is a batch the user didn't list by hand, so ignore patterns apply.
				const candidates = onServer.filter(pair => !isIgnored(server, pair.resolution.relativePath));
				const ignored = onServer.length - candidates.length;
				if (candidates.length === 0) {
					vscode.window.showInformationMessage(`All ${ignored} changed file(s) match the server's ignore patterns.`);
					return;
				}

				const picked = await vscode.window.showQuickPick(
					candidates.map(pair => ({
						label: pair.resolution.relativePath,
						description: `→ ${pair.resolution.remotePath}`,
						picked: true,
						...pair,
					})),
					{
						canPickMany: true,
						ignoreFocusOut: true,
						placeHolder: `Upload these changed files to ${server.name}? Untick any to leave out.`,
					}
				);
				if (!picked || picked.length === 0) {
					return;
				}
				if (!(await confirmProductionChange(server, `Upload ${picked.length} changed file(s) to ${server.name}.`))) {
					return;
				}

				const client = await connections.getClient(server);
				const summary = await withTransferProgress(`Uploading ${picked.length} changed file(s) to ${server.name}`, async run => {
					const created = new Set<string>();
					for (const { uri, resolution } of picked) {
						// New files may sit in folders that don't exist on the server yet.
						const directory = dirnameRemote(resolution.remotePath);
						if (!created.has(directory)) {
							await client.mkdir(directory);
							created.add(directory);
						}
						await uploadPath(server, connections, outputChannel, uri.fsPath, resolution.remotePath, run);
					}
				});
				if (!summary) {
					vscode.window.showInformationMessage('Upload cancelled.');
					return;
				}
				summary.skipped += ignored;
				void notifyTransfer(summarize('Uploaded', summary, 0, ` to ${server.name}`));
				for (const directory of new Set(picked.map(({ resolution }) => dirnameRemote(resolution.remotePath)))) {
					treeProvider.refreshDirectory(server, directory);
				}
			})
		),
	];

	function selectedFileNodes(clicked: TreeNode | undefined, selected: TreeNode[] | undefined): FileNode[] {
		return withoutNestedSelections(
			resolveSelection(clicked, selected, treeView.selection).filter((node): node is FileNode => node.kind === 'file')
		);
	}
}

/** Subset of the built-in Git extension's API (`vscode.git`, API version 1) used here. */
interface GitChange {
	uri: vscode.Uri;
	status: number;
}
interface GitRepository {
	rootUri: vscode.Uri;
	state: { workingTreeChanges: GitChange[]; indexChanges: GitChange[]; untrackedChanges?: GitChange[] };
}
interface GitExtension {
	getAPI(version: 1): { repositories: GitRepository[] };
}
/** `Status.IGNORED` in the Git extension's API. */
const GIT_STATUS_IGNORED = 8;

/**
 * Files Git reports as changed (staged, unstaged, or untracked) that still exist, optionally limited to
 * one repository. Deleted files are left out: uploading can't delete them on the server. `undefined`
 * when Git isn't available.
 */
async function gitChangedFiles(repositoryRoot?: vscode.Uri): Promise<vscode.Uri[] | undefined> {
	const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
	if (!extension) {
		vscode.window.showWarningMessage('The built-in Git extension is not available, so changed files are unknown.');
		return undefined;
	}
	const git = (extension.isActive ? extension.exports : await extension.activate()).getAPI(1);
	const repositories = git.repositories.filter(
		repository => !repositoryRoot || repository.rootUri.toString() === repositoryRoot.toString()
	);
	if (repositories.length === 0) {
		vscode.window.showInformationMessage('No Git repository is open.');
		return undefined;
	}

	const uris = new Map<string, vscode.Uri>();
	for (const { state } of repositories) {
		for (const change of [...state.indexChanges, ...state.workingTreeChanges, ...(state.untrackedChanges ?? [])]) {
			if (change.status !== GIT_STATUS_IGNORED && change.uri.scheme === 'file') {
				uris.set(change.uri.fsPath, change.uri);
			}
		}
	}
	const existing = await Promise.all(
		[...uris.values()].map(async uri => ((await fs.promises.stat(uri.fsPath).catch(() => undefined))?.isFile() ? uri : undefined))
	);
	return existing.filter((uri): uri is vscode.Uri => uri !== undefined);
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

/**
 * Uploads a saved document to every server that maps it and has `autoUpload` enabled — dev and prod may
 * both map the folder, with only one of them uploading on save.
 */
export async function autoUploadOnSave(
	document: vscode.TextDocument,
	services: CommandServices
): Promise<void> {
	const { connections, outputChannel, treeProvider } = services;
	const resolutions = resolveServersForLocalPath(document.uri.fsPath).filter(resolution => resolution.server.autoUpload);

	for (const { server, remotePath, relativePath } of resolutions) {
		// Unlike an explicit upload, auto-upload is implicit, so ignore patterns apply.
		if (isIgnored(server, relativePath)) {
			outputChannel.appendLine(
				`Skipped auto-upload of ${document.uri.fsPath} to ${server.name} (matches an ignore pattern).`
			);
			continue;
		}

		if (!(await confirmProductionChange(server, `Upload ${relativePath || document.fileName} on save.`, { repeated: true }))) {
			continue;
		}
		try {
			const summary = await withTransferProgress(`Auto-uploading to ${server.name}`, run =>
				uploadPath(server, connections, outputChannel, document.uri.fsPath, remotePath, run)
			);
			if (!summary) {
				continue;
			}
			outputChannel.appendLine(`Auto-uploaded ${document.uri.fsPath} -> ${server.name}:${remotePath}`);
			treeProvider.refreshDirectory(server, dirnameRemote(remotePath));
		} catch (err) {
			outputChannel.appendLine(`Auto-upload to ${server.name} failed for ${document.uri.fsPath}: ${(err as Error).message}`);
			void notifyTransfer(`Auto-upload to ${server.name} failed: ${(err as Error).message}`, 'error');
		}
	}
}
