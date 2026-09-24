import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
	CONTEXT_MAPPED_FOLDERS,
	CONTEXT_MAPPED_FOLDERS_INCOMPLETE,
	collectMappedFolders,
} from '../config/mappedFolderIndex';
import {
	folderMappings,
	localPathForRemote,
	mappingRootForLocalPath,
	resolveServerForLocalPathIn,
	type ServerProfile,
} from '../config/serverConfig';
import type { RemoteClient, RemoteFileEntry } from '../remote/RemoteClient';
import { downloadPath, type TransferRun } from '../remote/transfer';

/** Absolute path in the platform's own syntax, so the tests read the same on Windows and POSIX. */
function local(...segments: string[]): string {
	return path.resolve(path.sep, ...segments);
}

// One WordPress server, with the theme and a plugin mapped to two separate local projects.
const wordpress: ServerProfile = {
	id: 'wp',
	name: 'wp',
	protocol: 'sftp',
	host: 'example.com',
	remoteRoot: '/var/www/site',
	mappings: [
		{ localPath: local('projects', 'theme'), remotePath: '/var/www/site/wp-content/themes/theme' },
		{ localPath: local('projects', 'plugin'), remotePath: '/var/www/site/wp-content/plugins/plugin' },
	],
};

suite('multiple folder mappings', () => {
	test('each local folder resolves against its own server folder', () => {
		assert.strictEqual(
			resolveServerForLocalPathIn([wordpress], local('projects', 'theme', 'style.css'))?.remotePath,
			'/var/www/site/wp-content/themes/theme/style.css'
		);
		const plugin = resolveServerForLocalPathIn([wordpress], local('projects', 'plugin', 'src', 'main.php'));
		assert.strictEqual(plugin?.remotePath, '/var/www/site/wp-content/plugins/plugin/src/main.php');
		assert.strictEqual(plugin?.relativePath, 'src/main.php');
		assert.strictEqual(resolveServerForLocalPathIn([wordpress], local('projects', 'other', 'a.txt')), undefined);
	});

	test('each server folder resolves to its own local folder', () => {
		assert.strictEqual(
			localPathForRemote(wordpress, '/var/www/site/wp-content/plugins/plugin/readme.txt'),
			local('projects', 'plugin', 'readme.txt')
		);
		assert.strictEqual(localPathForRemote(wordpress, '/var/www/site/wp-content/themes/theme'), local('projects', 'theme'));
		assert.strictEqual(localPathForRemote(wordpress, '/var/www/site/wp-config.php'), undefined);
	});

	test('the deepest mapping wins when mappings are nested', () => {
		const nested: ServerProfile = {
			...wordpress,
			mappings: [
				{ localPath: local('projects', 'site') },
				{ localPath: local('projects', 'site', 'vendor-theme'), remotePath: '/shared/theme' },
			],
		};
		assert.strictEqual(
			resolveServerForLocalPathIn([nested], local('projects', 'site', 'vendor-theme', 'a.css'))?.remotePath,
			'/shared/theme/a.css'
		);
		assert.strictEqual(resolveServerForLocalPathIn([nested], local('projects', 'site', 'index.php'))?.remotePath, '/var/www/site/index.php');
		assert.strictEqual(localPathForRemote(nested, '/shared/theme/a.css'), local('projects', 'site', 'vendor-theme', 'a.css'));
		assert.strictEqual(
			mappingRootForLocalPath(nested, local('projects', 'site', 'vendor-theme', 'x')),
			local('projects', 'site', 'vendor-theme')
		);
		assert.strictEqual(mappingRootForLocalPath(nested, local('elsewhere')), undefined);
	});

	test('a profile saved by an earlier version keeps its single mapping alongside new ones', () => {
		const mixed: ServerProfile = {
			...wordpress,
			localPath: local('projects', 'legacy'),
			remoteMappedPath: '/var/www/legacy',
			mappings: [{ localPath: local('projects', 'theme') }],
		};
		assert.deepStrictEqual(folderMappings(mixed), [
			{ localPath: local('projects', 'legacy'), remotePath: '/var/www/legacy' },
			{ localPath: local('projects', 'theme'), remotePath: '/var/www/site' },
		]);
	});

	test('mappings without a local folder are ignored', () => {
		const blank = { ...wordpress, mappings: [{ localPath: '  ', remotePath: '/x' }] } as ServerProfile;
		assert.deepStrictEqual(folderMappings(blank), []);
	});
});

