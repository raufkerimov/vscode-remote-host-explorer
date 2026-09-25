import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { defaultDirection } from '../commands/syncCommands';
import { confirmProductionChange, ProductionDecorationProvider, serverRowUri } from '../config/productionGuard';
import type { ServerProfile } from '../config/serverConfig';
import type { ConnectionManager } from '../remote/ConnectionManager';
import type { RemoteClient, RemoteFileEntry } from '../remote/RemoteClient';
import { changedOnServerSince, KnownFileStates, MAX_KNOWN_FILES } from '../remote/remoteState';
import { classifySyncItem, compareFolders } from '../remote/sync';
import { uploadPath, type LocalOverwriteDecision, type TransferRun } from '../remote/transfer';
import { formatOctal, formatPermissions, parseModeInput } from '../util/permissions';

function server(id: string, overrides: Partial<ServerProfile> = {}): ServerProfile {
	return { id, name: id, protocol: 'sftp', host: `${id}.example.com`, remoteRoot: '/site', ...overrides };
}

const token = { isCancellationRequested: false } as vscode.CancellationToken;

suite('production servers', () => {
	test('other servers are never asked about', async () => {
		assert.strictEqual(await confirmProductionChange(server('dev'), 'Upload.'), true);
	});

	test('production rows carry a decoration, others none', () => {
		const provider = new ProductionDecorationProvider();
		const decoration = provider.provideFileDecoration(serverRowUri(server('prod', { production: true })));
		assert.strictEqual(decoration?.badge, 'P');
		assert.strictEqual(provider.provideFileDecoration(serverRowUri(server('dev'))), undefined);
	});

	test('toggling production changes the row URI, so VS Code asks for the decoration again', () => {
		assert.notStrictEqual(
			serverRowUri(server('a')).toString(),
			serverRowUri(server('a', { production: true })).toString()
		);
	});
});

suite('KnownFileStates', () => {
	test('remembers and replaces a file state per server', () => {
		const states = new KnownFileStates();
		states.set('dev', '/site/a.txt', { remoteModifiedAt: 1, localModifiedAt: 2, size: 3 });
		states.set('dev', '/site//a.txt', { remoteModifiedAt: 4, localModifiedAt: 5, size: 6 });
		assert.deepStrictEqual(states.get('dev', '/site/a.txt'), { remoteModifiedAt: 4, localModifiedAt: 5, size: 6 });
		assert.strictEqual(states.get('prod', '/site/a.txt'), undefined);
	});

	test('drops the oldest records beyond the limit', () => {
		const states = new KnownFileStates();
		for (let i = 0; i <= MAX_KNOWN_FILES; i++) {
			states.set('dev', `/f${i}`, { remoteModifiedAt: i, localModifiedAt: i, size: i });
		}
		assert.strictEqual(states.get('dev', '/f0'), undefined);
		assert.ok(states.get('dev', `/f${MAX_KNOWN_FILES}`));
	});

	test('a server change counts only beyond the protocol tolerance, or when the size differs', () => {
		const known = { remoteModifiedAt: 100_000, localModifiedAt: 0, size: 10 };
		assert.ok(!changedOnServerSince(known, { modifiedAt: 100_500, size: 10 }, 'sftp'));
		assert.ok(changedOnServerSince(known, { modifiedAt: 102_000, size: 10 }, 'sftp'));
		assert.ok(!changedOnServerSince(known, { modifiedAt: 130_000, size: 10 }, 'ftp'), 'FTP listings have minute precision');
		assert.ok(changedOnServerSince(known, { modifiedAt: 100_000, size: 11 }, 'sftp'));
		assert.ok(!changedOnServerSince(undefined, { modifiedAt: 999_999, size: 1 }, 'sftp'), 'never transferred: unknown');
	});
});

/** A fake server keeping files in memory, with timestamps that advance on every write. */
function memoryServer(initial: Record<string, { contents: string; modifiedAt: number }>) {
	const files = new Map(Object.entries(initial));
	let clock = 1_000_000;
	const entry = (filePath: string): RemoteFileEntry | undefined => {
		const file = files.get(filePath);
		return file && { name: path.posix.basename(filePath), path: filePath, isDirectory: false, size: file.contents.length, modifiedAt: file.modifiedAt };
	};
	const client = {
		stat: async (filePath: string) => entry(filePath),
		list: async (dir: string) => [...files.keys()].filter(file => path.posix.dirname(file) === dir).map(file => entry(file)!),
		mkdir: async () => undefined,
		put: async (localPath: string, remotePath: string) => {
			clock += 10_000;
			files.set(remotePath, { contents: fs.readFileSync(localPath, 'utf8'), modifiedAt: clock });
		},
	} as unknown as RemoteClient;
	const connections = { getClient: async () => client } as unknown as ConnectionManager;
	return { files, client, connections, edit: (filePath: string, contents: string) => files.set(filePath, { contents, modifiedAt: (clock += 10_000) }) };
}

