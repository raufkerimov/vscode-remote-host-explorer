import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { resolveServersForLocalPathIn, type ServerProfile } from '../config/serverConfig';
import type { ConnectionManager } from '../remote/ConnectionManager';
import type { RemoteClient, RemoteFileEntry } from '../remote/RemoteClient';
import { downloadPath, type TransferRun } from '../remote/transfer';
import { describeProgress, MAX_TRANSFER_RECORDS, TransferLog, type TransferEntry } from '../remote/transferLog';
import { formatBytes, formatDuration } from '../util/format';
import type { RemoteFileCache } from '../editing/RemoteFileCache';
import { RemoteTreeProvider, type TreeNode } from '../tree/RemoteTreeProvider';
import { describeRecord, TransferLogProvider } from '../tree/TransferLogProvider';

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

	test('remembers which transfer finished last, until it is cleared', () => {
		const log = new TransferLog();
		const first = log.start('first');
		const second = log.start('second');
		log.finish(second, 'done');
		log.finish(first, 'cancelled');
		assert.strictEqual(log.lastFinished, first);
		log.clear();
		assert.strictEqual(log.lastFinished, undefined);
	});

	test('the view can find each file\'s transfer and always lets a transfer expand', () => {
		const log = new TransferLog();
		const record = log.start('Uploading');
		const provider = new TransferLogProvider(log);
		assert.strictEqual(provider.getTreeItem(record).collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
		const entry: TransferEntry = { from: 'a', to: 'b', status: 'done' };
		log.add(record, entry);
		assert.strictEqual(provider.getParent(entry), record);
		assert.strictEqual(provider.getParent(record), undefined);
		provider.dispose();
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

	test('a file shown while it moves is updated in place when it ends', () => {
		const log = new TransferLog();
		const record = log.start('Uploading');
		log.expect(record, 1000);
		const entry: TransferEntry = { from: 'a', to: 'b', status: 'running', size: 1000 };
		log.begin(record, entry);
		log.advance(record, entry, 400);
		assert.strictEqual(record.transferredBytes, 400);
		assert.match(describeProgress(record), /^40%/);
		// Progress reports may stop short of the end; a sent file counts in full.
		entry.status = 'done';
		log.add(record, entry);
		assert.deepStrictEqual(record.entries, [entry]);
		assert.strictEqual(record.transferredBytes, 1000);
		assert.strictEqual(entry.transferred, 1000);
	});

	test('a file the protocol sizes is added to the total', () => {
		const log = new TransferLog();
		const record = log.start('Downloading');
		const entry: TransferEntry = { from: 'a', to: 'b', status: 'running' };
		log.begin(record, entry);
		assert.strictEqual(describeProgress(record), '');
		log.advance(record, entry, 512, 2048);
		log.advance(record, entry, 512, 2048);
		assert.strictEqual(record.totalBytes, 2048);
		assert.strictEqual(record.transferredBytes, 512);
		assert.match(describeProgress(record), /^25%/);
	});

	test('progress and speed while running, size once finished', () => {
		const log = new TransferLog();
		const record = log.start('Uploading');
		log.expect(record, 4 * 1024 * 1024);
		const entry: TransferEntry = { from: 'a', to: 'b', status: 'running', size: 4 * 1024 * 1024 };
		log.begin(record, entry);
		log.advance(record, entry, 1024 * 1024);
		record.speed = 512 * 1024;
		assert.match(describeRecord(record), / · 25% · 512 KB\/s · 6s left · 0 transferred$/);
		entry.status = 'done';
		log.add(record, entry);
		log.finish(record, 'done');
		assert.strictEqual(record.speed, undefined);
		assert.match(describeRecord(record), / · 1 transferred · 4\.0 MB$/);
	});
});

suite('formatting sizes and durations', () => {
	test('bytes', () => {
		assert.strictEqual(formatBytes(0), '0 B');
		assert.strictEqual(formatBytes(1023), '1023 B');
		assert.strictEqual(formatBytes(1536), '1.5 KB');
		assert.strictEqual(formatBytes(50 * 1024 * 1024), '50 MB');
		assert.strictEqual(formatBytes(3 * 1024 ** 3), '3.0 GB');
	});

	test('durations', () => {
		assert.strictEqual(formatDuration(4.4), '4s');
		assert.strictEqual(formatDuration(185), '3m 05s');
		assert.strictEqual(formatDuration(4800), '1h 20m');
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
		assert.deepStrictEqual(byName('a.txt'), { from: 'dev:/site/a.txt', to: path.join(dir, 'a.txt'), status: 'done', localPath: path.join(dir, 'a.txt'), size: 0 });
		assert.strictEqual(byName('b.txt')?.status, 'kept');
		assert.strictEqual(byName('.env')?.status, 'ignored');
	});

	test('a download shows the file while it moves and reports its bytes', async () => {
		const client = {
			get: async (_remotePath: string, localPath: string, onProgress?: (transferred: number, total?: number) => void) => {
				onProgress?.(3, 6);
				onProgress?.(6, 6);
				await fs.promises.writeFile(localPath, 'ABCDEF');
			},
		} as unknown as RemoteClient;
		const log = new TransferLog();
		const record = log.start('Downloading');
		const run: TransferRun = {
			progress: { report: () => undefined },
			token: { isCancellationRequested: false } as vscode.CancellationToken,
			summary: { transferred: 0, skipped: 0, keptLocal: 0 },
			localConflicts: 'ask',
			confirmLocalOverwrite: async () => 'skip',
			log: entry => log.add(record, entry),
			begin: entry => log.begin(record, entry),
			advance: (entry, transferred, total) => log.advance(record, entry, transferred, total),
			expect: bytes => log.expect(record, bytes),
		};

		await downloadPath(server('dev'), client, '/site/a.txt', path.join(dir, 'a.txt'), false, run);

		assert.strictEqual(record.entries.length, 1);
		assert.strictEqual(record.entries[0].status, 'done');
		assert.strictEqual(record.totalBytes, 6);
		assert.strictEqual(record.transferredBytes, 6);
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