suite('mapped folder index', () => {
	let root: string;

	setup(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'rhv-index-'));
		for (const dir of ['src/lib', 'node_modules/pkg/dist', '.git/objects']) {
			fs.mkdirSync(path.join(root, dir), { recursive: true });
		}
		fs.writeFileSync(path.join(root, 'src', 'index.ts'), '');
	});
	teardown(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	const profile = (): ServerProfile => ({ ...wordpress, mappings: [{ localPath: root }] });
	const key = (...segments: string[]) => vscode.Uri.file(path.join(root, ...segments)).fsPath;

	test('lists every folder, and ignored folders without their contents', async () => {
		const { folders, complete } = await collectMappedFolders([profile()]);
		assert.ok(complete);
		assert.deepStrictEqual(new Set(folders), new Set([key(), key('src'), key('src', 'lib'), key('node_modules'), key('.git')]));
	});

	test('reports an incomplete index when the limit is reached', async () => {
		const { folders, complete } = await collectMappedFolders([profile()], 2);
		assert.strictEqual(complete, false);
		assert.strictEqual(folders.length, 2);
	});

	test('a mapped folder that does not exist yet is not an error', async () => {
		const missing = { ...wordpress, mappings: [{ localPath: path.join(root, 'missing') }] };
		const { complete } = await collectMappedFolders([missing]);
		assert.ok(complete);
	});

	test('the Explorer upload action is enabled by the keys the index sets', () => {
		const manifest = require('../../package.json');
		const upload = manifest.contributes.commands.find(
			(command: { command: string }) => command.command === 'remoteHostExplorer.uploadFile'
		);
		assert.ok(upload.enablement.includes(`resourcePath in ${CONTEXT_MAPPED_FOLDERS}`));
		assert.ok(upload.enablement.includes(`resourceDirname in ${CONTEXT_MAPPED_FOLDERS}`));
		assert.ok(upload.enablement.includes(CONTEXT_MAPPED_FOLDERS_INCOMPLETE));
	});
});

suite('download to an unmapped folder', () => {
	let dir: string;

	setup(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhv-download-to-'));
	});
	teardown(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test('ignore patterns apply relative to the downloaded folder', async () => {
		const files: Record<string, string> = { '/site/index.php': 'php', '/site/.env': 'SECRET=1' };
		const client = {
			list: async (remoteDir: string) =>
				Object.keys(files)
					.filter(file => path.posix.dirname(file) === remoteDir)
					.map((file): RemoteFileEntry => ({ name: path.posix.basename(file), path: file, isDirectory: false, size: 0, modifiedAt: 0 })),
			get: async (remotePath: string, localPath: string) => fs.promises.writeFile(localPath, files[remotePath]),
		} as unknown as RemoteClient;
		const run: TransferRun = {
			progress: { report: () => undefined },
			token: { isCancellationRequested: false } as vscode.CancellationToken,
			summary: { transferred: 0, skipped: 0, keptLocal: 0 },
			localConflicts: 'ask',
			confirmLocalOverwrite: async () => assert.fail('nothing exists locally, so nothing should prompt'),
		};

		// The server maps a different folder; the download lands outside it.
		await downloadPath(wordpress, client, '/site', path.join(dir, 'site'), true, run);

		assert.ok(fs.existsSync(path.join(dir, 'site', 'index.php')));
		assert.ok(!fs.existsSync(path.join(dir, 'site', '.env')));
		assert.strictEqual(run.summary.skipped, 1);
	});
});
