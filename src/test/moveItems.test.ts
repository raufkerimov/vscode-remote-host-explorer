import * as assert from 'assert';
import { moveRemoteItems, type ConflictDecision } from '../remote/moveItems';
import type { RemoteClient, RemoteFileEntry } from '../remote/RemoteClient';

/** In-memory remote filesystem: just enough of RemoteClient for move semantics. */
function fakeClient(existingPaths: string[]) {
	const paths = new Set(existingPaths);
	const calls: string[] = [];
	const client: Partial<RemoteClient> = {
		exists: async path => paths.has(path),
		delete: async path => {
			calls.push(`delete ${path}`);
			for (const candidate of [...paths]) {
				if (candidate === path || candidate.startsWith(`${path}/`)) {
					paths.delete(candidate);
				}
			}
		},
		rename: async (from, to) => {
			calls.push(`rename ${from} -> ${to}`);
			for (const candidate of [...paths]) {
				if (candidate === from || candidate.startsWith(`${from}/`)) {
					paths.delete(candidate);
					paths.add(to + candidate.slice(from.length));
				}
			}
		},
	};
	return { client: client as RemoteClient, paths, calls };
}

const source = (path: string, isDirectory = false) =>
	({ path, name: path.split('/').pop() ?? path, isDirectory }) satisfies Pick<RemoteFileEntry, 'path' | 'name' | 'isDirectory'>;

const neverAsked = async (): Promise<ConflictDecision> => {
	throw new Error('conflict prompt should not have been shown');
};

suite('moveRemoteItems', () => {
	test('moves several items into the target and reports each move', async () => {
		const { client, paths } = fakeClient(['/site/a.txt', '/site/b.txt', '/site/archive']);
		const moved: string[] = [];

		const result = await moveRemoteItems(
			client,
			[source('/site/a.txt'), source('/site/b.txt')],
			'/site/archive',
			async (from, to) => {
				moved.push(`${from} -> ${to}`);
			},
			neverAsked
		);

		assert.strictEqual(result.moved, 2);
		assert.deepStrictEqual(moved, ['/site/a.txt -> /site/archive/a.txt', '/site/b.txt -> /site/archive/b.txt']);
		assert.ok(paths.has('/site/archive/a.txt') && paths.has('/site/archive/b.txt'));
		assert.deepStrictEqual([...result.affectedDirectories].sort(), ['/site', '/site/archive']);
	});

	test('skips an item that is already in the target folder', async () => {
		const { client, calls } = fakeClient(['/site/a.txt']);
		const result = await moveRemoteItems(client, [source('/site/a.txt')], '/site', async () => {}, neverAsked);
		assert.strictEqual(result.moved, 0);
		assert.strictEqual(result.skipped, 1);
		assert.deepStrictEqual(calls, []);
	});

	test('refuses to move a folder into itself or its own subfolder', async () => {
		const { client, calls } = fakeClient(['/site/app', '/site/app/sub']);
		const result = await moveRemoteItems(client, [source('/site/app', true)], '/site/app/sub', async () => {}, neverAsked);
		assert.strictEqual(result.moved, 0);
		assert.deepStrictEqual(calls, []);
	});

	test('a conflict answered with skip leaves both items untouched', async () => {
		const { client, calls } = fakeClient(['/site/a.txt', '/archive/a.txt']);
		const result = await moveRemoteItems(client, [source('/site/a.txt')], '/archive', async () => {}, async () => 'skip');
		assert.strictEqual(result.skipped, 1);
		assert.deepStrictEqual(calls, []);
	});

	test('a conflict answered with replace deletes the destination first', async () => {
		const { client, calls } = fakeClient(['/site/a.txt', '/archive/a.txt']);
		const result = await moveRemoteItems(client, [source('/site/a.txt')], '/archive', async () => {}, async () => 'replace');
		assert.strictEqual(result.moved, 1);
		assert.deepStrictEqual(calls, ['delete /archive/a.txt', 'rename /site/a.txt -> /archive/a.txt']);
	});

	test('cancelling a conflict stops the remaining items', async () => {
		const { client, calls } = fakeClient(['/site/a.txt', '/site/b.txt', '/archive/a.txt']);
		const result = await moveRemoteItems(
			client,
			[source('/site/a.txt'), source('/site/b.txt')],
			'/archive',
			async () => {},
			async () => 'cancel'
		);
		assert.strictEqual(result.moved, 0);
		assert.deepStrictEqual(calls, [], 'b.txt must not be moved after the user cancelled');
	});
});
