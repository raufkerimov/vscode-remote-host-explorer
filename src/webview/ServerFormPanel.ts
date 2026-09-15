import * as crypto from 'crypto';
import * as fs from 'fs';
import * as vscode from 'vscode';
import type { ProfileScope, RemoteProtocol, ServerProfile } from '../config/serverConfig';
import {
	DEFAULT_IGNORE_GLOBS,
	DEFAULT_PRIVATE_KEY_PATH,
	getProfileScope,
	hasProjectScope,
	upsertServerProfile,
} from '../config/serverConfig';
import type { SecretsManager } from '../config/secrets';
import { buildRemoteClient, defaultPortFor, requireSshAgentSocket } from '../remote/clientFactory';
import type { HostKeyStore } from '../remote/hostKeys';
import type { RemoteClient, RemoteConnectionOptions } from '../remote/RemoteClient';
import { dirnameRemote, normalizeRemote } from '../util/remotePath';

/** Transports offered in the form. Only protocols with a working client belong here. */
const SUPPORTED_PROTOCOLS: { value: RemoteProtocol; label: string }[] = [
	{ value: 'sftp', label: 'SFTP (SSH)' },
	{ value: 'ftps', label: 'FTPS (FTP over TLS)' },
	{ value: 'ftp', label: 'FTP (unencrypted)' },
];

function isSupportedProtocol(value: string): value is RemoteProtocol {
	return SUPPORTED_PROTOCOLS.some(protocol => protocol.value === value);
}


export interface SubmittedForm {
	name: string;
	protocol: ServerProfile['protocol'];
	host: string;
	port: string;
	username: string;
	authMethod: 'password' | 'key' | 'agent';
	password: string;
	privateKeyPath: string;
	passphrase: string;
	remoteRoot: string;
	localPath: string;
	remoteMappedPath: string;
	autoUpload: boolean;
	ignoreGlobs: string;
	useRsyncForUpload: boolean;
	rsyncOptions: string;
	scope: ProfileScope;
}

type IncomingMessage =
	| { type: 'cancel' }
	| { type: 'submit'; payload: SubmittedForm }
	| { type: 'browseRemotePath'; field: 'remoteRoot' | 'remoteMappedPath'; payload: SubmittedForm }
	| { type: 'testConnection'; payload: SubmittedForm }
	| { type: 'browseLocalFile' | 'browseLocalFolder'; field: 'privateKeyPath' | 'localPath' };

interface PanelContext {
	context: vscode.ExtensionContext;
	secrets: SecretsManager;
	hostKeys: HostKeyStore;
	/** The profile being edited; saving overwrites it. */
	existing?: ServerProfile;
	/** The profile the form was filled from: `existing` when editing, the original when duplicating. */
	source?: ServerProfile;
}

export interface ServerFormOptions {
	/** Edit this profile. */
	existing?: ServerProfile;
	/** Start a new profile from a copy of this one. */
	duplicateOf?: ServerProfile;
}

/** Single-form webview for adding, editing, or duplicating a server. */
export class ServerFormPanel {
	private static readonly openPanels = new Map<string, vscode.WebviewPanel>();

	static async show(
		context: vscode.ExtensionContext,
		secrets: SecretsManager,
		hostKeys: HostKeyStore,
		onSaved: (profile: ServerProfile) => void,
		{ existing, duplicateOf }: ServerFormOptions = {}
	): Promise<void> {
		const key = existing?.id ?? (duplicateOf ? `duplicate:${duplicateOf.id}` : '__new__');
		const openPanel = ServerFormPanel.openPanels.get(key);
		if (openPanel) {
			openPanel.reveal();
			return;
		}

		const mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'media');
		const panel = vscode.window.createWebviewPanel(
			'remoteHostExplorer.serverForm',
			existing ? `Edit Server: ${existing.name}` : duplicateOf ? `Duplicate Server: ${duplicateOf.name}` : 'Add Server',
			vscode.ViewColumn.Active,
			{
				enableScripts: true,
				localResourceRoots: [mediaRoot],
				// Without this, switching tabs tears the form down and discards everything typed so far.
				retainContextWhenHidden: true,
			}
		);
		ServerFormPanel.openPanels.set(key, panel);

		// Scope listeners to the panel rather than the extension, so repeatedly opening the form does not
		// accumulate disposables for the lifetime of the session.
		const disposables: vscode.Disposable[] = [];
		panel.onDidDispose(
			() => {
				ServerFormPanel.openPanels.delete(key);
				disposables.forEach(disposable => disposable.dispose());
			},
			undefined,
			disposables
		);

		const panelContext: PanelContext = { context, secrets, hostKeys, existing, source: existing ?? duplicateOf };
		panel.webview.html = await renderForm(panel.webview, mediaRoot, existing, duplicateOf);

