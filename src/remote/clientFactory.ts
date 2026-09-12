import type { RemoteProtocol, ServerProfile } from '../config/serverConfig';
import type { SecretsManager } from '../config/secrets';
import { DEFAULT_FTP_PORT, FtpRemoteClient } from './FtpClient';
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
			return new FtpRemoteClient(options, protocol === 'ftps', onClose);
		default:
			// Reachable only if `remoteHostExplorer.servers` was hand-edited with an unsupported protocol.
			throw new Error(`Protocol "${String(protocol)}" is not supported.`);
	}
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
	return buildRemoteClient(
		'sftp',
		{
			host: server.host,
			port,
			username: server.username,
			password,
			privateKeyPath: server.privateKeyPath,
			passphrase: await secrets.getPassphrase(server.id),
			hostKeyPolicy: hostKeys.policyFor(server.name, server.host, port),
		},
		onClose
	);
}
