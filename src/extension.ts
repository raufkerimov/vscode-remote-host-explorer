import * as vscode from 'vscode';
import {
	activateServerProfiles,
	getServerProfiles,
	hasFolderMappings,
	onDidChangeServerProfiles,
	resolveServerForLocalPath,
	whenServerProfilesLoaded,
} from './config/serverConfig';
import { migrateLegacyState } from './config/legacyState';
import { MappedFolderIndex } from './config/mappedFolderIndex';
import { ProductionDecorationProvider } from './config/productionGuard';
import { SecretsManager } from './config/secrets';
import { ConnectionManager } from './remote/ConnectionManager';
import { HostKeyStore } from './remote/hostKeys';
import { RemoteTreeProvider, type TreeNode } from './tree/RemoteTreeProvider';
import { TransferLogProvider } from './tree/TransferLogProvider';
import { SHOW_TRANSFERS_COMMAND, transferLog } from './remote/transferLog';
import { knownFileStates } from './remote/remoteState';
import { RemoteFileCache } from './editing/RemoteFileCache';
import { AutoUploadStatus } from './editing/autoUploadStatus';
import { registerServerCommands } from './commands/serverCommands';
import { registerFileCommands } from './commands/fileCommands';
import { autoUploadOnSave, registerTransferCommands } from './commands/transferCommands';
import { registerCompareCommands } from './commands/compareCommands';
import { registerSyncCommands } from './commands/syncCommands';
import type { CommandServices } from './commands/shared';

/** Context keys that drive `when` clauses for the Explorer and editor-title contributions. */
const CONTEXT_ACTIVE_EDITOR_MAPPED = 'remoteHostExplorer.activeEditorMapped';
const CONTEXT_HAS_MAPPINGS = 'remoteHostExplorer.hasMappings';

export async function activate(context: vscode.ExtensionContext) {
	const outputChannel = vscode.window.createOutputChannel('Remote Host Explorer');
	// Before anything reads host keys or tracked files under their current names.
	await migrateLegacyState(context.globalState);
	knownFileStates.attach(context.globalState);
	const secrets = new SecretsManager(context.secrets);
	const hostKeys = new HostKeyStore(context.globalState);
	const connections = new ConnectionManager(secrets, hostKeys);
	const fileCache = new RemoteFileCache(context, connections, outputChannel);
	// The tree needs the cache so drag-and-drop moves keep open editors pointed at the new paths.
	const treeProvider = new RemoteTreeProvider(connections, fileCache, outputChannel);

	const treeView = vscode.window.createTreeView<TreeNode>('remoteHostExplorer.servers', {
		treeDataProvider: treeProvider,
		dragAndDropController: treeProvider,
		canSelectMany: true,
	});

	const transferLogProvider = new TransferLogProvider(transferLog);
	const transfersView = vscode.window.createTreeView('remoteHostExplorer.transfers', { treeDataProvider: transferLogProvider });

	const services: CommandServices = {
		context,
		outputChannel,
		secrets,
		hostKeys,
		connections,
		treeProvider,
		treeView,
		fileCache,
		clipboard: {},
	};

	// Persisted tracking can outlive the cache files it points at (manual cleanup, storage reset).
	void fileCache.pruneMissingFiles();
	updateContextKeys();

	context.subscriptions.push(
		outputChannel,
		activateServerProfiles(outputChannel),
		vscode.window.registerFileDecorationProvider(new ProductionDecorationProvider()),
		// Greys out the Explorer's upload action for items outside every mapping.
		new MappedFolderIndex(outputChannel),
		new AutoUploadStatus(),
		treeView,
		transferLogProvider,
		transfersView,
		vscode.commands.registerCommand('remoteHostExplorer.clearTransfers', () => transferLog.clear()),
		vscode.commands.registerCommand(SHOW_TRANSFERS_COMMAND, async () => {
			// Focusing opens the panel even when it is closed; revealing then points at the transfer the
			// notification was about, so the click visibly lands somewhere.
			try {
				await vscode.commands.executeCommand('remoteHostExplorer.transfers.focus');
			} catch {
				// After an in-place update the new code runs, but views declared in package.json only appear
				// once the window reloads; without this the click would do nothing at all.
				const reload = 'Reload Window';
				const choice = await vscode.window.showWarningMessage(
					'The Transfers panel appears after VS Code reloads the window.',
					reload
				);
				if (choice === reload) {
					await vscode.commands.executeCommand('workbench.action.reloadWindow');
				}
				return;
			}
			const record = transferLog.lastFinished;
			if (record) {
				await transfersView.reveal(record, { select: true, focus: true, expand: true });
			}
		}),
		new vscode.Disposable(() => {
			void connections.disposeAll();
		}),

		// Keeps the connected/disconnected indicator accurate even when a connection is made implicitly
		// (e.g. Test Connection, upload/download, auto-upload) rather than via the explicit Connect action.
		connections.onDidChangeConnection(serverId => treeProvider.refreshConnectionState(serverId)),

		vscode.window.onDidChangeActiveTextEditor(() => updateContextKeys()),
		onDidChangeServerProfiles(() => {
			updateContextKeys();
			treeProvider.refresh();
		}),

		...registerServerCommands(services),
		...registerFileCommands(services),
		...registerTransferCommands(services),
		...registerCompareCommands(services),
		...registerSyncCommands(services),

		vscode.workspace.onDidSaveTextDocument(async document => {
			// Each half is isolated: a failing re-upload of a cached remote file must not prevent
			// auto-upload from running, and neither may surface as an unhandled rejection.
			try {
				await whenServerProfilesLoaded();
				await fileCache.handleSave(document, getServerProfiles());
			} catch (err) {
				outputChannel.appendLine(`Upload on save failed for ${document.uri.fsPath}: ${(err as Error).message}`);
				vscode.window.showErrorMessage(`Failed to upload "${document.fileName}": ${(err as Error).message}`);
			}
			await autoUploadOnSave(document, services);
		})
	);
}

function updateContextKeys(): void {
	const uri = vscode.window.activeTextEditor?.document.uri;
	const activeEditorMapped =
		uri?.scheme === 'file' ? Boolean(resolveServerForLocalPath(uri.fsPath)) : false;
	const hasMappings = getServerProfiles().some(hasFolderMappings);

	void vscode.commands.executeCommand('setContext', CONTEXT_ACTIVE_EDITOR_MAPPED, activeEditorMapped);
	void vscode.commands.executeCommand('setContext', CONTEXT_HAS_MAPPINGS, hasMappings);
}

export function deactivate(): Promise<void> {
	return knownFileStates.flush();
}
