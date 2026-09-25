import * as path from 'path';
import * as vscode from 'vscode';
import { confirmProductionChange } from '../config/productionGuard';
import {
	folderMappings,
	getServerProfiles,
	hasFolderMappings,
	localPathForRemote,
	resolveServersForLocalPath,
	whenServerProfilesLoaded,
	type ServerProfile,
} from '../config/serverConfig';
import { knownFileStates } from '../remote/remoteState';
import { compareFolders, type SyncItem, type SyncStatus } from '../remote/sync';
import { CancelledError, downloadPath, uploadPath, withTransferProgress } from '../remote/transfer';
import { notifyTransfer } from '../remote/transferLog';
import type { TreeNode } from '../tree/RemoteTreeProvider';
import { dirnameRemote } from '../util/remotePath';
import { guarded, pickServerForLocalFiles, type CommandServices } from './shared';

interface SyncTarget {
	server: ServerProfile;
	localRoot: string;
	remoteRoot: string;
}

type Direction = 'upload' | 'download';

interface SyncPick extends vscode.QuickPickItem {
	item?: SyncItem;
	direction?: Direction;
}

const DESCRIPTIONS: Record<SyncStatus, string> = {
	localOnly: 'new on your computer',
	localChanged: 'changed on your computer',
	remoteOnly: 'only on the server',
	remoteChanged: 'changed on the server',
	bothChanged: 'changed on both sides',
	differs: 'different size, never synced here',
};

/** Which way a file goes by default; files changed on both sides (or never synced) have no default. */
export function defaultDirection(status: SyncStatus): Direction | undefined {
	switch (status) {
		case 'localOnly':
		case 'localChanged':
			return 'upload';
		case 'remoteOnly':
		case 'remoteChanged':
			return 'download';
		default:
			return undefined;
	}
}

async function pickMapping(server: ServerProfile): Promise<SyncTarget | undefined> {
	const mappings = folderMappings(server);
	if (mappings.length === 0) {
		vscode.window.showWarningMessage(`"${server.name}" has no folder mapping to sync. Add one in Edit Server.`);
		return undefined;
	}
	if (mappings.length === 1) {
		return { server, localRoot: mappings[0].localPath, remoteRoot: mappings[0].remotePath };
	}
	const picked = await vscode.window.showQuickPick(
		mappings.map(mapping => ({ label: mapping.localPath, description: `↔ ${mapping.remotePath}`, mapping })),
		{ placeHolder: `Sync which folder with ${server.name}?` }
	);
	return picked && { server, localRoot: picked.mapping.localPath, remoteRoot: picked.mapping.remotePath };
}

/** Works out what to compare from wherever the command was run: Explorer folder, tree row, or palette. */
async function resolveTarget(arg: vscode.Uri | TreeNode | undefined): Promise<SyncTarget | undefined> {
	if (arg instanceof vscode.Uri) {
		const resolutions = resolveServersForLocalPath(arg.fsPath);
		if (resolutions.length === 0) {
			vscode.window.showWarningMessage('This folder is not inside a folder mapping of any server.');
			return undefined;
		}
		const server = await pickServerForLocalFiles(resolutions, `Sync "${path.basename(arg.fsPath)}" with which server?`);
		const resolution = resolutions.find(candidate => candidate.server === server);
		return resolution && { server: resolution.server, localRoot: arg.fsPath, remoteRoot: resolution.remotePath };
	}
	if (arg?.kind === 'file') {
		const localRoot = localPathForRemote(arg.server, arg.entry.path);
		if (!localRoot || !arg.entry.isDirectory) {
			vscode.window.showWarningMessage('Only folders inside a folder mapping can be synced.');
			return undefined;
		}
		return { server: arg.server, localRoot, remoteRoot: arg.entry.path };
	}
	if (arg?.kind === 'server') {
		return pickMapping(arg.server);
	}

	await whenServerProfilesLoaded();
	const servers = getServerProfiles().filter(hasFolderMappings);
	if (servers.length === 0) {
		vscode.window.showInformationMessage('No server has a folder mapping yet. Add one in Edit Server.');
		return undefined;
	}
	const server =
		servers.length === 1
			? servers[0]
			: (
				await vscode.window.showQuickPick(
					servers.map(candidate => ({
						label: candidate.name,
						description: `${candidate.protocol}://${candidate.host}${candidate.production ? ' · production' : ''}`,
						server: candidate,
					})),
					{ placeHolder: 'Sync with which server?' }
				)
			)?.server;
	return server && pickMapping(server);
}

function picksFor(items: readonly SyncItem[]): SyncPick[] {
	const upload: SyncPick[] = [];
	const download: SyncPick[] = [];
	const decide: SyncPick[] = [];
	for (const item of items) {
		const direction = defaultDirection(item.status);
		const pick = (way: Direction, picked: boolean): SyncPick => ({
			label: `${way === 'upload' ? '$(arrow-up)' : '$(arrow-down)'} ${item.relativePath}`,
			description: DESCRIPTIONS[item.status] + (direction ? '' : way === 'upload' ? ' — upload yours' : " — download the server's"),
			picked,
			item,
			direction: way,
		});
		if (direction === 'upload') {
			upload.push(pick('upload', true));
		} else if (direction === 'download') {
			download.push(pick('download', true));
		} else {
			decide.push(pick('upload', false), pick('download', false));
		}
	}
	const section = (label: string, picks: SyncPick[]): SyncPick[] =>
		picks.length > 0 ? [{ label, kind: vscode.QuickPickItemKind.Separator }, ...picks] : [];
	return [
		...section('Upload to the server', upload),
		...section('Download from the server', download),
		...section('Needs your decision — pick one direction', decide),
	];
}

