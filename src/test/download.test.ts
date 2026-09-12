import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type * as vscode from 'vscode';
import { DEFAULT_IGNORE_GLOBS, isIgnored, type ServerProfile } from '../config/serverConfig';
import type { RemoteClient, RemoteFileEntry } from '../remote/RemoteClient';
import { buildRsyncArgs } from '../remote/rsyncUpload';
import {
	CancelledError,
	collectUploadFiles,
	downloadPath,
	type LocalOverwriteDecision,
	type TransferRun,
} from '../remote/transfer';

/** A fake remote directory: `get` writes the remote contents, `list` returns the entries. */
function fakeRemote(files: Record<string, string>): RemoteClient {
	const client: Partial<RemoteClient> = {
		list: async dir =>
			Object.keys(files)
				.filter(file => path.posix.dirname(file) === dir)
				.map((file): RemoteFileEntry => ({
					name: path.posix.basename(file),
					path: file,
					isDirectory: false,
					size: files[file].length,
					modifiedAt: 0,
				})),
		get: async (remotePath, localPath) => {
			await fs.promises.writeFile(localPath, files[remotePath]);
		},
	};
	return client as RemoteClient;
}

function makeRun(answers: LocalOverwriteDecision[]): { run: TransferRun; asked: string[] } {
	const asked: string[] = [];
	const run: TransferRun = {
		progress: { report: () => undefined },
		token: { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) } as unknown as vscode.CancellationToken,
		summary: { transferred: 0, skipped: 0, keptLocal: 0 },
		localConflicts: 'ask',
		confirmLocalOverwrite: async label => {
			asked.push(label);
			const answer = answers.shift();
			assert.ok(answer, `unexpected prompt for "${label}"`);
			return answer;
		},
	};
	return { run, asked };
}

const server: ServerProfile = { id: 's', name: 's', protocol: 'sftp', host: 'h', remoteRoot: '/site' };

suite('download overwrite protection', () => {
	let dir: string;

	setup(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhv-download-'));
	});
	teardown(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	const read = (name: string) => fs.readFileSync(path.join(dir, name), 'utf8');

	test('a file that does not exist locally downloads without asking', async () => {
		const { run, asked } = makeRun([]);
		await downloadPath(server, fakeRemote({ '/site/a.txt': 'remote' }), '/site/a.txt', path.join(dir, 'a.txt'), false, run);
		assert.strictEqual(read('a.txt'), 'remote');
		assert.deepStrictEqual(asked, []);
	});

	test('an existing local file is kept when the user skips', async () => {
		fs.writeFileSync(path.join(dir, 'a.txt'), 'my local edits');
		const { run } = makeRun(['skip']);
		await downloadPath(server, fakeRemote({ '/site/a.txt': 'remote' }), '/site/a.txt', path.join(dir, 'a.txt'), false, run);
		assert.strictEqual(read('a.txt'), 'my local edits');
		assert.strictEqual(run.summary.keptLocal, 1);
		assert.strictEqual(run.summary.transferred, 0);
	});

	test('an existing local file is replaced when the user overwrites', async () => {
		fs.writeFileSync(path.join(dir, 'a.txt'), 'my local edits');
		const { run } = makeRun(['overwrite']);
		await downloadPath(server, fakeRemote({ '/site/a.txt': 'remote' }), '/site/a.txt', path.join(dir, 'a.txt'), false, run);
		assert.strictEqual(read('a.txt'), 'remote');
	});

	test('"Overwrite All" answers every later conflict in the same folder download', async () => {
		for (const name of ['a.txt', 'b.txt', 'c.txt']) {
			fs.writeFileSync(path.join(dir, name), 'local');
		}
		const remote = fakeRemote({ '/site/a.txt': 'R', '/site/b.txt': 'R', '/site/c.txt': 'R' });
		const { run, asked } = makeRun(['overwrite-all']);
		await downloadPath(server, remote, '/site', dir, true, run);
		assert.strictEqual(asked.length, 1, 'only the first conflict should prompt');
		assert.deepStrictEqual(['a.txt', 'b.txt', 'c.txt'].map(read), ['R', 'R', 'R']);
	});

	test('"Skip All" keeps every existing file but still downloads new ones', async () => {
		fs.writeFileSync(path.join(dir, 'a.txt'), 'local-a');
		fs.writeFileSync(path.join(dir, 'b.txt'), 'local-b');
		const remote = fakeRemote({ '/site/a.txt': 'R', '/site/b.txt': 'R', '/site/new.txt': 'N' });
		const { run, asked } = makeRun(['skip-all']);
		await downloadPath(server, remote, '/site', dir, true, run);
		assert.strictEqual(asked.length, 1);
		assert.deepStrictEqual([read('a.txt'), read('b.txt'), read('new.txt')], ['local-a', 'local-b', 'N']);
		assert.strictEqual(run.summary.keptLocal, 2);
	});

	test('cancelling stops the download without touching the file', async () => {
		fs.writeFileSync(path.join(dir, 'a.txt'), 'my local edits');
		const { run } = makeRun(['cancel']);
		await assert.rejects(
			() => downloadPath(server, fakeRemote({ '/site/a.txt': 'remote' }), '/site/a.txt', path.join(dir, 'a.txt'), false, run),
			CancelledError
		);
		assert.strictEqual(read('a.txt'), 'my local edits');
	});
});

