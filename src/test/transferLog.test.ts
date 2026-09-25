import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type * as vscode from 'vscode';
import { resolveServersForLocalPathIn, type ServerProfile } from '../config/serverConfig';
import type { ConnectionManager } from '../remote/ConnectionManager';
import type { RemoteClient, RemoteFileEntry } from '../remote/RemoteClient';
import { downloadPath, type TransferRun } from '../remote/transfer';
import { MAX_TRANSFER_RECORDS, TransferLog, type TransferEntry } from '../remote/transferLog';
import type { RemoteFileCache } from '../editing/RemoteFileCache';
import { RemoteTreeProvider, type TreeNode } from '../tree/RemoteTreeProvider';
import { describeRecord } from '../tree/TransferLogProvider';

function local(...segments: string[]): string {
	return path.resolve(path.sep, ...segments);
}

function server(id: string, overrides: Partial<ServerProfile> = {}): ServerProfile {
	return { id, name: id, protocol: 'sftp', host: `${id}.example.com`, remoteRoot: '/var/www', ...overrides };
}

suite('servers sharing a local folder', () => {
	const dev = server('dev', { mappings: [{ localPath: local('site') }] });
	const prod = server('prod', { remoteRoot: '/srv/site', mappings: [{ localPath: local('site') }] });

	test('every server mapping the file is offered, in profile order', () => {
		const resolutions = resolveServersForLocalPathIn([dev, prod], local('site', 'index.php'));
		assert.deepStrictEqual(
			resolutions.map(resolution => [resolution.server.id, resolution.remotePath]),
			[['dev', '/var/www/index.php'], ['prod', '/srv/site/index.php']]
		);
	});

	test('each server resolves through its own deepest mapping', () => {
		const nested = server('nested', {
			mappings: [{ localPath: local('site') }, { localPath: local('site', 'theme'), remotePath: '/themes/t' }],
		});
		const [resolution] = resolveServersForLocalPathIn([nested], local('site', 'theme', 'a.css'));
		assert.strictEqual(resolution.remotePath, '/themes/t/a.css');
		assert.strictEqual(resolution.relativePath, 'a.css');
	});

	test('servers that do not map the file are left out', () => {
		assert.deepStrictEqual(resolveServersForLocalPathIn([dev, prod], local('elsewhere', 'a.txt')), []);
	});
});

suite('TransferLog', () => {
	test('records transfers newest first with their files', () => {
		const log = new TransferLog();
		const first = log.start('Uploading 1 item(s) to dev');
		log.add(first, { from: '/a', to: 'dev:/a', status: 'done' });
		log.finish(first, 'done');
		const second = log.start('Downloading 1 item(s)');
		assert.deepStrictEqual(log.records.map(record => record.id), [second.id, first.id]);
		assert.strictEqual(first.entries.length, 1);
		assert.strictEqual(second.state, 'running');
	});

	test('clearing keeps transfers that are still running', () => {
		const log = new TransferLog();
		log.finish(log.start('finished'), 'done');
		const running = log.start('running');
		log.clear();
		assert.deepStrictEqual(log.records, [running]);
	});

	test('keeps only the most recent transfers', () => {
		const log = new TransferLog();
		for (let i = 0; i < MAX_TRANSFER_RECORDS + 5; i++) {
			log.start(`transfer ${i}`);
		}
		assert.strictEqual(log.records.length, MAX_TRANSFER_RECORDS);
		assert.strictEqual(log.records[0].title, `transfer ${MAX_TRANSFER_RECORDS + 4}`);
	});

	test('describes the outcome by file status', () => {
		const log = new TransferLog();
		const record = log.start('Uploading');
		for (const status of ['done', 'done', 'ignored', 'failed'] as const) {
			log.add(record, { from: 'a', to: 'b', status });
		}
		log.finish(record, 'failed', 'boom');
		assert.match(describeRecord(record), / · failed · 2 transferred, 1 ignored, 1 failed$/);
	});
});

suite('transfers report every file', () => {
	let dir: string;

	setup(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhv-log-'));
	});
	teardown(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test('a folder download logs sent, ignored, and kept files with where they went', async () => {
		const files: Record<string, string> = { '/site/a.txt': 'A', '/site/b.txt': 'B', '/site/.env': 'SECRET' };
		fs.writeFileSync(path.join(dir, 'b.txt'), 'local');
		const client = {
			list: async (remoteDir: string) =>
				Object.keys(files)
					.filter(file => path.posix.dirname(file) === remoteDir)
					.map((file): RemoteFileEntry => ({ name: path.posix.basename(file), path: file, isDirectory: false, size: 0, modifiedAt: 0 })),
			get: async (remotePath: string, localPath: string) => fs.promises.writeFile(localPath, files[remotePath]),
		} as unknown as RemoteClient;
		const entries: TransferEntry[] = [];
		const run: TransferRun = {
			progress: { report: () => undefined },
			token: { isCancellationRequested: false } as vscode.CancellationToken,
			summary: { transferred: 0, skipped: 0, keptLocal: 0 },
			localConflicts: 'ask',
			confirmLocalOverwrite: async () => 'skip',
			log: entry => entries.push(entry),
		};

		await downloadPath(server('dev'), client, '/site', dir, true, run);

		const byName = (name: string) => entries.find(entry => entry.to === path.join(dir, name));
		assert.deepStrictEqual(byName('a.txt'), { from: 'dev:/site/a.txt', to: path.join(dir, 'a.txt'), status: 'done', localPath: path.join(dir, 'a.txt'), error: undefined });
		assert.strictEqual(byName('b.txt')?.status, 'kept');
		assert.strictEqual(byName('.env')?.status, 'ignored');
	});
});

suite('server rows after a connection change', () => {
	test('redraw the changed server and every idle server together', () => {
		const connected = new Set(['dev']);
		const connections = {
			isConnected: (id: string) => connected.has(id),
			hasSession: (id: string) => connected.has(id),
		} as unknown as ConnectionManager;
		const outputChannel = { appendLine: () => undefined } as unknown as vscode.OutputChannel;
		const provider = new RemoteTreeProvider(connections, {} as RemoteFileCache, outputChannel);
		const [dev, prod, staging, live] = ['dev', 'prod', 'staging', 'live'].map(id => provider.serverNode(server(id)));
		connected.add('live');

		const fired: (TreeNode | TreeNode[] | undefined)[] = [];
		provider.onDidChangeTreeData(change => fired.push(change));
		connected.delete('dev');
		provider.refreshConnectionState('dev');

		// `live` is connected, so it keeps its arrow and needs no redraw.
		assert.deepStrictEqual(fired, [[dev, prod, staging]]);
		assert.ok(live);
	});
});