/** Lets the user review the differences; resolves to the files to transfer each way. */
function chooseTransfers(target: SyncTarget, items: readonly SyncItem[]): Promise<{ uploads: SyncItem[]; downloads: SyncItem[] } | undefined> {
	return new Promise(resolve => {
		const quickPick = vscode.window.createQuickPick<SyncPick>();
		const picks = picksFor(items);
		quickPick.title = `Sync ${target.localRoot} ↔ ${target.server.name}:${target.remoteRoot}`;
		quickPick.placeholder = `${items.length} file(s) differ. Choose what to transfer, then press Enter.`;
		quickPick.canSelectMany = true;
		quickPick.matchOnDescription = true;
		quickPick.ignoreFocusOut = true;
		quickPick.items = picks;
		quickPick.selectedItems = picks.filter(pick => pick.picked);

		let settled = false;
		const finish = (result: { uploads: SyncItem[]; downloads: SyncItem[] } | undefined) => {
			settled = true;
			resolve(result);
			quickPick.dispose();
		};
		quickPick.onDidAccept(() => {
			const chosen = quickPick.selectedItems.filter(pick => pick.item && pick.direction);
			const both = chosen.filter(pick => chosen.some(other => other !== pick && other.item === pick.item));
			if (both.length > 0) {
				quickPick.placeholder = `Choose one direction for ${both[0].item!.relativePath}, not both.`;
				return;
			}
			finish({
				uploads: chosen.filter(pick => pick.direction === 'upload').map(pick => pick.item!),
				downloads: chosen.filter(pick => pick.direction === 'download').map(pick => pick.item!),
			});
		});
		quickPick.onDidHide(() => {
			if (!settled) {
				finish(undefined);
			}
		});
		quickPick.show();
	});
}

export function registerSyncCommands(services: CommandServices): vscode.Disposable[] {
	const { connections, outputChannel, treeProvider } = services;

	const sync = guarded('Sync failed', async (arg?: vscode.Uri | TreeNode) => {
		const target = await resolveTarget(arg);
		if (!target) {
			return;
		}
		const { server, localRoot, remoteRoot } = target;
		const client = await connections.getClient(server);

		let items: SyncItem[];
		try {
			items = await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: `Comparing with ${server.name}`, cancellable: true },
				(progress, token) =>
					compareFolders({
						server,
						client,
						localRoot,
						remoteRoot,
						knownFiles: knownFileStates,
						token,
						onFolder: folder => progress.report({ message: folder || path.basename(localRoot) }),
					})
			);
		} catch (err) {
			if (err instanceof CancelledError) {
				return;
			}
			throw err;
		}
		if (items.length === 0) {
			vscode.window.showInformationMessage(`${localRoot} and ${server.name}:${remoteRoot} match.`);
			return;
		}

		const chosen = await chooseTransfers(target, items);
		if (!chosen || chosen.uploads.length + chosen.downloads.length === 0) {
			return;
		}
		if (
			chosen.uploads.length > 0 &&
			!(await confirmProductionChange(server, `Upload ${chosen.uploads.length} file(s) to ${remoteRoot}.`))
		) {
			return;
		}

		const summary = await withTransferProgress(`Syncing with ${server.name}`, async run => {
			// Every file was reviewed in the list, so nothing asks again.
			run.localConflicts = 'overwrite';
			run.remoteConflicts = 'overwrite';
			const created = new Set<string>();
			for (const item of chosen.uploads) {
				const directory = dirnameRemote(item.remotePath);
				if (!created.has(directory)) {
					await client.mkdir(directory);
					created.add(directory);
				}
				await uploadPath(server, connections, outputChannel, item.localPath, item.remotePath, run);
			}
			for (const item of chosen.downloads) {
				await downloadPath(server, client, item.remotePath, item.localPath, false, run);
			}
		});
		for (const directory of new Set(chosen.uploads.map(item => dirnameRemote(item.remotePath)))) {
			treeProvider.refreshDirectory(server, directory);
		}
		if (!summary) {
			vscode.window.showInformationMessage('Sync cancelled.');
			return;
		}
		void notifyTransfer(
			`Synced with ${server.name}: ${chosen.uploads.length} uploaded, ${chosen.downloads.length} downloaded.`
		);
	});

	return [
		// One handler, three commands: `enablement` applies wherever a command appears, so the Explorer,
		// tree folders, and server rows each need their own.
		vscode.commands.registerCommand('remoteHostExplorer.syncWithServer', sync),
		vscode.commands.registerCommand('remoteHostExplorer.syncRemoteFolder', sync),
		vscode.commands.registerCommand('remoteHostExplorer.syncServer', sync),
	];
}
