import * as vscode from 'vscode';
import { removeServerProfile, type ServerProfile } from '../config/serverConfig';
import { DEFAULT_SFTP_PORT } from '../remote/clientFactory';
import { ServerFormPanel } from '../webview/ServerFormPanel';
import { guarded, pickServer, type CommandServices } from './shared';

/** Drops any cached connection for the saved profile so edited host/credentials take effect immediately. */
async function handleServerSaved(services: CommandServices, profile: ServerProfile): Promise<void> {
	await services.connections.disconnect(profile.id);
	services.treeProvider.refresh();
}

export function registerServerCommands(services: CommandServices): vscode.Disposable[] {
	const { context, secrets, hostKeys, connections, treeProvider, treeView } = services;

	return [
		vscode.commands.registerCommand(
			'remoteHostExplorer.refresh',
			guarded('Failed to refresh', () => treeProvider.refresh())
		),

		vscode.commands.registerCommand(
			'remoteHostExplorer.addServer',
			guarded('Failed to open the server form', () =>
				ServerFormPanel.show(context, secrets, hostKeys, profile => void handleServerSaved(services, profile))
			)
		),

		vscode.commands.registerCommand(
			'remoteHostExplorer.editServer',
			guarded('Failed to open the server form', async (node?: { server: ServerProfile }) => {
				const server = node?.server ?? (await pickServer());
				if (!server) {
					return;
				}
				await ServerFormPanel.show(
					context,
					secrets,
					hostKeys,
					profile => void handleServerSaved(services, profile),
					server
				);
			})
		),

		vscode.commands.registerCommand(
			'remoteHostExplorer.removeServer',
			guarded('Failed to remove the server', async (node?: { server: ServerProfile }) => {
				const server = node?.server ?? (await pickServer());
				if (!server) {
					return;
				}
				const confirm = await vscode.window.showWarningMessage(
					`Remove server "${server.name}"?`,
					{ modal: true, detail: 'This also deletes its stored password and key passphrase.' },
					'Remove'
				);
				if (confirm !== 'Remove') {
					return;
				}
				await connections.disconnect(server.id);
				await secrets.deleteAll(server.id);
				if (server.protocol === 'sftp') {
					// Host keys are an SSH concept; FTP profiles never stored one.
					await hostKeys.forget(server.host, server.port ?? DEFAULT_SFTP_PORT);
				}
				await removeServerProfile(server.id);
				treeProvider.refresh();
			})
		),

		vscode.commands.registerCommand(
			'remoteHostExplorer.testConnection',
			guarded('Connection test failed', async (node?: { server: ServerProfile }) => {
				const server = node?.server ?? (await pickServer());
				if (!server) {
					return;
				}
				try {
					const client = await connections.getClient(server);
					await client.list(server.remoteRoot);
					vscode.window.showInformationMessage(`Connected to "${server.name}" successfully.`);
				} catch (err) {
					vscode.window.showErrorMessage(`Failed to connect to "${server.name}": ${(err as Error).message}`);
				}
			})
		),

		vscode.commands.registerCommand(
			'remoteHostExplorer.connect',
			guarded('Failed to connect', async (node?: { server: ServerProfile }) => {
				const server = node?.server ?? (await pickServer());
				if (!server) {
					return;
				}
				try {
					await connections.getClient(server);
				} catch (err) {
					vscode.window.showErrorMessage(`Failed to connect to "${server.name}": ${(err as Error).message}`);
					return;
				}
				try {
					// Best-effort auto-expand; the row's collapsible state may not have repainted yet, so
					// never let this fail the command.
					await treeView.reveal(treeProvider.serverNode(server), { expand: true, select: false, focus: false });
				} catch {
					// ignore
				}
			})
		),

		vscode.commands.registerCommand(
			'remoteHostExplorer.disconnect',
			guarded('Failed to disconnect', async (node?: { server: ServerProfile }) => {
				const server = node?.server ?? (await pickServer());
				if (!server) {
					return;
				}
				await connections.disconnect(server.id);
			})
		),
	];
}
