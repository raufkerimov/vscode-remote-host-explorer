import * as vscode from 'vscode';
import type { ServerProfile } from '../config/serverConfig';
import { FileNode, ServerNode, withoutNestedSelections, type TreeNode } from '../tree/RemoteTreeProvider';
import { confirmProductionChange } from '../config/productionGuard';
import { formatOctal, formatPermissions, parseModeInput } from '../util/permissions';
import { basenameRemote, dirnameRemote, joinRemote, normalizeRemote } from '../util/remotePath';
import { guarded, resolveSelection, type CommandServices } from './shared';

type TargetNode = ServerNode | FileNode;

/** Directory a new item should land in: the server root, the folder itself, or a file's folder. */
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

/** Delete already asks for confirmation, so a production server is called out there instead of asking twice. */
function productionNote(nodes: readonly FileNode[]): string {
	const names = [...new Set(nodes.filter(node => node.server.production).map(node => node.server.name))];
	return names.length > 0 ? `\n\n⚠ ${names.join(', ')} ${names.length === 1 ? 'is a production server' : 'are production servers'}.` : '';
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
	const { connections, treeProvider, treeView, fileCache } = services;

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
		if (!(await confirmProductionChange(server, `Create the ${kind} ${remotePath}.`))) {
			return;
		}
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
								: 'This cannot be undone.') +
							productionNote(nodes),
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
			'remoteHostExplorer.changePermissions',
			guarded('Failed to change permissions', async (clicked?: TreeNode, selected?: TreeNode[]) => {
				const nodes = selectedFiles(clicked, selected);
				if (nodes.length === 0) {
					return;
				}
				const current = nodes[0].entry.permissions;
				const input = await vscode.window.showInputBox({
					title: nodes.length === 1 ? `Permissions of "${nodes[0].entry.name}"` : `Permissions of ${nodes.length} items`,
					prompt: 'Octal like 644 or 755, or letters like rw-r--r--.' +
						(current !== undefined ? ` Currently ${formatPermissions(current)}.` : ''),
					value: current !== undefined ? formatOctal(current) : '',
					ignoreFocusOut: true,
					validateInput: value =>
						parseModeInput(value) === undefined ? 'Enter three or four octal digits (644) or nine letters (rw-r--r--).' : undefined,
				});
				const mode = input === undefined ? undefined : parseModeInput(input);
				if (mode === undefined) {
					return;
				}

				const failures: string[] = [];
				for (const { server, nodes: serverNodes } of groupByServer(nodes).values()) {
					if (!(await confirmProductionChange(server, `Change permissions of ${serverNodes.length} item(s) to ${formatOctal(mode)}.`))) {
						continue;
					}
					const client = await connections.getClient(server);
					for (const node of serverNodes) {
						try {
							await client.chmod(node.entry.path, mode);
						} catch (err) {
							failures.push(`${node.entry.name}: ${(err as Error).message}`);
						}
					}
					refreshAll(server, serverNodes.map(node => dirnameRemote(node.entry.path)));
				}
				if (failures.length > 0) {
					vscode.window.showErrorMessage(`Could not change permissions of ${failures.length} item(s). ${failures.join('; ')}`);
				} else {
					vscode.window.setStatusBarMessage(`Permissions set to ${formatPermissions(mode)} (${formatOctal(mode)})`, 4000);
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
				if (!(await confirmProductionChange(node.server, `Rename "${node.entry.name}" to "${trimmed}".`))) {
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