		panel.webview.onDidReceiveMessage(
			(message: IncomingMessage) => handleMessage(panel, panelContext, onSaved, message),
			undefined,
			disposables
		);
	}
}

async function handleMessage(
	panel: vscode.WebviewPanel,
	panelContext: PanelContext,
	onSaved: (profile: ServerProfile) => void,
	message: IncomingMessage
): Promise<void> {
	switch (message.type) {
		case 'cancel':
			panel.dispose();
			return;

		case 'browseLocalFile':
		case 'browseLocalFolder': {
			const wantsFile = message.type === 'browseLocalFile';
			const picked = await vscode.window.showOpenDialog({
				canSelectFiles: wantsFile,
				canSelectFolders: !wantsFile,
				canSelectMany: false,
				openLabel: wantsFile ? 'Select private key' : 'Select folder',
			});
			if (picked?.[0]) {
				panel.webview.postMessage({ type: 'setField', field: message.field, value: picked[0].fsPath });
			}
			return;
		}

		case 'browseRemotePath':
			await handleBrowseRemotePath(panel, panelContext, message.payload, message.field);
			return;

		case 'testConnection':
			await handleTestConnection(panel, panelContext, message.payload);
			return;

		case 'submit':
			await handleSubmit(panel, panelContext, onSaved, message.payload);
			return;
	}
}

function validate(form: SubmittedForm): string | undefined {
	if (!form.name.trim() || !form.host.trim() || !form.remoteRoot.trim()) {
		return 'Name, host, and remote root are required.';
	}
	if (!isSupportedProtocol(form.protocol)) {
		return `Protocol "${String(form.protocol)}" is not supported.`;
	}
	if (form.host.trim().startsWith('-')) {
		return 'Host must not start with "-".';
	}
	if (form.username.trim().startsWith('-')) {
		return 'Username must not start with "-".';
	}
	if (form.port.trim()) {
		const port = Number(form.port);
		if (!Number.isInteger(port) || port < 1 || port > 65535) {
			return 'Port must be a whole number between 1 and 65535.';
		}
	}
	return undefined;
}

async function handleSubmit(
	panel: vscode.WebviewPanel,
	{ secrets, existing, source }: PanelContext,
	onSaved: (profile: ServerProfile) => void,
	form: SubmittedForm
): Promise<void> {
	const problem = validate(form);
	if (problem) {
		panel.webview.postMessage({ type: 'error', message: problem });
		return;
	}

	const id = existing?.id ?? crypto.randomUUID();
	// Key and agent authentication only exist for SFTP; FTP always authenticates with a password.
	const usesKeyAuth = form.protocol === 'sftp' && form.authMethod === 'key';
	const usesAgent = form.protocol === 'sftp' && form.authMethod === 'agent';
	const copyFrom = duplicateCredentialSource(existing, source, form);

	if (usesAgent) {
		// The agent holds the keys; a stored password or passphrase would be a credential nothing uses.
		await secrets.deleteAll(id);
	} else if (usesKeyAuth) {
		const passphrase = form.passphrase || (copyFrom ? await secrets.getPassphrase(copyFrom.id) : undefined);
		if (passphrase) {
			await secrets.setPassphrase(id, passphrase);
		}
		// The password no longer applies to this profile; leaving it in SecretStorage keeps a credential
		// around that nothing can use.
		await secrets.deletePassword(id);
	} else {
		const password = form.password || (copyFrom ? await secrets.getPassword(copyFrom.id) : undefined);
		if (password) {
			await secrets.setPassword(id, password);
		}
		await secrets.deletePassphrase(id);
	}

	const profile: ServerProfile = {
		id,
		name: form.name.trim(),
		protocol: form.protocol,
		host: form.host.trim(),
		port: form.port.trim() ? Number(form.port) : undefined,
		username: form.username.trim() || undefined,
		// Clearing this when password auth is selected stops a stale key from being offered to the server.
		privateKeyPath: usesKeyAuth ? form.privateKeyPath.trim() || undefined : undefined,
		useSshAgent: usesAgent || undefined,
		remoteRoot: normalizeRemote(form.remoteRoot.trim()) || '/',
		localPath: form.localPath.trim() || undefined,
		remoteMappedPath: normalizeRemote(form.remoteMappedPath.trim()) || undefined,
		autoUpload: form.autoUpload,
		ignoreGlobs: splitLines(form.ignoreGlobs),
		useRsyncForUpload: form.protocol === 'sftp' ? form.useRsyncForUpload : false,
		rsyncOptions: splitLines(form.rsyncOptions),
	};

	// A project scope only exists while a folder is open; fall back rather than failing the save.
	const scope: ProfileScope = form.scope === 'project' && hasProjectScope() ? 'project' : 'global';
	await upsertServerProfile(profile, scope);
	onSaved(profile);
	panel.dispose();
}

