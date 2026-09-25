import * as vscode from 'vscode';
import type { ServerProfile } from '../config/serverConfig';
import { FileNode, ServerNode, withoutNestedSelections, type TreeNode } from '../tree/RemoteTreeProvider';
import { moveRemoteItems, promptForConflict } from '../remote/moveItems';
import type { RemoteClient } from '../remote/RemoteClient';
import { CancelledError, copyRemoteTree, withTransferProgress, type TransferRun } from '../remote/transfer';
import { notifyTransfer } from '../remote/transferLog';
import { basenameRemote, dirnameRemote, isSameOrInside, joinRemote, normalizeRemote } from '../util/remotePath';
import { guarded, resolveSelection, type CommandServices } from './shared';

type TargetNode = ServerNode | FileNode;

/** Directory a new/pasted item should land in: the server root, the folder itself, or a file's folder. */
function targetDirectoryOf(target: TargetNode): string {
	if (target.kind === 'server') {
		return normalizeRemote(target.server.remoteRoot);
	}
	return target.entry.isDirectory ? normalizeRemote(target.entry.path) : dirnameRemote(target.entry.path);
}

function nameValidator(kind: 'file' | 'folder') {
	return (value: string): string | undefined => {
		const name = value.trim();
		if (!name) {
			return `Enter a ${kind} name.`;
		}
		if (name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
			return `Enter a ${kind} name, not a path.`;
		}
		return undefined;
	};
}

const validateFileName = nameValidator('file');

/** `name.ext` -> `name<suffix>.ext`, keeping dotfiles like `.env` intact. */
function withNameSuffix(name: string, suffix: string): string {
	const dotIndex = name.lastIndexOf('.');
	return dotIndex > 0 ? `${name.slice(0, dotIndex)}${suffix}${name.slice(dotIndex)}` : `${name}${suffix}`;
}

function describeItems(nodes: readonly FileNode[]): string {
	const names = nodes.slice(0, 10).map(node => `• ${node.entry.name}`);
	if (nodes.length > 10) {
		names.push(`…and ${nodes.length - 10} more`);
	}
	return names.join('\n');
}

/** Groups nodes by server so each server's client is fetched once and its tree refreshed once. */
function groupByServer(nodes: readonly FileNode[]): Map<string, { server: ServerProfile; nodes: FileNode[] }> {
	const groups = new Map<string, { server: ServerProfile; nodes: FileNode[] }>();
	for (const node of nodes) {
		const group = groups.get(node.server.id) ?? { server: node.server, nodes: [] };
		group.nodes.push(node);
		groups.set(node.server.id, group);
	}
	return groups;
}

