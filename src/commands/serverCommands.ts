import * as vscode from 'vscode';
import { getServerProfiles, removeServerProfile, type ServerProfile } from '../config/serverConfig';
import { defaultPortFor } from '../remote/clientFactory';
import { SftpRemoteClient } from '../remote/SftpClient';
import { remoteShellCommand, SshPseudoterminal } from '../remote/sshTerminal';
import type { TreeNode } from '../tree/RemoteTreeProvider';
import { dirnameRemote, normalizeRemote } from '../util/remotePath';
import { ServerFormPanel } from '../webview/ServerFormPanel';
import { guarded, pickServer, type CommandServices } from './shared';

/** Drops any cached connection for the saved profile so edited host/credentials take effect immediately. */
async function handleServerSaved(services: CommandServices, profile: ServerProfile): Promise<void> {
	await services.connections.disconnect(profile.id);
	services.treeProvider.refresh();
}

/**
 * The trust remembered for a server's endpoint: its SSH host key, or for FTPS the certificate accepted
 * for another host name. Plain FTP has neither.
 */
const TRUST = {
	sftp: { name: 'host key', forget: 'forget' },
	ftps: { name: 'accepted certificate', forget: 'forgetCertificate' },
} as const;

/** Trust is stored per host:port, so a profile is removed without forgetting it while another one uses it. */
export function sharesEndpoint(server: ServerProfile, others: readonly ServerProfile[]): boolean {
	const port = server.port ?? defaultPortFor(server.protocol);
	return others.some(
		other =>
			other.id !== server.id &&
			other.protocol === server.protocol &&
			other.host === server.host &&
			(other.port ?? defaultPortFor(other.protocol)) === port
	);
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
					{ existing: server }
				);
			})
		),

		vscode.commands.registerCommand(
			'remoteHostExplorer.duplicateServer',
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
					{ duplicateOf: server }
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
				const trust = server.protocol === 'ftp' ? undefined : TRUST[server.protocol];
				// Only profiles of this window are known; one in another project would simply ask again.
				if (trust && !sharesEndpoint(server, getServerProfiles())) {
					await hostKeys[trust.forget](server.host, server.port ?? defaultPortFor(server.protocol));
				}
				await removeServerProfile(server.id);
				treeProvider.refresh();
			})
		),

		...(['sftp', 'ftps'] as const).map(protocol =>
			vscode.commands.registerCommand(
				protocol === 'sftp' ? 'remoteHostExplorer.forgetHostKey' : 'remoteHostExplorer.forgetCertificate',
				guarded(`Failed to forget the ${TRUST[protocol].name}`, async (node?: { server: ServerProfile }) => {
					const server = node?.server;
					if (server?.protocol !== protocol) {
						return;
					}
					const { name, forget } = TRUST[protocol];
					const port = server.port ?? defaultPortFor(protocol);
					const endpoint = `${server.host}:${port}`;
					if (!(await hostKeys[forget](server.host, port))) {
						void vscode.window.showInformationMessage(`No ${name} is remembered for "${endpoint}".`);
						return;
					}
					void vscode.window.showInformationMessage(
						`Forgot the ${name} of "${endpoint}". The next connection will ask you to trust it again.`
					);
				})
			)
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
			'remoteHostExplorer.openSshTerminal',
			guarded('Could not open an SSH terminal', async (node?: TreeNode) => {
				const server = node?.server ?? (await pickServer());
				if (!server) {
					return;
				}
				if (server.protocol !== 'sftp') {
					vscode.window.showWarningMessage('SSH terminals are only available for SFTP servers.');
					return;
				}
				const client = await connections.getClient(server);
				if (!(client instanceof SftpRemoteClient)) {
					return;
				}
				const remoteDir = node?.kind === 'file'
					? node.entry.isDirectory ? normalizeRemote(node.entry.path) : dirnameRemote(node.entry.path)
					: normalizeRemote(server.remoteRoot) || '/';
				const command = remoteShellCommand(remoteDir);
				const terminal = vscode.window.createTerminal({
					name: `SSH: ${server.name}`,
					pty: new SshPseudoterminal(size => client.openTerminal(command, size)),
					iconPath: new vscode.ThemeIcon('terminal'),
				});
				terminal.show();
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