function uploadRun(answers: LocalOverwriteDecision[], knownFiles: KnownFileStates): { run: TransferRun; asked: string[] } {
	const asked: string[] = [];
	const run: TransferRun = {
		progress: { report: () => undefined },
		token,
		summary: { transferred: 0, skipped: 0, keptLocal: 0, keptRemote: 0 },
		localConflicts: 'ask',
		confirmLocalOverwrite: async () => assert.fail('uploads never ask about local files'),
		knownFiles,
		remoteConflicts: 'ask',
		confirmRemoteOverwrite: async label => {
			asked.push(label);
			const answer = answers.shift();
			assert.ok(answer, `unexpected prompt for ${label}`);
			return answer;
		},
	};
	return { run, asked };
}

suite('uploads over files changed on the server', () => {
	let dir: string;
	const output = { appendLine: () => undefined } as unknown as vscode.OutputChannel;
	const dev = server('dev');

	setup(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhv-safety-'));
		fs.writeFileSync(path.join(dir, 'a.txt'), 'mine');
	});
	teardown(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test('re-uploading an unchanged server file does not ask', async () => {
		const remote = memoryServer({});
		const known = new KnownFileStates();
		await uploadPath(dev, remote.connections, output, path.join(dir, 'a.txt'), '/site/a.txt', uploadRun([], known).run);
		const { run, asked } = uploadRun([], known);
		await uploadPath(dev, remote.connections, output, path.join(dir, 'a.txt'), '/site/a.txt', run);
		assert.deepStrictEqual(asked, []);
		assert.strictEqual(run.summary.transferred, 1);
	});

	test('a server edit since the last upload asks, and Skip keeps the server copy', async () => {
		const remote = memoryServer({});
		const known = new KnownFileStates();
		await uploadPath(dev, remote.connections, output, path.join(dir, 'a.txt'), '/site/a.txt', uploadRun([], known).run);
		remote.edit('/site/a.txt', 'hotfix on the server');

		const { run, asked } = uploadRun(['skip'], known);
		await uploadPath(dev, remote.connections, output, path.join(dir, 'a.txt'), '/site/a.txt', run);
		assert.deepStrictEqual(asked, ['a.txt']);
		assert.strictEqual(remote.files.get('/site/a.txt')?.contents, 'hotfix on the server');
		assert.strictEqual(run.summary.keptRemote, 1);
	});

	test('a folder upload asks once per changed file and honours Overwrite All', async () => {
		fs.mkdirSync(path.join(dir, 'site'));
		for (const name of ['x.txt', 'y.txt', 'z.txt']) {
			fs.writeFileSync(path.join(dir, 'site', name), name);
		}
		const remote = memoryServer({});
		const known = new KnownFileStates();
		await uploadPath(dev, remote.connections, output, path.join(dir, 'site'), '/site', uploadRun([], known).run);
		remote.edit('/site/x.txt', 'changed');
		remote.edit('/site/z.txt', 'changed');

		const { run, asked } = uploadRun(['overwrite-all'], known);
		await uploadPath(dev, remote.connections, output, path.join(dir, 'site'), '/site', run);
		assert.deepStrictEqual(asked, ['x.txt']);
		assert.strictEqual(remote.files.get('/site/z.txt')?.contents, 'z.txt');
	});

	test('a file this extension never transferred is uploaded without asking', async () => {
		const remote = memoryServer({ '/site/a.txt': { contents: 'theirs', modifiedAt: 5_000_000 } });
		const { run, asked } = uploadRun([], new KnownFileStates());
		await uploadPath(dev, remote.connections, output, path.join(dir, 'a.txt'), '/site/a.txt', run);
		assert.deepStrictEqual(asked, []);
		assert.strictEqual(remote.files.get('/site/a.txt')?.contents, 'mine');
	});
});

