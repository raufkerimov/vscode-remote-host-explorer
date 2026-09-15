import * as assert from 'assert';
import type { ServerProfile } from '../config/serverConfig';
import { duplicateCredentialSource, type SubmittedForm } from '../webview/ServerFormPanel';

const original: ServerProfile = {
	id: 'orig',
	name: 'Production',
	protocol: 'sftp',
	host: 'example.com',
	username: 'deploy',
	remoteRoot: '/var/www/site',
};

function formFor(overrides: Partial<SubmittedForm> = {}): SubmittedForm {
	return {
		name: 'Production (copy)',
		protocol: 'sftp',
		host: 'example.com',
		port: '',
		username: 'deploy',
		authMethod: 'password',
		password: '',
		privateKeyPath: '',
		passphrase: '',
		remoteRoot: '/var/www/site/wp-content/themes/other',
		localPath: '',
		remoteMappedPath: '',
		autoUpload: false,
		ignoreGlobs: '',
		useRsyncForUpload: false,
		rsyncOptions: '',
		scope: 'project',
		...overrides,
	};
}

suite('duplicateCredentialSource', () => {
	test('a duplicate of the same server with different paths reuses the original credentials', () => {
		assert.strictEqual(duplicateCredentialSource(undefined, original, formFor()), original);
		assert.strictEqual(duplicateCredentialSource(undefined, original, formFor({ port: '22' })), original);
	});

	test('a duplicate pointed at another host, user, port, or protocol gets nothing', () => {
		for (const change of [{ host: 'evil.example.net' }, { username: 'root' }, { port: '2222' }, { protocol: 'ftp' as const }]) {
			assert.strictEqual(duplicateCredentialSource(undefined, original, formFor(change)), undefined, JSON.stringify(change));
		}
	});

	test('editing and adding never copy credentials', () => {
		assert.strictEqual(duplicateCredentialSource(original, original, formFor()), undefined);
		assert.strictEqual(duplicateCredentialSource(undefined, undefined, formFor()), undefined);
	});
});
