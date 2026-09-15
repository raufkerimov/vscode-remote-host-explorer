import * as assert from 'assert';
import { resolveSelection } from '../commands/shared';
import { fileContextValue, serverContextValue, withoutNestedSelections } from '../tree/RemoteTreeProvider';
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
		assert.strictEqual(fileContextValue(entry('/a.txt'), base), 'remoteHostExplorer.file.sftp.unmapped');
		assert.strictEqual(fileContextValue(entry('/dir', true), base), 'remoteHostExplorer.directory.sftp.unmapped');
	});

	test('marks rows of a server with a local folder as mapped', () => {
		const mapped = { ...base, localPath: '/projects/site' };
		assert.strictEqual(fileContextValue(entry('/a.txt'), mapped), 'remoteHostExplorer.file.sftp.mapped');
		assert.strictEqual(fileContextValue(entry('/dir', true), mapped), 'remoteHostExplorer.directory.sftp.mapped');
	});

	test('only rows inside the remote mapped folder count as mapped', () => {
		const theme = { ...base, remoteRoot: '/site', localPath: '/projects/theme', remoteMappedPath: '/site/wp-content/themes/t' };
		assert.strictEqual(fileContextValue(entry('/site/wp-config.php'), theme), 'remoteHostExplorer.file.sftp.unmapped');
		assert.strictEqual(fileContextValue(entry('/site/wp-content', true), theme), 'remoteHostExplorer.directory.sftp.unmapped');
		assert.strictEqual(fileContextValue(entry('/site/wp-content/themes/t/style.css'), theme), 'remoteHostExplorer.file.sftp.mapped');
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

	test('SSH-only and connection menus match the right rows', () => {
		const manifest = require('../../package.json');
		const whenOf = (command: string, index = 0) =>
			manifest.contributes.menus['view/item/context']
				.filter((item: { command: string }) => item.command === `remoteHostExplorer.${command}`)
				[index].when as string;
		const regexIn = (when: string) => when.match(/viewItem =~ \/(.*?)\/(?:\s|\)|$)/g)!.map(part => new RegExp(part.replace(/^viewItem =~ \//, '').replace(/\/[\s)]*$/, '')));
		const matchesAny = (when: string, value: string) => regexIn(when).some(regex => regex.test(value));
		const ftp = { ...base, protocol: 'ftp' as const };

		const serverTerminal = whenOf('openSshTerminal', 0);
		assert.ok(matchesAny(serverTerminal, serverContextValue(base, false)));
		assert.ok(matchesAny(serverTerminal, serverContextValue(base, true)));
		assert.ok(!matchesAny(serverTerminal, serverContextValue(ftp, true)));

		const folderTerminal = whenOf('openSshTerminal', 1);
		assert.ok(matchesAny(folderTerminal, fileContextValue(entry('/dir', true), base)));
		assert.ok(!matchesAny(folderTerminal, fileContextValue(entry('/dir', true), ftp)));

		assert.ok(matchesAny(whenOf('disconnect'), serverContextValue(ftp, true)));
		assert.ok(!matchesAny(whenOf('disconnect'), serverContextValue(ftp, false)));
		assert.ok(matchesAny(whenOf('connect'), serverContextValue(ftp, false)));
		assert.ok(matchesAny(whenOf('newFolder'), serverContextValue(ftp, true)));
	});
});