function splitLines(value: string): string[] {
	return value
		.split('\n')
		.map(line => line.trim())
		.filter(Boolean);
}

async function handleBrowseRemotePath(
	panel: vscode.WebviewPanel,
	panelContext: PanelContext,
	form: SubmittedForm,
	field: 'remoteRoot' | 'remoteMappedPath'
): Promise<void> {
	const problem = validateForConnect(form);
	if (problem) {
		panel.webview.postMessage({ type: 'error', message: problem });
		return;
	}
	// The mapped folder usually lives inside the root, so start browsing from whichever is filled in.
	const startPath = normalizeRemote((field === 'remoteMappedPath' && form.remoteMappedPath.trim()) || form.remoteRoot.trim()) || '/';

	let client: RemoteClient | undefined;
	try {
		client = await createClientFromForm(panelContext, form);
		await client.connect();
		const selected = await pickRemoteDirectory(client, startPath);
		if (selected) {
			panel.webview.postMessage({ type: 'setField', field, value: selected });
		}
	} catch (err) {
		panel.webview.postMessage({ type: 'error', message: `Could not browse remote server: ${(err as Error).message}` });
	} finally {
		await client?.disconnect();
	}
}

async function handleTestConnection(
	panel: vscode.WebviewPanel,
	panelContext: PanelContext,
	form: SubmittedForm
): Promise<void> {
	const problem = validateForConnect(form);
	if (problem) {
		panel.webview.postMessage({ type: 'testResult', success: false, message: problem });
		return;
	}

	let client: RemoteClient | undefined;
	try {
		client = await createClientFromForm(panelContext, form);
		await client.connect();
		await client.list(normalizeRemote(form.remoteRoot.trim()) || '/');
		panel.webview.postMessage({ type: 'testResult', success: true, message: 'Connected successfully.' });
	} catch (err) {
		panel.webview.postMessage({ type: 'testResult', success: false, message: (err as Error).message });
	} finally {
		await client?.disconnect();
	}
}

function validateForConnect(form: SubmittedForm): string | undefined {
	if (!form.host.trim()) {
		return 'Enter a host first.';
	}
	return validate({ ...form, name: form.name || 'unnamed', remoteRoot: form.remoteRoot || '/' });
}

/**
 * The profile whose saved password/passphrase a new duplicate may take over when those fields are left
 * blank: the original, and only while the form still targets its endpoint. Editing never copies anything.
 */
export function duplicateCredentialSource(
	existing: ServerProfile | undefined,
	source: ServerProfile | undefined,
	form: SubmittedForm
): ServerProfile | undefined {
	return !existing && source && targetsSameEndpoint(source, form) ? source : undefined;
}

/**
 * True when the form still points at the same endpoint, over the same protocol, as the saved profile.
 *
 * Stored credentials are only reused in that case. Otherwise editing the host and pressing "Test
 * Connection" would send the saved password to whatever server was typed in — and switching an SFTP
 * profile to plain FTP would send it across the network unencrypted.
 */
function targetsSameEndpoint(existing: ServerProfile | undefined, form: SubmittedForm): boolean {
	if (!existing) {
		return false;
	}
	const formPort = form.port.trim() ? Number(form.port) : defaultPortFor(form.protocol);
	const existingPort = existing.port ?? defaultPortFor(existing.protocol);
	return (
		existing.protocol === form.protocol &&
		existing.host === form.host.trim() &&
		existingPort === formPort &&
		(existing.username ?? '') === form.username.trim()
	);
}

async function createClientFromForm(
	{ secrets, hostKeys, source }: PanelContext,
	form: SubmittedForm
): Promise<RemoteClient> {
	const mayReuseSecrets = targetsSameEndpoint(source, form);
	const usesKeyAuth = form.protocol === 'sftp' && form.authMethod === 'key';
	const usesAgent = form.protocol === 'sftp' && form.authMethod === 'agent';

	const password = usesKeyAuth || usesAgent
		? undefined
		: form.password || (mayReuseSecrets && source ? await secrets.getPassword(source.id) : undefined);

	const host = form.host.trim();
	const port = form.port.trim() ? Number(form.port) : defaultPortFor(form.protocol);
	const options: RemoteConnectionOptions = {
		host,
		port,
		username: form.username.trim() || undefined,
		password,
	};

	if (form.protocol === 'sftp') {
		options.privateKeyPath = usesKeyAuth ? form.privateKeyPath.trim() || undefined : undefined;
		options.passphrase = usesKeyAuth
			? form.passphrase || (mayReuseSecrets && source ? await secrets.getPassphrase(source.id) : undefined)
			: undefined;
		options.agent = usesAgent ? requireSshAgentSocket() : undefined;
		options.hostKeyPolicy = hostKeys.policyFor(form.name.trim() || host, host, port);
	}

	return buildRemoteClient(form.protocol, options);
}

