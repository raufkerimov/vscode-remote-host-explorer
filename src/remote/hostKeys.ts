import * as crypto from 'crypto';
import type { PeerCertificate } from 'tls';
import * as vscode from 'vscode';
import type { CertificatePolicy, HostKeyPolicy } from './RemoteClient';

const STATE_KEY = 'remoteHostExplorer.knownHostKeys';
const CERTIFICATE_STATE_KEY = 'remoteHostExplorer.acceptedCertificateNames';

type KnownHosts = Record<string, string>;

/**
 * What an accepted FTPS certificate is remembered by: the names it was issued for, e.g.
 * `DNS:*.prod.example-host.net, DNS:prod.example-host.net`. Names rather than a fingerprint, because
 * hosting providers renew certificates every few months and the chain is verified on every connection.
 */
export function certificateNames(certificate: PeerCertificate): string {
	if (certificate.subjectaltname) {
		return certificate.subjectaltname;
	}
	return certificate.subject?.CN ? `CN:${certificate.subject.CN}` : '';
}

/** `DNS:a, DNS:b` → `a, b`, for showing to the user. */
function displayNames(names: string): string {
	return names.replace(/\b(?:DNS|IP Address|CN):/g, '');
}

/** OpenSSH-style fingerprint, e.g. `SHA256:Ao3v0…` — the same string `ssh` prints. */
export function fingerprint(hostKey: Buffer): string {
	const digest = crypto.createHash('sha256').update(hostKey).digest('base64').replace(/=+$/, '');
	return `SHA256:${digest}`;
}

function hostId(host: string, port: number): string {
	return `${host}:${port}`;
}

/** Reads fall through to `base`; writes stay in memory. */
export class DraftMemento implements vscode.Memento {
	private readonly values = new Map<string, unknown>();

	constructor(private readonly base: vscode.Memento) {}

	keys(): readonly string[] {
		return [...new Set([...this.base.keys(), ...this.values.keys()])];
	}

	get<T>(key: string, defaultValue?: T): T | undefined {
		return this.values.has(key) ? (this.values.get(key) as T) : this.base.get<T>(key, defaultValue as T);
	}

	async update(key: string, value: unknown): Promise<void> {
		this.values.set(key, value);
	}
}

/**
 * Trust-on-first-use store for SSH host keys, and for FTPS certificates issued to another host name.
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
	async forget(host: string, port: number): Promise<boolean> {
		return this.removeEntry(STATE_KEY, host, port);
	}

	private async removeEntry(stateKey: string, host: string, port: number): Promise<boolean> {
		const entries = this.state.get<KnownHosts>(stateKey, {});
		const id = hostId(host, port);
		if (!(id in entries)) {
			return false;
		}
		const remaining = { ...entries };
		delete remaining[id];
		await this.state.update(stateKey, remaining);
		return true;
	}

	/**
	 * A store for the server form's Test and Browse: it sees everything trusted so far, but what the user
	 * accepts there stays in memory, so a server that is never saved leaves nothing behind. Saving the
	 * server keeps its endpoint's decisions with {@link keepFrom}.
	 */
	draft(): HostKeyStore {
		return new HostKeyStore(new DraftMemento(this.state));
	}

	/** Saves what `draft` (from {@link draft}) accepted for one endpoint: the host key for SFTP, the certificate for FTPS. */
	async keepFrom(draft: HostKeyStore, protocol: string, host: string, port: number): Promise<void> {
		const stateKey = protocol === 'sftp' ? STATE_KEY : protocol === 'ftps' ? CERTIFICATE_STATE_KEY : undefined;
		if (!stateKey) {
			return;
		}
		const id = hostId(host, port);
		const accepted = draft.state.get<KnownHosts>(stateKey, {})[id];
		const entries = this.state.get<KnownHosts>(stateKey, {});
		if (accepted !== undefined && entries[id] !== accepted) {
			await this.state.update(stateKey, { ...entries, [id]: accepted });
		}
	}

	private readCertificates(): KnownHosts {
		return this.state.get<KnownHosts>(CERTIFICATE_STATE_KEY, {});
	}

	/** Synchronous check used inside the TLS handshake; never prompts. */
	isCertificateAccepted(host: string, port: number, certificate: PeerCertificate): boolean {
		const names = certificateNames(certificate);
		return names !== '' && this.readCertificates()[hostId(host, port)] === names;
	}

	/** Builds the policy pair an FTPS {@link FtpRemoteClient} needs for a given profile. */
	certificatePolicyFor(serverName: string, host: string, port: number): CertificatePolicy {
		return {
			isTrusted: certificate => this.isCertificateAccepted(host, port, certificate),
			confirm: certificate => this.confirmCertificate(serverName, host, port, certificate),
		};
	}

	/**
	 * Asks whether a valid certificate that names other hosts may stand in for this one, and remembers its
	 * names when accepted. Called outside the handshake so a slow answer cannot time the connection out.
	 */
	async confirmCertificate(serverName: string, host: string, port: number, certificate: PeerCertificate): Promise<boolean> {
		const id = hostId(host, port);
		const names = certificateNames(certificate);
		if (names === '') {
			return false;
		}
		const known = this.readCertificates()[id];
		if (known === names) {
			return true;
		}

		const issuer = certificate.issuer?.O || certificate.issuer?.CN || 'unknown';
		const facts =
			`Server profile: ${serverName}\nCertificate issued for: ${displayNames(names)}\nIssued by: ${issuer}\n` +
			`SHA-256 fingerprint: ${certificate.fingerprint256}\n\n`;
		const accept = known === undefined ? 'Trust and Connect' : 'Trust the New Certificate';
		const choice = known === undefined
			? await vscode.window.showWarningMessage(
				`The TLS certificate of "${id}" was issued for a different host name.`,
				{
					modal: true,
					detail:
						facts +
						'Shared hosting often presents the provider\'s certificate instead of one for your domain. ' +
						'The certificate is otherwise valid and signed by a trusted authority. Continue only if these ' +
						'names belong to your hosting provider. They will be accepted for this server from now on, and ' +
						'you will be asked again if they change.',
				},
				accept
			)
			: await vscode.window.showWarningMessage(
				`The TLS certificate of "${id}" now names different hosts.`,
				{
					modal: true,
					detail:
						facts +
						`Previously accepted: ${displayNames(known)}\n\n` +
						'This may mean someone is intercepting the connection, or the hosting provider changed its ' +
						'certificate. Do not continue unless you know why it changed.',
				},
				accept
			);
		if (choice !== accept) {
			return false;
		}
		await this.state.update(CERTIFICATE_STATE_KEY, { ...this.readCertificates(), [id]: names });
		return true;
	}

	/** Drops a remembered certificate, so the next connection asks again. */
	async forgetCertificate(host: string, port: number): Promise<boolean> {
		return this.removeEntry(CERTIFICATE_STATE_KEY, host, port);
	}
}
