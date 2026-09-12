import * as assert from 'assert';
import * as path from 'path';
import type * as vscode from 'vscode';
import { folderIndexForLocalPath, parseProjectServers, withProjectServers } from '../config/projectServerFile';
import { migrateLegacyState } from '../config/legacyState';
import { SecretsManager } from '../config/secrets';
import type { ServerProfile } from '../config/serverConfig';

function profile(id: string): ServerProfile {
	return { id, name: id, protocol: 'sftp', host: `${id}.example.com`, remoteRoot: '/' };
}

function local(...segments: string[]): string {
	return path.resolve(path.sep, ...segments);
}

suite('parseProjectServers', () => {
	test('an empty or missing file has no servers', () => {
		assert.deepStrictEqual(parseProjectServers(''), []);
		assert.deepStrictEqual(parseProjectServers('  \n'), []);
		assert.deepStrictEqual(parseProjectServers('{}'), []);
	});

	test('accepts comments and trailing commas, as VS Code allows in .vscode files', () => {
		const text = '{\n  // staging only\n  "servers": [\n    { "id": "a", "name": "a", "protocol": "sftp", "host": "h", "remoteRoot": "/" },\n  ],\n}';
		assert.deepStrictEqual(parseProjectServers(text).map(server => server.id), ['a']);
	});

	test('a syntax error is reported with its line instead of reading as an empty list', () => {
		assert.throws(() => parseProjectServers('{\n  "servers": [\n    {\n}'), /line \d/);
	});

	test('rejects content that is not a list of server objects', () => {
		assert.throws(() => parseProjectServers('[]'), /object/);
		assert.throws(() => parseProjectServers('{ "servers": {} }'), /list/);
		assert.throws(() => parseProjectServers('{ "servers": ["a"] }'), /list/);
	});
});

suite('withProjectServers', () => {
	test('creates the document when the file does not exist yet', () => {
		const text = withProjectServers('', [profile('a')]);
		assert.deepStrictEqual(parseProjectServers(text), [profile('a')]);
		assert.ok(text.endsWith('\n'));
	});

	test('keeps comments and other keys while replacing the list', () => {
		const original = '{\n  // shared with the team\n  "$schema": "x",\n  "servers": []\n}\n';
		const text = withProjectServers(original, [profile('a'), profile('b')]);
		assert.ok(text.includes('// shared with the team'));
		assert.ok(text.includes('"$schema": "x"'));
		assert.deepStrictEqual(parseProjectServers(text).map(server => server.id), ['a', 'b']);
	});
});

suite('folderIndexForLocalPath', () => {
	const folders = [local('work', 'api'), local('work', 'site'), local('work', 'site', 'theme')];

	test('uses the first folder when the server has no local folder', () => {
		assert.strictEqual(folderIndexForLocalPath(folders, undefined), 0);
	});

	test('uses the deepest folder that contains the local folder', () => {
		assert.strictEqual(folderIndexForLocalPath(folders, local('work', 'site', 'public')), 1);
		assert.strictEqual(folderIndexForLocalPath(folders, local('work', 'site', 'theme')), 2);
	});

	test('a sibling with a shared name prefix is not a match', () => {
		assert.strictEqual(folderIndexForLocalPath(folders, local('work', 'site-old')), 0);
	});
});

function fakeMemento(initial: Record<string, unknown>): vscode.Memento & { values: Map<string, unknown> } {
	const values = new Map(Object.entries(initial));
	return {
		values,
		keys: () => [...values.keys()],
		get: (<T>(key: string, fallback?: T) => (values.has(key) ? (values.get(key) as T) : fallback)) as vscode.Memento['get'],
		update: async (key: string, value: unknown) => {
			if (value === undefined) {
				values.delete(key);
			} else {
				values.set(key, value);
			}
		},
	};
}

suite('migrating 0.1.0 state', () => {
	test('host keys and tracked files move to their current keys', async () => {
		const memento = fakeMemento({
			'remoteHostViewer.knownHostKeys': { 'example.com:22': 'SHA256:abc' },
			'remoteHostViewer.trackedRemoteFiles': { '/cache/a': { serverId: 's', remotePath: '/a', remoteModifiedAt: 1 } },
		});
		await migrateLegacyState(memento);
		assert.deepStrictEqual(memento.get('remoteHostExplorer.knownHostKeys'), { 'example.com:22': 'SHA256:abc' });
		assert.ok(memento.get('remoteHostExplorer.trackedRemoteFiles'));
		assert.deepStrictEqual([...memento.values.keys()].filter(key => key.startsWith('remoteHostViewer.')), []);
	});

	test('a value already under the current key is not overwritten', async () => {
		const memento = fakeMemento({
			'remoteHostViewer.knownHostKeys': { 'example.com:22': 'SHA256:old' },
			'remoteHostExplorer.knownHostKeys': { 'example.com:22': 'SHA256:new' },
		});
		await migrateLegacyState(memento);
		assert.deepStrictEqual(memento.get('remoteHostExplorer.knownHostKeys'), { 'example.com:22': 'SHA256:new' });
	});

	test('a password saved by 0.1.0 is found and moved on first use', async () => {
		const stored = new Map([['remoteHostViewer.password.s1', 'hunter2']]);
		const storage = {
			get: async (key: string) => stored.get(key),
			store: async (key: string, value: string) => void stored.set(key, value),
			delete: async (key: string) => void stored.delete(key),
		} as unknown as vscode.SecretStorage;
		const secrets = new SecretsManager(storage);

		assert.strictEqual(await secrets.getPassword('s1'), 'hunter2');
		assert.deepStrictEqual([...stored.keys()], ['remoteHostExplorer.password.s1']);
		assert.strictEqual(await secrets.getPassphrase('s1'), undefined);
	});
});