export function registerFileCommands(services: CommandServices): vscode.Disposable[] {
	const { connections, treeProvider, treeView, fileCache, clipboard } = services;

	/** The file/directory rows a command applies to, honouring multi-selection and keyboard invocation. */
	const selectedFiles = (clicked?: TreeNode, selected?: readonly TreeNode[]): FileNode[] =>
		resolveSelection(clicked, selected, treeView.selection).filter((node): node is FileNode => node.kind === 'file');

	const refreshAll = (server: ServerProfile, directories: Iterable<string>) => {
		for (const directory of new Set(directories)) {
			treeProvider.refreshDirectory(server, directory);
		}
	};

	/** New File / New Folder in the clicked folder, the clicked file's folder, or the server root. */
	const createRemoteItem = async (kind: 'file' | 'folder', target?: TargetNode): Promise<void> => {
		target ??= treeView.selection[0];
		if (!target) {
			return;
		}
		const name = (
			await vscode.window.showInputBox({
				prompt: kind === 'file' ? 'New remote file name' : 'New remote folder name',
				placeHolder: kind === 'file' ? 'index.php' : 'assets',
				ignoreFocusOut: true,
				validateInput: nameValidator(kind),
			})
		)?.trim();
		if (!name) {
			return;
		}

		const server = target.server;
		const remoteDirectory = targetDirectoryOf(target);
		const remotePath = joinRemote(remoteDirectory, name);
		const client = await connections.getClient(server);

		// Writing straight over an existing file would silently replace it with an empty one.
		if (await client.exists(remotePath)) {
			vscode.window.showErrorMessage(`"${name}" already exists in ${remoteDirectory}.`);
			return;
		}

		if (kind === 'file') {
			await client.writeFile(remotePath, Buffer.alloc(0));
		} else {
			await client.mkdir(remotePath);
		}
		vscode.window.showInformationMessage(`Created remote ${kind} ${remotePath}`);
		treeProvider.refreshDirectory(server, remoteDirectory);
	};

	return [
		vscode.commands.registerCommand(
			'remoteHostExplorer.openRemoteFile',
			guarded('Failed to open the remote file', async (clicked?: TreeNode, selected?: TreeNode[]) => {
				for (const node of selectedFiles(clicked, selected).filter(node => !node.entry.isDirectory)) {
					await fileCache.openRemoteFile(node.server, node.entry);
				}
			})
		),

		vscode.commands.registerCommand(
			'remoteHostExplorer.newFile',
			guarded('Failed to create the remote file', (target?: TargetNode) => createRemoteItem('file', target))
		),

		vscode.commands.registerCommand(
			'remoteHostExplorer.newFolder',
			guarded('Failed to create the remote folder', (target?: TargetNode) => createRemoteItem('folder', target))
		),

		vscode.commands.registerCommand(
			'remoteHostExplorer.copyRemotePath',
			guarded('Failed to copy the path', async (clicked?: TreeNode, selected?: TreeNode[]) => {
				const nodes = selectedFiles(clicked, selected);
				if (nodes.length === 0) {
					return;
				}
				await vscode.env.clipboard.writeText(nodes.map(node => node.entry.path).join('\n'));
				vscode.window.showInformationMessage(
					nodes.length === 1 ? `Copied path: ${nodes[0].entry.path}` : `Copied ${nodes.length} paths`
				);
			})
		),

		vscode.commands.registerCommand(
			'remoteHostExplorer.copyFile',
			guarded('Failed to copy', (clicked?: TreeNode, selected?: TreeNode[]) => {
				const nodes = selectedFiles(clicked, selected);
				if (nodes.length === 0) {
					return;
				}
				clipboard.current = { nodes, mode: 'copy' };
				vscode.window.setStatusBarMessage(`Copied ${nodes.length === 1 ? `"${nodes[0].entry.name}"` : `${nodes.length} items`}`, 3000);
			})
		),

		vscode.commands.registerCommand(
			'remoteHostExplorer.cutFile',
			guarded('Failed to cut', (clicked?: TreeNode, selected?: TreeNode[]) => {
				const nodes = selectedFiles(clicked, selected);
				if (nodes.length === 0) {
					return;
				}
				clipboard.current = { nodes, mode: 'cut' };
				vscode.window.setStatusBarMessage(
					`Cut ${nodes.length === 1 ? `"${nodes[0].entry.name}"` : `${nodes.length} items`} — paste into a folder to move`,
					3000
				);
			})
		),

		vscode.commands.registerCommand(
			'remoteHostExplorer.pasteFile',
			guarded('Failed to paste', async (clicked?: TargetNode) => {
				const clip = clipboard.current;
				if (!clip || clip.nodes.length === 0) {
					vscode.window.showInformationMessage('Nothing to paste. Copy or cut remote items first.');
					return;
				}
				const target = clicked ?? treeView.selection[0];
				if (!target) {
					vscode.window.showInformationMessage('Select a folder to paste into.');
					return;
				}

				const server = target.server;
				const targetDir = targetDirectoryOf(target);
				const sources = withoutNestedSelections(clip.nodes.filter(node => node.server.id === server.id));
				if (sources.length < clip.nodes.length) {
					vscode.window.showWarningMessage('Items from a different server were skipped: copying between servers is not supported.');
				}
				if (sources.length === 0) {
					return;
				}
				const client = await connections.getClient(server);

				if (clip.mode === 'cut') {
					const result = await moveRemoteItems(
						client,
						sources.map(node => ({ path: node.entry.path, name: node.entry.name, isDirectory: node.entry.isDirectory })),
						targetDir,
						(fromPath, toPath) => fileCache.retrack(server.id, fromPath, toPath)
					);
					// A cut is consumed by the paste; pasting again must not try to move the originals twice.
					clipboard.current = undefined;
					refreshAll(server, result.affectedDirectories);
					if (result.moved > 0) {
						vscode.window.showInformationMessage(`Moved ${result.moved} item(s) to ${targetDir}.`);
					}
					return;
				}

				const summary = await withTransferProgress(`Copying ${sources.length} item(s)`, async run => {
					for (const source of sources) {
						await pasteCopy(client, source, targetDir, run);
					}
				});
				if (!summary) {
					vscode.window.showInformationMessage('Copy cancelled.');
					return;
				}
				void notifyTransfer(`Pasted ${summary.transferred} file(s) into ${targetDir}.`);
				treeProvider.refreshDirectory(server, targetDir);
			})
		),

		vscode.commands.registerCommand(
			'remoteHostExplorer.backupFile',
			guarded('Backup failed', async (clicked?: TreeNode, selected?: TreeNode[]) => {
				const files = selectedFiles(clicked, selected).filter(node => !node.entry.isDirectory);
				if (files.length === 0) {
					return;
				}
				const now = new Date();
				const pad = (value: number) => String(value).padStart(2, '0');
				const timestamp =
					`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
					`_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

				for (const { server, nodes } of groupByServer(files).values()) {
					const client = await connections.getClient(server);
					const directories: string[] = [];
					for (const node of nodes) {
						const sourcePath = normalizeRemote(node.entry.path);
						const directory = dirnameRemote(sourcePath);
						// Copies through the existing session: no local temp file, so no temp-name collisions.
						await client.copy(sourcePath, joinRemote(directory, withNameSuffix(basenameRemote(sourcePath), `_${timestamp}`)));
						directories.push(directory);
					}
					refreshAll(server, directories);
				}
				vscode.window.showInformationMessage(
					files.length === 1 ? `Created a backup of "${files[0].entry.name}"` : `Created ${files.length} backups`
				);
			})
		),

		vscode.commands.registerCommand(
			'remoteHostExplorer.deleteRemoteItem',
			guarded('Failed to delete', async (clicked?: TreeNode, selected?: TreeNode[]) => {
				const nodes = withoutNestedSelections(selectedFiles(clicked, selected));
				if (nodes.length === 0) {
					return;
				}

				const hasDirectories = nodes.some(node => node.entry.isDirectory);
				const confirm = await vscode.window.showWarningMessage(
					nodes.length === 1
						? `Delete "${nodes[0].entry.name}" from ${nodes[0].server.name}?`
						: `Delete ${nodes.length} items?`,
					{
						modal: true,
						detail:
							(nodes.length > 1 ? `${describeItems(nodes)}\n\n` : '') +
							(hasDirectories
								? 'Folders are deleted together with everything inside them. This cannot be undone.'
								: 'This cannot be undone.'),
					},
					'Delete'
				);
				if (confirm !== 'Delete') {
					return;
				}

				const failures: string[] = [];
				for (const { server, nodes: serverNodes } of groupByServer(nodes).values()) {
					const client = await connections.getClient(server);
					const directories: string[] = [];
					for (const node of serverNodes) {
						try {
							await client.delete(node.entry.path, node.entry.isDirectory);
							// Stop tracking it (and anything inside it), or a later save would re-create it.
							await fileCache.untrack(server.id, node.entry.path);
							directories.push(dirnameRemote(node.entry.path));
						} catch (err) {
							failures.push(`${node.entry.name}: ${(err as Error).message}`);
						}
					}
					refreshAll(server, directories);
				}

				if (failures.length > 0) {
					vscode.window.showErrorMessage(`Could not delete ${failures.length} item(s). ${failures.join('; ')}`);
				} else {
					vscode.window.showInformationMessage(
						nodes.length === 1 ? `Deleted "${nodes[0].entry.name}"` : `Deleted ${nodes.length} items`
					);
				}
			})
		),

		vscode.commands.registerCommand(
			'remoteHostExplorer.renameRemoteItem',
			guarded('Failed to rename', async (clicked?: TreeNode) => {
				const node = selectedFiles(clicked, undefined)[0];
				if (!node) {
					return;
				}
				const newName = await vscode.window.showInputBox({
					prompt: 'Enter new name',
					value: node.entry.name,
					ignoreFocusOut: true,
					// A name containing a separator would quietly relocate the item instead of renaming it.
					validateInput: validateFileName,
				});
				const trimmed = newName?.trim();
				if (!trimmed || trimmed === node.entry.name) {
					return;
				}

				const client = await connections.getClient(node.server);
				const directory = dirnameRemote(node.entry.path);
				const newPath = joinRemote(directory, trimmed);

				if (await client.exists(newPath)) {
					vscode.window.showErrorMessage(`"${trimmed}" already exists in ${directory}.`);
					return;
				}

				await client.rename(node.entry.path, newPath);
				await fileCache.retrack(node.server.id, node.entry.path, newPath);
				vscode.window.showInformationMessage(`Renamed to "${trimmed}"`);
				treeProvider.refreshDirectory(node.server, directory);
			})
		),
	];
}