suite('sync', () => {
	const local = (size: number, modifiedAt: number) => ({ size, modifiedAt });
	const remote = (size: number, modifiedAt: number): RemoteFileEntry => ({ name: 'f', path: '/f', isDirectory: false, size, modifiedAt });
	const known = { remoteModifiedAt: 50_000, localModifiedAt: 40_000, size: 5 };

	test('classifies each kind of difference', () => {
		assert.strictEqual(classifySyncItem(local(5, 1), undefined, undefined, 'sftp'), 'localOnly');
		assert.strictEqual(classifySyncItem(undefined, remote(5, 1), undefined, 'sftp'), 'remoteOnly');
		assert.strictEqual(classifySyncItem(local(5, 40_000), remote(5, 50_000), known, 'sftp'), undefined);
		assert.strictEqual(classifySyncItem(local(6, 90_000), remote(5, 50_000), known, 'sftp'), 'localChanged');
		assert.strictEqual(classifySyncItem(local(5, 40_000), remote(7, 90_000), known, 'sftp'), 'remoteChanged');
		assert.strictEqual(classifySyncItem(local(6, 90_000), remote(7, 90_000), known, 'sftp'), 'bothChanged');
		assert.strictEqual(classifySyncItem(local(5, 1), remote(5, 2), undefined, 'sftp'), undefined, 'same size, never synced');
		assert.strictEqual(classifySyncItem(local(5, 1), remote(6, 2), undefined, 'sftp'), 'differs');
	});

	test('only one-sided changes get a default direction', () => {
		assert.strictEqual(defaultDirection('localOnly'), 'upload');
		assert.strictEqual(defaultDirection('remoteChanged'), 'download');
		assert.strictEqual(defaultDirection('bothChanged'), undefined);
		assert.strictEqual(defaultDirection('differs'), undefined);
	});

	test('compares folders recursively, skipping ignored files on both sides', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhv-sync-'));
		try {
			fs.mkdirSync(path.join(dir, 'css'));
			fs.mkdirSync(path.join(dir, 'node_modules'));
			fs.writeFileSync(path.join(dir, 'index.php'), 'same');
			fs.writeFileSync(path.join(dir, 'css', 'new.css'), 'local only');
			fs.writeFileSync(path.join(dir, 'node_modules', 'x.js'), 'ignored');
			fs.writeFileSync(path.join(dir, '.env'), 'ignored');
			const tree: Record<string, RemoteFileEntry[]> = {
				'/site': [
					{ name: 'index.php', path: '/site/index.php', isDirectory: false, size: 4, modifiedAt: 1 },
					{ name: 'img', path: '/site/img', isDirectory: true, size: 0, modifiedAt: 0 },
					{ name: '.env', path: '/site/.env', isDirectory: false, size: 99, modifiedAt: 1 },
				],
				'/site/img': [{ name: 'logo.png', path: '/site/img/logo.png', isDirectory: false, size: 10, modifiedAt: 1 }],
			};
			const client = { list: async (dirPath: string) => tree[dirPath] ?? [] } as unknown as RemoteClient;
			const items = await compareFolders({
				server: server('dev', { mappings: [{ localPath: dir }] }),
				client,
				localRoot: dir,
				remoteRoot: '/site',
				knownFiles: new KnownFileStates(),
				token,
			});
			assert.deepStrictEqual(
				items.map(item => [item.relativePath, item.status, item.remotePath]),
				[
					['css/new.css', 'localOnly', '/site/css/new.css'],
					['img/logo.png', 'remoteOnly', '/site/img/logo.png'],
				]
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

suite('permissions', () => {
	test('reads octal and letters, rejects anything else', () => {
		assert.strictEqual(parseModeInput('644'), 0o644);
		assert.strictEqual(parseModeInput(' 0755 '), 0o755);
		assert.strictEqual(parseModeInput('2775'), 0o2775);
		assert.strictEqual(parseModeInput('rw-r--r--'), 0o644);
		assert.strictEqual(parseModeInput('rwxr-x--x'), 0o751);
		for (const bad of ['', '64', '888', '12345', 'rw-r--r', 'rwxrwxrwz']) {
			assert.strictEqual(parseModeInput(bad), undefined, bad);
		}
	});

	test('formats modes both ways', () => {
		assert.strictEqual(formatPermissions(0o755), 'rwxr-xr-x');
		assert.strictEqual(formatPermissions(0o600), 'rw-------');
		assert.strictEqual(formatOctal(0o644), '644');
		assert.strictEqual(formatOctal(0o2775), '2775');
	});
});

suite('new tree menus', () => {
	const manifest = require('../../package.json');
	const whenOf = (command: string) =>
		manifest.contributes.menus['view/item/context'].find((item: { command: string }) => item.command === `remoteHostExplorer.${command}`)
			.when as string;
	const regexIn = (when: string) => new RegExp(when.match(/viewItem =~ \/(.*?)\/(?:\s|\)|$)/)![1]);

	test('match the rows they are meant for', () => {
		assert.ok(regexIn(whenOf('syncRemoteFolder')).test('remoteHostExplorer.directory.sftp.mapped'));
		assert.ok(!regexIn(whenOf('syncRemoteFolder')).test('remoteHostExplorer.file.sftp.mapped'));
		assert.ok(regexIn(whenOf('syncServer')).test('remoteHostExplorer.server.disconnected.ftp'));
		assert.ok(regexIn(whenOf('changePermissions')).test('remoteHostExplorer.file.ftps.unmapped'));
	});

	test('every contributed command is registered on activation', async () => {
		await vscode.extensions.getExtension('raufkerimov.remote-host-explorer')!.activate();
		const registered = new Set(await vscode.commands.getCommands(true));
		const missing = manifest.contributes.commands
			.map((command: { command: string }) => command.command)
			.filter((command: string) => !registered.has(command));
		assert.deepStrictEqual(missing, []);
	});
});
