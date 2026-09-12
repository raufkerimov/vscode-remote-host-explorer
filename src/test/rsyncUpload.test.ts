import * as assert from 'assert';
import { buildRsyncArgs, missingRsyncMessage } from '../remote/rsyncUpload';
import type { ServerProfile } from '../config/serverConfig';

function profile(overrides: Partial<ServerProfile> = {}): ServerProfile {
	return {
		id: 'a',
		name: 'a',
		protocol: 'sftp',
		host: 'example.com',
		remoteRoot: '/var/www',
		...overrides,
	};
}

function sshCommandOf(args: string[]): string {
	return args[args.indexOf('-e') + 1];
}

suite('buildRsyncArgs', () => {
	test('quotes a private key path so a space cannot split the ssh command', () => {
		const args = buildRsyncArgs(
			profile({ privateKeyPath: '/Users/me/My Keys/id_rsa', port: 2222 }),
			{ localPath: '/local/a.txt', remotePath: '/var/www/a.txt', isDirectory: false }
		);
		const ssh = sshCommandOf(args);
		assert.ok(ssh.includes(`-i '/Users/me/My Keys/id_rsa'`), ssh);
		assert.ok(ssh.includes('-p 2222'), ssh);
	});

	test('escapes an embedded single quote', () => {
		const args = buildRsyncArgs(
			profile({ privateKeyPath: "/keys/o'brien" }),
			{ localPath: '/local/a.txt', remotePath: '/var/www/a.txt', isDirectory: false }
		);
		assert.ok(sshCommandOf(args).includes(`'/keys/o'\\''brien'`), sshCommandOf(args));
	});

	test('disables interactive ssh prompts so a transfer cannot hang', () => {
		const args = buildRsyncArgs(profile(), {
			localPath: '/local/a.txt',
			remotePath: '/var/www/a.txt',
			isDirectory: false,
		});
		assert.ok(sshCommandOf(args).includes('-o BatchMode=yes'));
	});

	test('appends a trailing slash for directories so contents are synced, not nested', () => {
		const fileArgs = buildRsyncArgs(profile(), {
			localPath: '/local/src',
			remotePath: '/var/www/src',
			isDirectory: false,
		});
		const dirArgs = buildRsyncArgs(profile(), {
			localPath: '/local/src',
			remotePath: '/var/www/src',
			isDirectory: true,
		});
		assert.strictEqual(fileArgs[fileArgs.length - 2], '/local/src');
		// Without the trailing slash rsync would create /var/www/src/src.
		assert.strictEqual(dirArgs[dirArgs.length - 2], '/local/src/');
	});

	test('separates flags from paths with --', () => {
		const args = buildRsyncArgs(profile(), {
			localPath: '/local/a.txt',
			remotePath: '/var/www/a.txt',
			isDirectory: false,
		});
		assert.strictEqual(args[args.length - 3], '--');
		assert.strictEqual(args[args.length - 1], 'example.com:/var/www/a.txt');
	});

	test('includes the username in the destination when set', () => {
		const args = buildRsyncArgs(profile({ username: 'deploy' }), {
			localPath: '/local/a.txt',
			remotePath: '/var/www/a.txt',
			isDirectory: false,
		});
		assert.strictEqual(args[args.length - 1], 'deploy@example.com:/var/www/a.txt');
	});

	test('rejects an option-like host or username', () => {
		assert.throws(() =>
			buildRsyncArgs(profile({ host: '--rsh=evil' }), {
				localPath: '/local/a.txt',
				remotePath: '/x',
				isDirectory: false,
			})
		);
		assert.throws(() =>
			buildRsyncArgs(profile({ username: '-oProxyCommand=evil' }), {
				localPath: '/local/a.txt',
				remotePath: '/x',
				isDirectory: false,
			})
		);
	});
});

suite('missingRsyncMessage', () => {
	test('names a way to install rsync on each platform', () => {
		assert.match(missingRsyncMessage('win32'), /WSL|Git for Windows|MSYS2|Cygwin/);
		assert.match(missingRsyncMessage('darwin'), /brew install rsync|\/usr\/bin\/rsync/);
		assert.match(missingRsyncMessage('linux'), /apt install rsync|dnf install rsync/);
	});

	test('always offers the SFTP fallback, since rsync is optional', () => {
		for (const platform of ['win32', 'darwin', 'linux'] as NodeJS.Platform[]) {
			assert.match(missingRsyncMessage(platform), /Use rsync for uploads/);
		}
	});
});
