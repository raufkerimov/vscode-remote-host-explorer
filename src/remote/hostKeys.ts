import * as crypto from 'crypto';
import * as vscode from 'vscode';
import type { HostKeyPolicy } from './RemoteClient';

const STATE_KEY = 'remoteHostExplorer.knownHostKeys';

type KnownHosts = Record<string, string>;

/** OpenSSH-style fingerprint, e.g. `SHA256:Ao3v0…` — the same string `ssh` prints. */
export function fingerprint(hostKey: Buffer): string {
	const digest = crypto.createHash('sha256').update(hostKey).digest('base64').replace(/=+$/, '');
	return `SHA256:${digest}`;
}

function hostId(host: string, port: number): string {
	return `${host}:${port}`;
}

/**
 * Trust-on-first-use store for SSH host keys.
 *
 * ssh2 auto-accepts any host key when no `hostVerifier` is supplied, which leaves every connection open
 * to a man-in-the-middle. This mirrors what `ssh` itself does: remember the key the first time, and
 * refuse loudly if it ever changes.
 */
export class HostKeyStore {
	constructor(private readonly state: vscode.Memento) {}

	private read(): KnownHosts {
		return this.state.get<KnownHosts>(STATE_KEY, {});
	}

	private async write(hosts: KnownHosts): Promise<void> {
		await this.state.update(STATE_KEY, hosts);
	}

	/** Synchronous check used inside the SSH handshake; never prompts. */
	isTrusted(host: string, port: number, hostKey: Buffer): boolean {
		return this.read()[hostId(host, port)] === fingerprint(hostKey);
	}

	/** Builds the policy pair a {@link SftpRemoteClient} needs for a given profile. */
	policyFor(serverName: string, host: string, port: number): HostKeyPolicy {
		return {
			isTrusted: hostKey => this.isTrusted(host, port, hostKey),
			confirm: hostKey => this.confirm(serverName, host, port, hostKey),
		};
	}

	/**
	 * Prompts for an unknown or changed host key and remembers it when accepted. Called outside the
	 * handshake so a slow answer cannot time the connection out.
	 */
	async confirm(serverName: string, host: string, port: number, hostKey: Buffer): Promise<boolean> {
		const id = hostId(host, port);
		const presented = fingerprint(hostKey);
		const known = this.read()[id];

		if (known === presented) {
			return true;
		}

		if (known === undefined) {
			const choice = await vscode.window.showWarningMessage(
				`The authenticity of host "${id}" can't be established.`,
				{
					modal: true,
					detail:
						`Server profile: ${serverName}\nKey fingerprint: ${presented}\n\n` +
						'Verify this fingerprint with your server administrator before continuing. ' +
						'If you connect now, this key will be remembered and you will be warned if it ever changes.',
				},
				'Connect and Remember'
			);
			if (choice !== 'Connect and Remember') {
				return false;
			}
			await this.write({ ...this.read(), [id]: presented });
			return true;
		}

		const choice = await vscode.window.showWarningMessage(
			`REMOTE HOST IDENTIFICATION HAS CHANGED for "${id}".`,
			{
				modal: true,
				detail:
					`Server profile: ${serverName}\nExpected: ${known}\nReceived: ${presented}\n\n` +
					'This may mean someone is intercepting the connection, or the server was legitimately rebuilt. ' +
					'Do not continue unless you know why the key changed.',
			},
			'Trust the New Key'
		);
		if (choice !== 'Trust the New Key') {
			return false;
		}
		await this.write({ ...this.read(), [id]: presented });
		return true;
	}

	/** Drops a remembered key, so the next connection is treated as first contact again. */
	async forget(host: string, port: number): Promise<void> {
		const hosts = this.read();
		delete hosts[hostId(host, port)];
		await this.write(hosts);
	}
}
