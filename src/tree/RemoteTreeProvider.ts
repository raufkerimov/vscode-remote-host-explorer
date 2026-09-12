import * as vscode from 'vscode';
import {
	getScopedServerProfiles,
	whenServerProfilesLoaded,
	type ProfileScope,
	type ServerProfile,
} from '../config/serverConfig';
import type { RemoteFileCache } from '../editing/RemoteFileCache';
import type { ConnectionManager } from '../remote/ConnectionManager';
import { moveRemoteItems } from '../remote/moveItems';
import type { RemoteFileEntry } from '../remote/RemoteClient';
import { basenameRemote, dirnameRemote, isSameOrInside, normalizeRemote } from '../util/remotePath';

export const REMOTE_TREE_MIME = 'application/vnd.code.tree.remotehostexplorer';

export type TreeNode = ServerNode | FileNode;

export class ServerNode {
	readonly kind = 'server';
	constructor(public server: ServerProfile, public scope: ProfileScope = 'global') {}
}

/**
 * Context value for a file/directory row. The `.mapped` / `.unmapped` suffix records whether the server
 * has a `localPath`, so menu entries that need one (Download) can be disabled in `package.json`.
 */
export function fileContextValue(entry: RemoteFileEntry, server: ServerProfile): string {
	const kind = entry.isDirectory ? 'directory' : 'file';
	return `remoteHostExplorer.${kind}.${server.localPath ? 'mapped' : 'unmapped'}`;
}

export class FileNode {
	readonly kind = 'file';
	// Mutable so a refreshed listing can update an existing node in place. VS Code tracks tree elements
	// by object identity, so replacing the instance would break reveal() and targeted refreshes.
	constructor(public server: ServerProfile, public entry: RemoteFileEntry) {}
}

const KEY_SEPARATOR = '::';

function fileKey(serverId: string, remotePath: string): string {
	return `${serverId}${KEY_SEPARATOR}${normalizeRemote(remotePath)}`;
}

export class RemoteTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.TreeDragAndDropController<TreeNode> {
	readonly dragMimeTypes = [REMOTE_TREE_MIME];
	readonly dropMimeTypes = [REMOTE_TREE_MIME];

	private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<TreeNode | undefined>();
	readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

	private readonly serverNodes = new Map<string, ServerNode>();
	private readonly fileNodes = new Map<string, FileNode>();

	constructor(
		private readonly connections: ConnectionManager,
		private readonly fileCache: RemoteFileCache
	) {}

	/** Reuses node instances so VS Code can match refresh and reveal targets by identity. */
	serverNode(server: ServerProfile, scope?: ProfileScope): ServerNode {
		const existing = this.serverNodes.get(server.id);
		if (existing) {
			existing.server = server;
			if (scope) {
				existing.scope = scope;
			}
			return existing;
		}
		const created = new ServerNode(server, scope);
		this.serverNodes.set(server.id, created);
		return created;
	}

	private fileNode(server: ServerProfile, entry: RemoteFileEntry): FileNode {
		const key = fileKey(server.id, entry.path);
		const existing = this.fileNodes.get(key);
		if (existing) {
			existing.server = server;
			existing.entry = entry;
			return existing;
		}
		const created = new FileNode(server, entry);
		this.fileNodes.set(key, created);
		return created;
	}

	/** Full reload. Prefer {@link refreshDirectory} so unrelated expanded folders are not re-listed. */
	refresh(): void {
		this.fileNodes.clear();
		this.onDidChangeTreeDataEmitter.fire(undefined);
	}

	refreshServer(serverId: string): void {
		const node = this.serverNodes.get(serverId);
		if (!node) {
			this.refresh();
			return;
		}
		for (const key of [...this.fileNodes.keys()]) {
			if (key.startsWith(`${serverId}${KEY_SEPARATOR}`)) {
				this.fileNodes.delete(key);
			}
		}
		this.onDidChangeTreeDataEmitter.fire(node);
	}

	/** Refreshes just the directory that changed, falling back to the server root when it is not expanded. */
	refreshDirectory(server: ServerProfile, remoteDirPath: string): void {
		const normalized = normalizeRemote(remoteDirPath);
		const root = normalizeRemote(server.remoteRoot);

		for (const key of [...this.fileNodes.keys()]) {
			const separatorIndex = key.indexOf(KEY_SEPARATOR);
			const serverId = key.slice(0, separatorIndex);
			const filePath = key.slice(separatorIndex + KEY_SEPARATOR.length);
			if (serverId === server.id && dirnameRemote(filePath) === normalized) {
				this.fileNodes.delete(key);
			}
		}

		if (normalized === root) {
			this.onDidChangeTreeDataEmitter.fire(this.serverNode(server));
			return;
		}

		const node = this.fileNodes.get(fileKey(server.id, normalized));
		this.onDidChangeTreeDataEmitter.fire(node ?? this.serverNodes.get(server.id));
	}

