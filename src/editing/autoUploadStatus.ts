import * as vscode from 'vscode';
import {
	getProfileScope,
	onDidChangeServerProfiles,
	resolveServersForLocalPath,
	upsertServerProfile,
	whenServerProfilesLoaded,
	type LocalPathResolution,
} from '../config/serverConfig';

export const TOGGLE_AUTO_UPLOAD_COMMAND = 'remoteHostExplorer.toggleAutoUpload';

/** Mappings of the active editor's file, or none when it isn't a local file inside a mapping. */
function activeFileMappings(): LocalPathResolution[] {
	const uri = vscode.window.activeTextEditor?.document.uri;
	return uri?.scheme === 'file' ? resolveServersForLocalPath(uri.fsPath) : [];
}

/**
 * Status bar item for mapped files: where saving uploads to (`↑ dev`), or that auto-upload is off.
 * Production targets get the warning background. Clicking it chooses which servers auto-upload.
 */
export class AutoUploadStatus implements vscode.Disposable {
	private readonly item = vscode.window.createStatusBarItem(
		'remoteHostExplorer.autoUpload',
		vscode.StatusBarAlignment.Right,
		100
	);
	private readonly disposables: vscode.Disposable[];

	constructor() {
		this.item.name = 'Remote Host Explorer: Auto-Upload';
		this.item.command = TOGGLE_AUTO_UPLOAD_COMMAND;
		this.disposables = [
			this.item,
			vscode.window.onDidChangeActiveTextEditor(() => this.update()),
			onDidChangeServerProfiles(() => this.update()),
			vscode.commands.registerCommand(TOGGLE_AUTO_UPLOAD_COMMAND, () =>
				chooseAutoUploadServers().catch(err =>
					vscode.window.showErrorMessage(`Couldn't change auto-upload: ${(err as Error).message}`)
				)
			),
		];
		this.update();
		// Project servers are read asynchronously; the first update may run before they are known.
		void whenServerProfilesLoaded().then(() => this.update());
	}

	update(): void {
		const mappings = activeFileMappings();
		if (mappings.length === 0) {
			this.item.hide();
			return;
		}
		const uploading = mappings.filter(mapping => mapping.server.autoUpload);
		this.item.text =
			uploading.length > 0
				? `$(cloud-upload) ${uploading.map(mapping => mapping.server.name).join(', ')}`
				: '$(cloud) Auto-upload off';
		this.item.tooltip =
			uploading.length > 0
				? `Saving this file uploads it to:\n${uploading.map(mapping => `${mapping.server.name} → ${mapping.remotePath}`).join('\n')}\n\nClick to change.`
				: 'Saving this file does not upload it. Click to turn on auto-upload.';
		this.item.backgroundColor = uploading.some(mapping => mapping.server.production)
			? new vscode.ThemeColor('statusBarItem.warningBackground')
			: undefined;
		this.item.show();
	}

	dispose(): void {
		this.disposables.forEach(disposable => disposable.dispose());
	}
}

/** Lets the user tick which of the active file's servers upload on save, and saves the profiles. */
async function chooseAutoUploadServers(): Promise<void> {
	const mappings = activeFileMappings();
	if (mappings.length === 0) {
		vscode.window.showInformationMessage('The active file is not inside a folder mapping.');
		return;
	}
	const picked = await vscode.window.showQuickPick(
		mappings.map(mapping => ({
			label: mapping.server.name,
			description: `→ ${mapping.remotePath}${mapping.server.production ? ' · production' : ''}`,
			picked: Boolean(mapping.server.autoUpload),
			server: mapping.server,
		})),
		{
			canPickMany: true,
			placeHolder: 'Upload on save to… (applies to every file the server maps)',
		}
	);
	if (!picked) {
		return;
	}
	const chosen = new Set(picked.map(item => item.server.id));
	for (const { server } of mappings) {
		const autoUpload = chosen.has(server.id);
		if (Boolean(server.autoUpload) !== autoUpload) {
			await upsertServerProfile({ ...server, autoUpload }, getProfileScope(server.id) ?? 'global');
		}
	}
}
