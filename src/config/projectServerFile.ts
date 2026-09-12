import * as vscode from 'vscode';
import { applyEdits, modify, parse, printParseErrorCode, type ParseError } from 'jsonc-parser';
import { isSameOrInside, normalizeLocal } from '../util/localPath';
import type { ServerProfile } from './serverConfig';

/** Project-scoped servers live in this file inside each workspace folder, not in `.vscode/settings.json`. */
export const PROJECT_SERVERS_FILE = '.vscode/remote-hosts.json';

const FORMATTING = { insertSpaces: true, tabSize: 2, eol: '\n' };

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function lineOf(text: string, offset: number): number {
	return text.slice(0, offset).split('\n').length;
}

/**
 * Reads the server list out of a `remote-hosts.json` document. Comments and trailing commas are allowed,
 * because VS Code edits `.vscode/*.json` as JSON with comments. Throws a readable message for anything
 * that can't be trusted, so a broken file is never mistaken for an empty one and overwritten.
 */
export function parseProjectServers(text: string): ServerProfile[] {
	if (!text.trim()) {
		return [];
	}
	const errors: ParseError[] = [];
	const data: unknown = parse(text, errors, { allowTrailingComma: true });
	if (errors.length > 0) {
		const [first] = errors;
		throw new Error(`${printParseErrorCode(first.error)} on line ${lineOf(text, first.offset)}`);
	}
	if (!isPlainObject(data)) {
		throw new Error('expected an object with a "servers" list');
	}
	if (data.servers === undefined) {
		return [];
	}
	if (!Array.isArray(data.servers) || !data.servers.every(isPlainObject)) {
		throw new Error('"servers" must be a list of server objects');
	}
	return data.servers as unknown as ServerProfile[];
}

/** Replaces the server list in a document, keeping any other content, comments, and formatting. */
export function withProjectServers(text: string, servers: readonly ServerProfile[]): string {
	const updated = applyEdits(text, modify(text, ['servers'], servers, { formattingOptions: FORMATTING }));
	return updated.endsWith('\n') ? updated : updated + '\n';
}

/**
 * Picks which open folder a new project server is saved in: the deepest folder containing its local
 * folder, otherwise the first one. Pure so it can be unit tested.
 */
export function folderIndexForLocalPath(folderPaths: readonly string[], localPath: string | undefined): number {
	if (!localPath) {
		return 0;
	}
	const target = normalizeLocal(localPath);
	let best = 0;
	let bestLength = -1;
	folderPaths.forEach((folderPath, index) => {
		const root = normalizeLocal(folderPath);
		if (isSameOrInside(root, target) && root.length > bestLength) {
			best = index;
			bestLength = root.length;
		}
	});
	return best;
}

export interface ProjectServer {
	profile: ServerProfile;
	folder: vscode.WorkspaceFolder;
}

function fileUri(folder: vscode.WorkspaceFolder): vscode.Uri {
	return vscode.Uri.joinPath(folder.uri, PROJECT_SERVERS_FILE);
}

/** `vscode.workspace.fs` rather than `node:fs`: in remote windows the workspace is not on this machine. */
async function readText(uri: vscode.Uri): Promise<string | undefined> {
	try {
		return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
	} catch (err) {
		if (err instanceof vscode.FileSystemError && err.code === 'FileNotFound') {
			return undefined;
		}
		throw err;
	}
}

/**
 * In-memory copy of every open folder's `remote-hosts.json`, kept current by file watchers. Callers need
 * the list synchronously (tree rendering, context keys), so reads are served from memory; every write
 * re-reads the file from disk first so it never works from a stale or broken copy.
 */
export class ProjectServerStore implements vscode.Disposable {
	private servers: ProjectServer[] = [];
	private watchers: vscode.Disposable[] = [];
	private generation = 0;
	private writes: Promise<unknown> = Promise.resolve();
	/** Last error reported per file, so an unchanged broken file isn't announced on every reload. */
	private readonly reportedErrors = new Map<string, string>();
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changed.event;

	constructor(private readonly outputChannel: vscode.OutputChannel) {}

	/** Every project server; if two folders define the same id, the first folder wins. */
	list(): ProjectServer[] {
		return this.servers;
	}

	/** (Re)creates the watchers for the currently open folders. */
	watchFolders(): void {
		this.disposeWatchers();
		for (const folder of vscode.workspace.workspaceFolders ?? []) {
			const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, PROJECT_SERVERS_FILE));
			const reload = () => void this.reload();
			this.watchers.push(watcher, watcher.onDidCreate(reload), watcher.onDidChange(reload), watcher.onDidDelete(reload));
		}
	}

	async reload(): Promise<void> {
		const generation = ++this.generation;
		const folders = vscode.workspace.workspaceFolders ?? [];
		const perFolder = await Promise.all(folders.map(async folder => ({ folder, profiles: await this.readForDisplay(folder) })));
		// A slower, older reload must not overwrite the result of a newer one.
		if (generation !== this.generation) {
			return;
		}
		const seen = new Set<string>();
		this.servers = perFolder.flatMap(({ folder, profiles }) =>
			profiles
				.filter(profile => !seen.has(profile.id) && seen.add(profile.id))
				.map(profile => ({ profile, folder }))
		);
		this.changed.fire();
	}

	private async readForDisplay(folder: vscode.WorkspaceFolder): Promise<ServerProfile[]> {
		const uri = fileUri(folder);
		try {
			const profiles = parseProjectServers((await readText(uri)) ?? '');
			this.reportedErrors.delete(uri.toString());
			return profiles;
		} catch (err) {
			const message = `Couldn't read ${PROJECT_SERVERS_FILE} in "${folder.name}": ${(err as Error).message}`;
			if (this.reportedErrors.get(uri.toString()) !== message) {
				this.reportedErrors.set(uri.toString(), message);
				this.outputChannel.appendLine(message);
				void vscode.window.showWarningMessage(message);
			}
			return [];
		}
	}

	/**
	 * Applies `change` to one folder's server list and saves it. `change` returns `undefined` to leave the
	 * file untouched. Writes run one at a time so two quick saves can't overwrite each other.
	 */
	update(folder: vscode.WorkspaceFolder, change: (servers: ServerProfile[]) => ServerProfile[] | undefined): Promise<void> {
		const run = this.writes.then(() => this.write(folder, change));
		this.writes = run.catch(() => undefined);
		return run;
	}

	private async write(folder: vscode.WorkspaceFolder, change: (servers: ServerProfile[]) => ServerProfile[] | undefined) {
		const uri = fileUri(folder);
		const text = (await readText(uri)) ?? '';
		let current: ServerProfile[];
		try {
			current = parseProjectServers(text);
		} catch (err) {
			throw new Error(
				`${PROJECT_SERVERS_FILE} in "${folder.name}" can't be read (${(err as Error).message}). Fix or delete the file, then try again.`
			);
		}
		const next = change([...current]);
		if (!next) {
			return;
		}
		await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
		await vscode.workspace.fs.writeFile(uri, Buffer.from(withProjectServers(text, next), 'utf8'));
		await this.reload();
	}

	private disposeWatchers(): void {
		for (const watcher of this.watchers) {
			watcher.dispose();
		}
		this.watchers = [];
	}

	dispose(): void {
		this.disposeWatchers();
		this.changed.dispose();
	}
}