	getTreeItem(node: TreeNode): vscode.TreeItem {
		if (node.kind === 'server') {
			const connected = this.connections.isConnected(node.server.id);
			const item = new vscode.TreeItem(
				node.server.name,
				connected ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
			);
			item.contextValue = connected ? 'remoteHostExplorer.server.connected' : 'remoteHostExplorer.server.disconnected';
			item.id = `server:${node.server.id}`;
			item.iconPath = new vscode.ThemeIcon(
				connected ? 'circle-filled' : 'circle-outline',
				new vscode.ThemeColor(connected ? 'charts.green' : 'disabledForeground')
			);
			const state = connected ? 'connected' : 'not connected';
			// Global servers are the ones that appear in every window, so they are labelled as such.
			const scopeLabel = node.scope === 'global' ? ' · global' : '';
			item.description = `${node.server.protocol}://${node.server.host} - ${state}${scopeLabel}`;
			item.tooltip =
				`${node.server.name}\n${node.server.protocol}://${node.server.host}\nRoot: ${node.server.remoteRoot}\n` +
				(node.scope === 'project' ? 'Available in this project only' : 'Available in all projects') +
				(node.server.localPath ? `\nLocal folder: ${node.server.localPath}` : '\nNo local folder mapped');
			return item;
		}

		const item = new vscode.TreeItem(
			node.entry.name,
			node.entry.isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
		);
		item.id = `file:${node.server.id}:${node.entry.path}`;
		item.contextValue = fileContextValue(node.entry, node.server);
		item.iconPath = node.entry.isDirectory ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;
		item.tooltip = node.entry.isSymbolicLink ? `${node.entry.path} (symbolic link)` : node.entry.path;
		if (node.entry.isSymbolicLink) {
			item.description = 'link';
		}
		if (!node.entry.isDirectory) {
			item.command = {
				command: 'remoteHostExplorer.openRemoteFile',
				title: 'Open',
				arguments: [node],
			};
		}
		return item;
	}

	async getChildren(node?: TreeNode): Promise<TreeNode[]> {
		if (!node) {
			await whenServerProfilesLoaded();
			return getScopedServerProfiles().map(({ profile, scope }) => this.serverNode(profile, scope));
		}

		const server = node.server;
		const client = this.connections.getExistingClient(server.id);
		if (!client) {
			return [];
		}
		const remotePath = node.kind === 'server' ? server.remoteRoot : node.entry.path;
		try {
			const entries = await client.list(remotePath);
			entries.sort((a, b) => (a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1));
			return entries.map(entry => this.fileNode(server, entry));
		} catch (err) {
			vscode.window.showErrorMessage(`Failed to list "${remotePath}": ${(err as Error).message}`);
			return [];
		}
	}

	getParent(node: TreeNode): TreeNode | undefined {
		if (node.kind === 'server') {
			return undefined;
		}

		const root = normalizeRemote(node.server.remoteRoot);
		const parentPath = dirnameRemote(node.entry.path);

		// Anything at (or above) the mapping root hangs directly off the server node.
		if (parentPath === root || !isSameOrInside(root, parentPath)) {
			return this.serverNode(node.server);
		}

		const cached = this.fileNodes.get(fileKey(node.server.id, parentPath));
		if (cached) {
			return cached;
		}
		return this.fileNode(node.server, {
			name: basenameRemote(parentPath),
			path: parentPath,
			isDirectory: true,
			size: 0,
			modifiedAt: 0,
		});
	}

	async handleDrag(source: readonly TreeNode[], dataTransfer: vscode.DataTransfer): Promise<void> {
		const files = source.filter((n): n is FileNode => n.kind === 'file');
		if (files.length > 0) {
			dataTransfer.set(REMOTE_TREE_MIME, new vscode.DataTransferItem(files));
		}
	}

	async handleDrop(target: TreeNode | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
		const item = dataTransfer.get(REMOTE_TREE_MIME);
		if (!item || !target) {
			return;
		}
		const sources: FileNode[] = item.value;
		if (!sources || sources.length === 0) {
			return;
		}

		const targetServer = target.server;
		const targetClient = this.connections.getExistingClient(targetServer.id);
		if (!targetClient) {
			vscode.window.showWarningMessage(`Server "${targetServer.name}" is not connected.`);
			return;
		}

		const targetDir = target.kind === 'server'
			? normalizeRemote(targetServer.remoteRoot)
			: target.entry.isDirectory
				? normalizeRemote(target.entry.path)
				: dirnameRemote(target.entry.path);

		const sameServer = sources.filter(src => src.server.id === targetServer.id);
		if (sameServer.length < sources.length) {
			vscode.window.showWarningMessage('Moving files between different servers is not supported.');
		}

		try {
			const result = await moveRemoteItems(
				targetClient,
				// A folder and something inside it may both be selected; moving the folder already moves the child.
				withoutNestedSelections(sameServer).map(src => ({
					path: src.entry.path,
					name: src.entry.name,
					isDirectory: src.entry.isDirectory,
				})),
				targetDir,
				(fromPath, toPath) => this.fileCache.retrack(targetServer.id, fromPath, toPath)
			);
			for (const directory of result.affectedDirectories) {
				this.refreshDirectory(targetServer, directory);
			}
		} catch (err) {
			vscode.window.showErrorMessage(`Failed to move: ${(err as Error).message}`);
			this.refreshServer(targetServer.id);
		}
	}
}

/** Drops any selected node whose ancestor directory is also selected, so it isn't processed twice. */
export function withoutNestedSelections<T extends { entry: RemoteFileEntry }>(nodes: readonly T[]): T[] {
	const directories = nodes.filter(node => node.entry.isDirectory).map(node => normalizeRemote(node.entry.path));
	return nodes.filter(node => {
		const path = normalizeRemote(node.entry.path);
		return !directories.some(directory => directory !== path && isSameOrInside(directory, path));
	});
}
