import * as vscode from 'vscode';

const PASSWORD_PREFIX = 'remoteHostExplorer.password.';
const PASSPHRASE_PREFIX = 'remoteHostExplorer.passphrase.';
/** Version 0.1.0 stored secrets under these prefixes. */
const LEGACY_PASSWORD_PREFIX = 'remoteHostViewer.password.';
const LEGACY_PASSPHRASE_PREFIX = 'remoteHostViewer.passphrase.';

export class SecretsManager {
	constructor(private readonly secrets: vscode.SecretStorage) {}

	/**
	 * Secret storage can't be listed, so a secret saved by 0.1.0 is moved to its current key the first
	 * time it is asked for.
	 */
	private async getMigrating(key: string, legacyKey: string): Promise<string | undefined> {
		const value = await this.secrets.get(key);
		if (value !== undefined) {
			return value;
		}
		const legacy = await this.secrets.get(legacyKey);
		if (legacy !== undefined) {
			await this.secrets.store(key, legacy);
			await this.secrets.delete(legacyKey);
		}
		return legacy;
	}

	getPassword(serverId: string): Promise<string | undefined> {
		return this.getMigrating(PASSWORD_PREFIX + serverId, LEGACY_PASSWORD_PREFIX + serverId);
	}

	setPassword(serverId: string, password: string): Thenable<void> {
		return this.secrets.store(PASSWORD_PREFIX + serverId, password);
	}

	async deletePassword(serverId: string): Promise<void> {
		await this.secrets.delete(PASSWORD_PREFIX + serverId);
		await this.secrets.delete(LEGACY_PASSWORD_PREFIX + serverId);
	}

	getPassphrase(serverId: string): Promise<string | undefined> {
		return this.getMigrating(PASSPHRASE_PREFIX + serverId, LEGACY_PASSPHRASE_PREFIX + serverId);
	}

	setPassphrase(serverId: string, passphrase: string): Thenable<void> {
		return this.secrets.store(PASSPHRASE_PREFIX + serverId, passphrase);
	}

	async deletePassphrase(serverId: string): Promise<void> {
		await this.secrets.delete(PASSPHRASE_PREFIX + serverId);
		await this.secrets.delete(LEGACY_PASSPHRASE_PREFIX + serverId);
	}

	async deleteAll(serverId: string): Promise<void> {
		await this.deletePassword(serverId);
		await this.deletePassphrase(serverId);
	}
}