/** Copies one clipboard item into `targetDir`, resolving name clashes with the user. */
async function pasteCopy(
	client: RemoteClient,
	source: FileNode,
	targetDir: string,
	run: TransferRun
): Promise<void> {
	const sourcePath = normalizeRemote(source.entry.path);

	// Copying a folder into itself would keep listing the copy it is writing and never finish.
	if (source.entry.isDirectory && isSameOrInside(sourcePath, targetDir)) {
		vscode.window.showWarningMessage(`Cannot copy "${source.entry.name}" into itself.`);
		run.summary.skipped += 1;
		return;
	}

	let destinationPath = joinRemote(targetDir, basenameRemote(sourcePath));
	if (destinationPath === sourcePath) {
		// Pasting into the item's own folder makes a sibling copy rather than failing.
		destinationPath = joinRemote(targetDir, withNameSuffix(basenameRemote(sourcePath), ' copy'));
	}

	if (await client.exists(destinationPath)) {
		const decision = await promptForConflict(basenameRemote(destinationPath), targetDir);
		if (decision === 'cancel') {
			// Stops the remaining items; withTransferProgress reports this as a cancellation, not a failure.
			throw new CancelledError();
		}
		if (decision === 'skip') {
			run.summary.skipped += 1;
			return;
		}
		await client.delete(destinationPath, source.entry.isDirectory);
	}

	await copyRemoteTree(source.server, client, sourcePath, destinationPath, source.entry.isDirectory, run);
}
