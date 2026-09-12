import * as assert from 'assert';
import * as vscode from 'vscode';

const EXTENSION_ID = 'raufkerimov.remote-host-explorer';

suite('Extension', () => {
	test('activates and registers its commands', async () => {
		const extension = vscode.extensions.getExtension(EXTENSION_ID);
		assert.ok(extension, `extension ${EXTENSION_ID} not found`);

		// Activating exercises the bundled entry point, which is what catches a broken bundle
		// (for example a runtime dependency that was not packaged).
		await extension.activate();
		assert.strictEqual(extension.isActive, true);

		const commands = await vscode.commands.getCommands(true);
		for (const expected of [
			'remoteHostExplorer.addServer',
			'remoteHostExplorer.refresh',
			'remoteHostExplorer.uploadFile',
			'remoteHostExplorer.downloadFile',
			'remoteHostExplorer.newFile',
		]) {
			assert.ok(commands.includes(expected), `missing command: ${expected}`);
		}
	});

	test('contributes the servers configuration point', () => {
		const servers = vscode.workspace.getConfiguration('remoteHostExplorer').get('servers');
		assert.ok(Array.isArray(servers));
	});

	test('the remote-hosts.json schema describes servers exactly like the setting', async () => {
		const extension = vscode.extensions.getExtension(EXTENSION_ID);
		assert.ok(extension);
		const manifest = extension.packageJSON as {
			contributes: { configuration: { properties: Record<string, { items: unknown }> } };
		};
		const schemaUri = vscode.Uri.joinPath(extension.extensionUri, 'media', 'remote-hosts.schema.json');
		const schema = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(schemaUri)).toString('utf8')) as {
			properties: { servers: { items: unknown } };
		};
		assert.deepStrictEqual(
			schema.properties.servers.items,
			manifest.contributes.configuration.properties['remoteHostExplorer.servers'].items
		);
	});
});
