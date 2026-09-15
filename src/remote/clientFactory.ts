import type { RemoteProtocol, ServerProfile } from '../config/serverConfig';
import type { SecretsManager } from '../config/secrets';
import { DEFAULT_FTP_PORT, FtpRemoteClient, ftpSecurityFor } from './FtpClient';
import type { HostKeyStore } from './hostKeys';
import type { RemoteClient, RemoteConnectionOptions } from './RemoteClient';
import { SftpRemoteClient } from './SftpClient';

export const DEFAULT_SFTP_PORT = 22;

export function defaultPortFor(protocol: RemoteProtocol): number {
	return protocol === 'sftp' ? DEFAULT_SFTP_PORT : DEFAULT_FTP_PORT;
}

/** Builds a client for already-resolved connection options. Used by the pool and by the server form. */
export function buildRemoteClient(
	protocol: RemoteProtocol,
	options: RemoteConnectionOptions,
	onClose?: () => void
): RemoteClient {
	switch (protocol) {
		case 'sftp':
			return new SftpRemoteClient(options, onClose);
		case 'ftp':
		case 'ftps':
			return new FtpRemoteClient(options, ftpSecurityFor(protocol, options.port ?? DEFAULT_FTP_PORT), onClose);
		default:
			// Reachable only if `remoteHostExplorer.servers` was hand-edited with an unsupported protocol.
			throw new Error(`Protocol "${String(protocol)}" is not supported.`);
	}
}

/**
 * Where the running ssh-agent listens. On Windows the built-in OpenSSH agent uses a fixed named pipe, so
 * it works even when `SSH_AUTH_SOCK` isn't set. Pure so it can be unit tested.
 */
export function sshAgentSocket(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform
): string | undefined {
	if (env.SSH_AUTH_SOCK) {
		return env.SSH_AUTH_SOCK;
	}
	return platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined;
}

export const MISSING_SSH_AGENT_MESSAGE =
	'No SSH agent was found: SSH_AUTH_SOCK is not set in the environment VS Code was started from. ' +
	'Start ssh-agent, add your key with "ssh-add", and restart VS Code, or use private key authentication instead.';

/** Agent socket for a profile that asked for agent authentication; throws a readable error when there is none. */
export function requireSshAgentSocket(): string {
	const socket = sshAgentSocket();
	if (!socket) {
		throw new Error(MISSING_SSH_AGENT_MESSAGE);
	}
	return socket;
}

export async function createRemoteClient(
	server: ServerProfile,
	secrets: SecretsManager,
	hostKeys: HostKeyStore,
	onClose?: () => void
): Promise<RemoteClient> {
	const port = server.port ?? defaultPortFor(server.protocol);
	const password = await secrets.getPassword(server.id);

	if (server.protocol !== 'sftp') {
		// FTP has no key authentication and no SSH host keys.
		return buildRemoteClient(server.protocol, { host: server.host, port, username: server.username, password }, onClose);
	}

	// Both credentials are offered when both are present: ssh2 tries the key first and falls back to the
	// password, which is what multi-factor setups need. The server form clears whichever one does not
	// apply, so a profile edited from key auth to password auth no longer carries a stale key path.
	const agent = server.useSshAgent ? requireSshAgentSocket() : undefined;
	return buildRemoteClient(
		'sftp',
		{
			host: server.host,
			port,
			username: server.username,
			password,
			privateKeyPath: server.privateKeyPath,
			passphrase: await secrets.getPassphrase(server.id),
			agent,
			hostKeyPolicy: hostKeys.policyFor(server.name, server.host, port),
		},
		onClose
	);
}
