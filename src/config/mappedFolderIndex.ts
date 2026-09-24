import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
	folderMappings,
	getServerProfiles,
	isIgnored,
	onDidChangeServerProfiles,
	whenServerProfilesLoaded,
	type ServerProfile,
} from './serverConfig';

/**
 * Every local folder inside a mapping, as an object keyed by path. The Explorer's "Upload to Remote Host"
 * is enabled with `resourcePath in …` / `resourceDirname in …`: when clauses can test exact membership
 * but not "is inside", so the folders have to be listed.
 */
export const CONTEXT_MAPPED_FOLDERS = 'remoteHostExplorer.mappedFolders';
/** Set when a mapping holds more folders than are indexed; the upload action then stays enabled everywhere. */
export const CONTEXT_MAPPED_FOLDERS_INCOMPLETE = 'remoteHostExplorer.mappedFoldersIncomplete';

/** Stops a mapping of something huge (a home folder) from walking the whole disk. */
export const MAX_INDEXED_FOLDERS = 20_000;

/** How long file system activity must settle before the index is rebuilt. */
const REBUILD_DELAY_MS = 1000;

export interface MappedFolders {
	/** Paths as VS Code writes them into `resourcePath` for a `file` URI (`Uri.fsPath`). */
	folders: string[];
	/** False when the limit was reached before every folder was visited. */
	complete: boolean;
}

/**
 * Lists the folders inside every mapping of the given profiles. Folders matching an ignore pattern are
 * listed (right-clicking one still uploads it) but not entered, which keeps `node_modules` and `.git` out.
 * Symbolic links are not followed, so a link cycle cannot loop.
 */
export async function collectMappedFolders(
	servers: readonly ServerProfile[],
	limit: number = MAX_INDEXED_FOLDERS
): Promise<MappedFolders> {
	const folders = new Set<string>();
	for (const server of servers) {
		for (const { localPath } of folderMappings(server)) {
			const queue = [{ directory: localPath, descend: true }];
			while (queue.length > 0) {
				if (folders.size >= limit) {
					return { folders: [...folders], complete: false };
				}
				const { directory, descend } = queue.shift()!;
				folders.add(vscode.Uri.file(directory).fsPath);
				if (!descend) {
					continue;
				}

				let items: fs.Dirent[];
				try {
					items = await fs.promises.readdir(directory, { withFileTypes: true });
				} catch {
					// A mapped folder that doesn't exist (yet) or can't be read simply has nothing inside.
					continue;
				}
				for (const item of items) {
					if (!item.isDirectory()) {
						continue;
					}
					const child = path.join(directory, item.name);
					const relative = path.relative(localPath, child).replace(/\\/g, '/');
					queue.push({ directory: child, descend: !isIgnored(server, relative) });
				}
			}
		}
	}
	return { folders: [...folders], complete: true };
}

/** Keeps the mapped-folder context keys current as profiles and the mapped folders change. */
export class MappedFolderIndex implements vscode.Disposable {
	private readonly disposables: vscode.Disposable[] = [];
	private watchers: vscode.FileSystemWatcher[] = [];
	private folders = new Set<string>();
	private roots: string[] = [];
	private timer: ReturnType<typeof setTimeout> | undefined;
	/** Incremented per rebuild so a slow walk can't overwrite the result of a newer one. */
	private generation = 0;

	constructor(private readonly outputChannel: vscode.OutputChannel) {
		this.disposables.push(onDidChangeServerProfiles(() => this.schedule(0)));
		void whenServerProfilesLoaded().then(() => this.schedule(0));
	}

	private schedule(delay = REBUILD_DELAY_MS): void {
		if (this.timer) {
			clearTimeout(this.timer);
		}
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.rebuild().catch(err =>
				this.outputChannel.appendLine(`Couldn't list mapped folders: ${(err as Error).message}`)
			);
		}, delay);
	}

	private async rebuild(): Promise<void> {
		const generation = ++this.generation;
		const servers = getServerProfiles();
		const roots = [...new Set(servers.flatMap(server => folderMappings(server).map(mapping => mapping.localPath)))];
		if (roots.join('\n') !== this.roots.join('\n')) {
			this.watch(roots);
		}

		const { folders, complete } = await collectMappedFolders(servers);
		if (generation !== this.generation) {
			return;
		}
		this.folders = new Set(folders);
		if (!complete) {
			this.outputChannel.appendLine(
				`Mapped folders contain more than ${MAX_INDEXED_FOLDERS} folders; "Upload to Remote Host" stays enabled for every Explorer item.`
			);
		}
		await vscode.commands.executeCommand(
			'setContext',
			CONTEXT_MAPPED_FOLDERS,
			Object.fromEntries(folders.map(folder => [folder, true]))
		);
		await vscode.commands.executeCommand('setContext', CONTEXT_MAPPED_FOLDERS_INCOMPLETE, !complete);
	}

	/** Only folders being created or deleted change the index; file activity is ignored. */
	private watch(roots: string[]): void {
		this.roots = roots;
		this.watchers.forEach(watcher => watcher.dispose());
		this.watchers = roots.map(root => {
			const watcher = vscode.workspace.createFileSystemWatcher(
				new vscode.RelativePattern(vscode.Uri.file(root), '**'),
				false,
				true,
				false
			);
			watcher.onDidCreate(uri => {
				void fs.promises.stat(uri.fsPath).then(
					stats => stats.isDirectory() && this.schedule(),
					() => undefined
				);
			});
			watcher.onDidDelete(uri => {
				if (this.folders.has(uri.fsPath)) {
					this.schedule();
				}
			});
			return watcher;
		});
	}

	dispose(): void {
		if (this.timer) {
			clearTimeout(this.timer);
		}
		this.generation += 1;
		this.watchers.forEach(watcher => watcher.dispose());
		this.disposables.forEach(disposable => disposable.dispose());
	}
}
