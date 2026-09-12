import * as assert from 'assert';
import { resolveSelection } from '../commands/shared';
import { fileContextValue, withoutNestedSelections } from '../tree/RemoteTreeProvider';
import type { ServerProfile } from '../config/serverConfig';
import type { RemoteFileEntry } from '../remote/RemoteClient';

function entry(path: string, isDirectory = false): RemoteFileEntry {
	return { name: path.split('/').pop() ?? path, path, isDirectory, size: 0, modifiedAt: 0 };
}

suite('resolveSelection', () => {
	test('right-clicking inside a multi-selection acts on the whole selection', () => {
		const a = { id: 'a' };
		const b = { id: 'b' };
		assert.deepStrictEqual(resolveSelection(a, [a, b], []), [a, b]);
	});

	test('right-clicking outside the selection acts only on the clicked item', () => {
		const a = { id: 'a' };
		const b = { id: 'b' };
		const c = { id: 'c' };
		assert.deepStrictEqual(resolveSelection(c, [a, b], []), [c]);
	});

	test('a single click with no selection array acts on the clicked item', () => {
		const a = { id: 'a' };
		assert.deepStrictEqual(resolveSelection(a, undefined, []), [a]);
	});

	test('a keyboard shortcut (no arguments) falls back to the tree selection', () => {
		const a = { id: 'a' };
		const b = { id: 'b' };
		assert.deepStrictEqual(resolveSelection(undefined, undefined, [a, b]), [a, b]);
	});
});

suite('withoutNestedSelections', () => {
	test('drops items that live inside another selected folder', () => {
		const nodes = [
			{ entry: entry('/site/assets', true) },
			{ entry: entry('/site/assets/logo.png') },
			{ entry: entry('/site/index.php') },
		];
		assert.deepStrictEqual(
			withoutNestedSelections(nodes).map(node => node.entry.path),
			['/site/assets', '/site/index.php']
		);
	});

	test('does not treat a sibling with a shared prefix as nested', () => {
		const nodes = [{ entry: entry('/site/app', true) }, { entry: entry('/site/app-backup', true) }];
		assert.strictEqual(withoutNestedSelections(nodes).length, 2);
	});
});

suite('fileContextValue', () => {
	const base: ServerProfile = { id: 's', name: 's', protocol: 'sftp', host: 'h', remoteRoot: '/' };

	test('marks rows of a server without a local folder as unmapped', () => {
		assert.strictEqual(fileContextValue(entry('/a.txt'), base), 'remoteHostExplorer.file.unmapped');
		assert.strictEqual(fileContextValue(entry('/dir', true), base), 'remoteHostExplorer.directory.unmapped');
	});

	test('marks rows of a server with a local folder as mapped', () => {
		const mapped = { ...base, localPath: '/projects/site' };
		assert.strictEqual(fileContextValue(entry('/a.txt'), mapped), 'remoteHostExplorer.file.mapped');
		assert.strictEqual(fileContextValue(entry('/dir', true), mapped), 'remoteHostExplorer.directory.mapped');
	});

	test('matches the enablement and menu patterns declared in package.json', () => {
		const manifest = require('../../package.json');
		const download = manifest.contributes.commands.find(
			(command: { command: string }) => command.command === 'remoteHostExplorer.downloadRemoteItem'
		);
		const enablement = new RegExp(download.enablement.match(/=~ \/(.*)\/$/)[1]);
		const mapped = { ...base, localPath: '/projects/site' };

		assert.ok(enablement.test(fileContextValue(entry('/a.txt'), mapped)));
		assert.ok(!enablement.test(fileContextValue(entry('/a.txt'), base)));
	});
});