suite('rsync folder uploads honour ignore patterns', () => {
	let source: string;
	let destination: string;

	setup(() => {
		source = fs.mkdtempSync(path.join(os.tmpdir(), 'rhv-rsync-src-'));
		destination = fs.mkdtempSync(path.join(os.tmpdir(), 'rhv-rsync-dst-'));
		const files: Record<string, string> = {
			'index.php': 'php',
			'src/app.js': 'js',
			'.env': 'SECRET=1',
			'config/.env.production': 'SECRET=2',
			'.git/config': 'git',
			'node_modules/pkg/index.js': 'dep',
			'certs/server.pem': 'pem',
			'.vscode/settings.json': '{}',
		};
		for (const [file, contents] of Object.entries(files)) {
			fs.mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
			fs.writeFileSync(path.join(source, file), contents);
		}
	});
	teardown(() => {
		fs.rmSync(source, { recursive: true, force: true });
		fs.rmSync(destination, { recursive: true, force: true });
	});

	test('the collected file list excludes everything the defaults ignore', async () => {
		const { files } = await collectUploadFiles({ ...server, localPath: source }, source);
		assert.deepStrictEqual(files.sort(), ['index.php', 'src/app.js']);
	});

	test('real rsync with --files-from transfers only the allowed files', async function () {
		if (spawnSync('rsync', ['--version']).error) {
			this.skip();
		}
		const profile: ServerProfile = { ...server, localPath: source };
		const { files } = await collectUploadFiles(profile, source);
		const listFile = path.join(source, '..', `rhv-list-${path.basename(source)}.txt`);
		fs.writeFileSync(listFile, files.join('\n') + '\n');

		try {
			// Use the exact arguments the extension builds, minus the ssh transport, against a local target.
			const args = buildRsyncArgs(profile, { localPath: source, remotePath: '/unused', isDirectory: true, filesFrom: listFile });
			const eIndex = args.indexOf('-e');
			args.splice(eIndex, 2);
			args[args.length - 1] = destination + '/';

			const result = spawnSync('rsync', args, { encoding: 'utf8' });
			assert.strictEqual(result.status, 0, result.stderr);
		} finally {
			fs.rmSync(listFile, { force: true });
		}

		const transferred: string[] = [];
		const walk = (dir: string) => {
			for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, item.name);
				if (item.isDirectory()) {
					walk(full);
				} else {
					transferred.push(path.relative(destination, full).replace(/\\/g, '/'));
				}
			}
		};
		walk(destination);
		assert.deepStrictEqual(transferred.sort(), ['index.php', 'src/app.js']);
	});
});

suite('default ignore patterns', () => {
	const withDefaults: ServerProfile = { ...server, ignoreGlobs: [...DEFAULT_IGNORE_GLOBS] };

	test('keep secrets, keys, and editor config off the server', () => {
		for (const secret of ['.env', '.env.production', 'config/.env', '.ssh/id_ed25519', 'certs/server.pem', 'certs/server.key', '.vscode/settings.json']) {
			assert.ok(isIgnored(withDefaults, secret), `${secret} should be ignored`);
		}
	});

	test('leave ordinary project files alone', () => {
		for (const file of ['index.php', 'src/env.ts', 'environment.json', 'keys.md', 'public/app.js']) {
			assert.ok(!isIgnored(withDefaults, file), `${file} should not be ignored`);
		}
	});

	test('apply to a profile without an ignoreGlobs field, but not to an explicit empty list', () => {
		assert.ok(isIgnored({ ...server, ignoreGlobs: undefined }, '.env'));
		assert.ok(!isIgnored({ ...server, ignoreGlobs: [] }, '.env'));
	});
});
