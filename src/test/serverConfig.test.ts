import * as assert from 'assert';
import * as path from 'path';
import { expandHome } from '../util/localPath';
import { isIgnored, localPathForRemote, resolveServerForLocalPathIn, type ServerProfile } from '../config/serverConfig';

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

suite('remote mapped folder', () => {
	// Browse the whole WordPress install, but map only the theme.
	const wordpress = profile({
		id: 'wp',
		remoteRoot: '/var/www/site',
		localPath: local('projects', 'my-theme'),
		remoteMappedPath: '/var/www/site/wp-content/themes/my-theme',
	});

	test('local files resolve against the remote mapped folder, not the root', () => {
		const result = resolveServerForLocalPathIn([wordpress], local('projects', 'my-theme', 'css', 'style.css'));
		assert.strictEqual(result?.remotePath, '/var/www/site/wp-content/themes/my-theme/css/style.css');
		assert.strictEqual(
			resolveServerForLocalPathIn([wordpress], local('projects', 'my-theme'))?.remotePath,
			'/var/www/site/wp-content/themes/my-theme'
		);
	});

	test('remote items inside the mapped folder have a local counterpart', () => {
		assert.strictEqual(
			localPathForRemote(wordpress, '/var/www/site/wp-content/themes/my-theme/functions.php'),
			local('projects', 'my-theme', 'functions.php')
		);
		assert.strictEqual(localPathForRemote(wordpress, '/var/www/site/wp-content/themes/my-theme'), local('projects', 'my-theme'));
	});

	test('remote items outside the mapped folder have none', () => {
		assert.strictEqual(localPathForRemote(wordpress, '/var/www/site/wp-config.php'), undefined);
		assert.strictEqual(localPathForRemote(wordpress, '/var/www/site/wp-content/themes/my-theme-old/a.php'), undefined);
	});

	test('without a remote mapped folder the root is used, as before', () => {
		const plain = profile({ id: 'p', remoteRoot: '/var/www', localPath: local('projects', 'site') });
		assert.strictEqual(localPathForRemote(plain, '/var/www/index.php'), local('projects', 'site', 'index.php'));
		assert.strictEqual(localPathForRemote({ ...plain, localPath: undefined }, '/var/www/index.php'), undefined);
	});

	test('a remote name cannot escape the local folder', () => {
		const target = localPathForRemote(wordpress, '/var/www/site/wp-content/themes/my-theme/../../../../../etc/passwd');
		assert.strictEqual(target, undefined);
	});
});

suite('expandHome', () => {
	const home = local('home', 'me');

	test('expands a leading ~ to the home folder', () => {
		assert.strictEqual(expandHome('~/.ssh/id_rsa', home), path.join(home, '.ssh', 'id_rsa'));
		assert.strictEqual(expandHome('~', home), home);
	});

	test('leaves every other path alone', () => {
		assert.strictEqual(expandHome('/keys/id_rsa', home), '/keys/id_rsa');
		assert.strictEqual(expandHome('~other/id_rsa', home), '~other/id_rsa');
		assert.strictEqual(expandHome('keys/~/id_rsa', home), 'keys/~/id_rsa');
	});
});