interface DirectoryPickItem extends vscode.QuickPickItem {
	action: 'select' | 'up' | 'enter';
	target?: string;
}

/** QuickPick-driven remote directory navigator: pick a subfolder, go up, or confirm the current one. */
async function pickRemoteDirectory(client: RemoteClient, startPath: string): Promise<string | undefined> {
	let current = startPath;

	for (;;) {
		let directories;
		try {
			directories = (await client.list(current)).filter(entry => entry.isDirectory);
		} catch (err) {
			void vscode.window.showErrorMessage(`Failed to list "${current}": ${(err as Error).message}`);
			return undefined;
		}

		const items: DirectoryPickItem[] = [
			{ label: '$(check) Select this folder', description: current, action: 'select' },
			...(current !== '/' ? [{ label: '$(arrow-up) ..', description: 'Go up', action: 'up' as const }] : []),
			...directories.map(entry => ({
				label: `$(folder) ${entry.name}`,
				description: entry.path,
				action: 'enter' as const,
				target: entry.path,
			})),
		];

		const picked = await vscode.window.showQuickPick(items, {
			placeHolder: `Browsing ${current}`,
			ignoreFocusOut: true,
		});
		if (!picked) {
			return undefined;
		}
		if (picked.action === 'select') {
			return current;
		}
		current = picked.action === 'up' ? dirnameRemote(current) : picked.target ?? current;
	}
}

function getNonce(): string {
	// Cryptographically random: a CSP nonce built from Math.random is guessable.
	return crypto.randomBytes(16).toString('base64');
}

/**
 * Serialises data for the `application/json` bootstrap block. Escaping `<` is what prevents a value
 * containing `</script>` from terminating the block early.
 */
function toJsonScript(value: unknown): string {
	return JSON.stringify(value).replace(/</g, '\\u003c');
}

async function renderForm(
	webview: vscode.Webview,
	mediaRoot: vscode.Uri,
	existing?: ServerProfile,
	duplicateOf?: ServerProfile
): Promise<string> {
	const source = existing ?? duplicateOf;
	const nonce = getNonce();
	const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'serverForm.css'));
	const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'serverForm.js'));
	const csp = [
		`default-src 'none'`,
		`style-src ${webview.cspSource}`,
		`script-src 'nonce-${nonce}'`,
	].join('; ');

	const projectAvailable = hasProjectScope();
	const initialState = {
		isEdit: Boolean(existing),
		isDuplicate: Boolean(duplicateOf),
		protocols: SUPPORTED_PROTOCOLS,
		defaultPorts: { sftp: defaultPortFor('sftp'), ftp: defaultPortFor('ftp'), ftps: defaultPortFor('ftps') },
		projectAvailable,
		values: {
			name: duplicateOf ? `${duplicateOf.name} (copy)` : source?.name ?? '',
			protocol: source?.protocol ?? SUPPORTED_PROTOCOLS[0].value,
			// New servers default to the open project so they don't appear in every other window.
			scope: (source ? getProfileScope(source.id) : undefined) ?? (projectAvailable ? 'project' : 'global'),
			host: source?.host ?? '',
			port: source?.port === undefined ? '' : String(source.port),
			username: source?.username ?? '',
			authMethod: source?.useSshAgent ? 'agent' : source?.privateKeyPath ? 'key' : 'password',
			// Only saved when private key authentication is chosen; password and agent servers drop it.
			privateKeyPath: source?.privateKeyPath ?? DEFAULT_PRIVATE_KEY_PATH,
			remoteRoot: source?.remoteRoot ?? '/',
			localPath: source?.localPath ?? '',
			remoteMappedPath: source?.remoteMappedPath ?? '',
			autoUpload: source?.autoUpload ?? false,
			ignoreGlobs: (source?.ignoreGlobs ?? DEFAULT_IGNORE_GLOBS).join('\n'),
			useRsyncForUpload: source?.useRsyncForUpload ?? false,
			rsyncOptions: (source?.rsyncOptions ?? []).join('\n'),
		},
	};

	const template = await fs.promises.readFile(vscode.Uri.joinPath(mediaRoot, 'serverForm.html').fsPath, 'utf8');
	return template
		.replace(/{{CSP}}/g, csp)
		.replace(/{{NONCE}}/g, nonce)
		.replace(/{{STYLE_URI}}/g, styleUri.toString())
		.replace(/{{SCRIPT_URI}}/g, scriptUri.toString())
		.replace(/{{INITIAL_STATE}}/g, toJsonScript(initialState));
}
