import * as assert from 'assert';
import * as path from 'path';
import { isIgnored, resolveServerForLocalPathIn, type ServerProfile } from '../config/serverConfig';

function profile(overrides: Partial<ServerProfile> & Pick<ServerProfile, 'id'>): ServerProfile {
	return {
		name: overrides.id,
		protocol: 'sftp',
		host: 'example.com',
		remoteRoot: '/var/www',
		...overrides,
	};
}

/** Absolute path in the platform's own syntax, so the tests read the same on Windows and POSIX. */
function local(...segments: string[]): string {
	return path.resolve(path.sep, ...segments);
}

suite('resolveServerForLocalPathIn', () => {
	test('returns undefined when nothing maps the file', () => {
		const servers = [profile({ id: 'a' })];
		assert.strictEqual(resolveServerForLocalPathIn(servers, local('projects', 'x.txt')), undefined);
	});

	test('maps a nested file onto the remote root', () => {
		const servers = [profile({ id: 'a', localPath: local('projects', 'site'), remoteRoot: '/var/www' })];
		const result = resolveServerForLocalPathIn(servers, local('projects', 'site', 'src', 'index.php'));
		assert.strictEqual(result?.server.id, 'a');
		assert.strictEqual(result?.remotePath, '/var/www/src/index.php');
		assert.strictEqual(result?.relativePath, 'src/index.php');
	});

	test('maps the mapping root itself to the remote root', () => {
		const servers = [profile({ id: 'a', localPath: local('projects', 'site'), remoteRoot: '/var/www/' })];
		const result = resolveServerForLocalPathIn(servers, local('projects', 'site'));
		assert.strictEqual(result?.remotePath, '/var/www');
		assert.strictEqual(result?.relativePath, '');
	});

	test('picks the longest matching mapping, ignoring trailing separators', () => {
		const servers = [
			// The trailing separator used to inflate this profile's apparent specificity.
			profile({ id: 'outer', localPath: local('projects') + path.sep, remoteRoot: '/outer' }),
			profile({ id: 'inner', localPath: local('projects', 'site'), remoteRoot: '/inner' }),
		];
		const result = resolveServerForLocalPathIn(servers, local('projects', 'site', 'a.txt'));
		assert.strictEqual(result?.server.id, 'inner');
		assert.strictEqual(result?.remotePath, '/inner/a.txt');
	});

	test('does not match a sibling directory that shares a prefix', () => {
		const servers = [profile({ id: 'a', localPath: local('projects', 'site') })];
		assert.strictEqual(
			resolveServerForLocalPathIn(servers, local('projects', 'site-backup', 'a.txt')),
			undefined
		);
	});

	test('profiles without a localPath are skipped', () => {
		const servers = [profile({ id: 'a' }), profile({ id: 'b', localPath: local('projects') })];
		const result = resolveServerForLocalPathIn(servers, local('projects', 'a.txt'));
		assert.strictEqual(result?.server.id, 'b');
	});

	test('a remote root of / does not produce a doubled separator', () => {
		const servers = [profile({ id: 'a', localPath: local('projects'), remoteRoot: '/' })];
		const result = resolveServerForLocalPathIn(servers, local('projects', 'a.txt'));
		assert.strictEqual(result?.remotePath, '/a.txt');
	});

	if (process.platform === 'win32' || process.platform === 'darwin') {
		test('path comparison is case-insensitive on case-insensitive filesystems', () => {
			const servers = [profile({ id: 'a', localPath: local('Projects', 'Site') })];
			const result = resolveServerForLocalPathIn(servers, local('projects', 'site', 'a.txt'));
			assert.strictEqual(result?.server.id, 'a');
		});
	}
});

suite('isIgnored', () => {
	test('honours the profile ignore patterns', () => {
		const server = profile({ id: 'a', ignoreGlobs: ['**/node_modules/**', '*.log'] });
		assert.ok(isIgnored(server, 'node_modules/x/index.js'));
		assert.ok(isIgnored(server, 'build.log'));
		assert.ok(!isIgnored(server, 'src/index.ts'));
	});

	test('an explicit empty pattern list ignores nothing', () => {
		assert.ok(!isIgnored(profile({ id: 'a', ignoreGlobs: [] }), 'node_modules/x'));
	});

	test('a profile with no ignoreGlobs field falls back to the defaults', () => {
		assert.ok(isIgnored(profile({ id: 'a' }), 'node_modules/x'));
	});
});
