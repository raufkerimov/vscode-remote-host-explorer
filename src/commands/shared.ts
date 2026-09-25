import * as vscode from 'vscode';
import type { SecretsManager } from '../config/secrets';
import { getServerProfiles, whenServerProfilesLoaded, type LocalPathResolution, type ServerProfile } from '../config/serverConfig';
import type { ConnectionManager } from '../remote/ConnectionManager';
import type { HostKeyStore } from '../remote/hostKeys';
import type { RemoteFileCache } from '../editing/RemoteFileCache';
import type { FileNode, RemoteTreeProvider, TreeNode } from '../tree/RemoteTreeProvider';

/** Items put on the tree's clipboard; `cut` turns the next paste into a move. */
export interface RemoteClipboard {
	nodes: FileNode[];
	mode: 'copy' | 'cut';
}

/** Everything the command handlers need, assembled once during activation. */
export interface CommandServices {
	context: vscode.ExtensionContext;
	outputChannel: vscode.OutputChannel;
	secrets: SecretsManager;
	hostKeys: HostKeyStore;
	connections: ConnectionManager;
	treeProvider: RemoteTreeProvider;
	treeView: vscode.TreeView<TreeNode>;
	fileCache: RemoteFileCache;
	clipboard: { current?: RemoteClipboard };
}

/**
 * Works out which items a command should act on.
 *
 * With `canSelectMany`, VS Code calls a context-menu command with `(clickedItem, allSelectedItems)`.
 * If the user right-clicks an item *outside* the current selection, only that item is meant. A keyboard
 * shortcut passes no arguments at all, so the tree's live selection is used instead. Pure so it can be
 * unit tested.
 */
export function resolveSelection<T>(clicked: T | undefined, selected: readonly T[] | undefined, fallback: readonly T[]): T[] {
	if (clicked !== undefined && clicked !== null) {
		if (selected && selected.length > 0 && selected.includes(clicked)) {
			return [...selected];
		}
		return [clicked];
	}
	return [...fallback];
}

/**
 * Wraps a command handler so a rejected promise becomes a readable notification instead of an
 * unhandled rejection buried in the extension host log.
 */
export function guarded<TArgs extends unknown[]>(
	describe: string,
	handler: (...args: TArgs) => Promise<void> | void
): (...args: TArgs) => Promise<void> {
	return async (...args: TArgs) => {
		try {
			await handler(...args);
		} catch (err) {
			vscode.window.showErrorMessage(`${describe}: ${(err as Error).message}`);
		}
	};
}

export async function pickServer(): Promise<ServerProfile | undefined> {
	await whenServerProfilesLoaded();
	const servers = getServerProfiles();
	if (servers.length === 0) {
		vscode.window.showInformationMessage('No servers configured yet. Use "Add Server..." first.');
		return undefined;
	}
	if (servers.length === 1) {
		return servers[0];
	}
	const picked = await vscode.window.showQuickPick(
		servers.map(server => ({ label: server.name, description: `${server.protocol}://${server.host}`, server })),
		{ placeHolder: 'Select a server' }
	);
	return picked?.server;
}

/**
 * Chooses the server for local files that several profiles map (dev and prod on one folder). One
 * candidate is used directly; with more, the user picks from a list showing where each would put the
 * files. Nothing is remembered, so using production is always a deliberate choice. `resolutions` holds
 * every mapping of every file.
 */
export async function pickServerForLocalFiles(
	resolutions: readonly LocalPathResolution[],
	placeHolder: string
): Promise<ServerProfile | undefined> {
	const candidates = new Map<string, LocalPathResolution[]>();
	for (const resolution of resolutions) {
		candidates.set(resolution.server.id, [...(candidates.get(resolution.server.id) ?? []), resolution]);
	}
	const choices = [...candidates.values()];
	if (choices.length <= 1) {
		return choices[0]?.[0].server;
	}
	const picked = await vscode.window.showQuickPick(
		choices.map(([first, ...rest]) => ({
			label: first.server.name,
			description: `${first.server.protocol}://${first.server.host}${first.server.production ? ' · production' : ''}`,
			detail: `→ ${first.remotePath}${rest.length > 0 ? ` and ${rest.length} more` : ''}`,
			server: first.server,
		})),
		{ placeHolder, matchOnDescription: true }
	);
	return picked?.server;
}
