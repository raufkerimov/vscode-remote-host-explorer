import * as vscode from 'vscode';
import { matchesAnyGlob } from '../util/glob';
import { isSameOrInside, normalizeLocal } from '../util/localPath';
import { joinRemote, normalizeRemote } from '../util/remotePath';
import { folderIndexForLocalPath, ProjectServerStore } from './projectServerFile';

/** `ftps` is explicit TLS (AUTH TLS on the normal FTP port). */
export type RemoteProtocol = 'sftp' | 'ftp' | 'ftps';

export interface ServerProfile {
	id: string;
	name: string;
	protocol: RemoteProtocol;
	host: string;
	port?: number;
	username?: string;
	privateKeyPath?: string;
	remoteRoot: string;
	localPath?: string;
	autoUpload?: boolean;
	ignoreGlobs?: string[];
	/** SFTP only: upload via `rsync` over ssh instead of SFTP put (faster for large/many files). */
	useRsyncForUpload?: boolean;
	rsyncOptions?: string[];
}

export interface LocalPathResolution {
	server: ServerProfile;
	/** Absolute remote path the local file maps to. */
	remotePath: string;
	/** POSIX path relative to the mapping root; `''` when the file *is* the root. */
	relativePath: string;
}

const CONFIG_SECTION = 'remoteHostExplorer';
/** Version 0.1.0 saved servers under this name. */
const LEGACY_CONFIG_SECTION = 'remoteHostViewer';
const SERVERS_KEY = 'servers';

/**
 * Where a profile is stored, which decides where it is visible:
 * - `project` — `.vscode/remote-hosts.json` in a workspace folder; shown only when that folder is open.
 * - `global` — user settings; shown in every window.
 */
export type ProfileScope = 'project' | 'global';

export interface ScopedProfile {
	profile: ServerProfile;
	scope: ProfileScope;
}

/**
 * Combines both stores into the list the UI shows. Pure so it can be unit tested.
 *
 * If the same id appears in both, the project copy wins; if two project folders define the same id, the
 * first one wins, because the tree identifies servers by id.
 */
export function mergeScopedProfiles(
	globalProfiles: readonly ServerProfile[] | undefined,
	projectProfiles: readonly ServerProfile[] | undefined
): ScopedProfile[] {
	const projectIds = new Set<string>();
	const project: ScopedProfile[] = [];
	for (const profile of projectProfiles ?? []) {
		if (!projectIds.has(profile.id)) {
			projectIds.add(profile.id);
			project.push({ profile, scope: 'project' });
		}
	}
	const global = (globalProfiles ?? [])
		.filter(profile => !projectIds.has(profile.id))
		.map(profile => ({ profile, scope: 'global' as const }));
	return [...project, ...global];
}

/** True when a folder is open, i.e. there is somewhere to store project-scoped profiles. */
export function hasProjectScope(): boolean {
	return (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
}

let projectStore: ProjectServerStore | undefined;
let loaded: Promise<void> = Promise.resolve();
const profilesChanged = new vscode.EventEmitter<void>();

/** Fires when either store changes: a project file (saved here, edited by hand, or pulled) or user settings. */
export const onDidChangeServerProfiles = profilesChanged.event;

/** Resolves once the project files of the open folders have been read. */
export function whenServerProfilesLoaded(): Promise<void> {
	return loaded;
}

/** Starts reading and watching project server files, and moves servers saved by older versions. */
export function activateServerProfiles(outputChannel: vscode.OutputChannel): vscode.Disposable {
	const store = new ProjectServerStore(outputChannel);
	projectStore = store;

	let migration = Promise.resolve();
	const migrate = () => {
		migration = migration
			.then(() => migrateLegacySettings(store))
			.catch(err => {
				const message = `Couldn't move saved servers to their new location: ${(err as Error).message}`;
				outputChannel.appendLine(message);
				void vscode.window.showWarningMessage(message);
			});
		return migration;
	};
	const load = () => {
		store.watchFolders();
		loaded = migrate().then(() => store.reload());
	};
	load();

	return vscode.Disposable.from(
		store,
		store.onDidChange(() => profilesChanged.fire()),
		vscode.workspace.onDidChangeConfiguration(event => {
			if (
				event.affectsConfiguration(`${CONFIG_SECTION}.${SERVERS_KEY}`)
				|| event.affectsConfiguration(`${LEGACY_CONFIG_SECTION}.${SERVERS_KEY}`)
			) {
				void migrate().then(() => profilesChanged.fire());
			}
		}),
		// Adding or removing a folder changes which project files exist.
		vscode.workspace.onDidChangeWorkspaceFolders(load),
		new vscode.Disposable(() => {
			projectStore = undefined;
		})
	);
}

function requireStore(): ProjectServerStore {
	if (!projectStore) {
		throw new Error('Remote Host Explorer is not active.');
	}
	return projectStore;
}

function folderForNewProfile(profile: ServerProfile): vscode.WorkspaceFolder {
	const folders = vscode.workspace.workspaceFolders ?? [];
	if (folders.length === 0) {
		throw new Error('Open a folder to save a project-scoped server.');
	}
	return folders[folderIndexForLocalPath(folders.map(folder => folder.uri.fsPath), profile.localPath)];
}

/**
 * Older versions kept project servers in workspace settings (`.vscode/settings.json` or the
 * `.code-workspace` file), and 0.1.0 used the `remoteHostViewer` name for both scopes. Each value is
 * written to its new home before the old one is cleared, so a failure leaves nothing lost.
 */
async function migrateLegacySettings(store: ProjectServerStore): Promise<void> {
	const current = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const legacy = vscode.workspace.getConfiguration(LEGACY_CONFIG_SECTION);

	if (hasProjectScope()) {
		for (const config of [current, legacy]) {
			const profiles = config.inspect<ServerProfile[]>(SERVERS_KEY)?.workspaceValue;
			if (!Array.isArray(profiles)) {
				continue;
			}
			for (const profile of profiles) {
				await store.update(folderForNewProfile(profile), servers =>
					servers.some(server => server.id === profile.id) ? undefined : [...servers, profile]
				);
			}
			await config.update(SERVERS_KEY, undefined, vscode.ConfigurationTarget.Workspace);
		}
	}

	const legacyGlobal = legacy.inspect<ServerProfile[]>(SERVERS_KEY)?.globalValue;
	if (Array.isArray(legacyGlobal)) {
		const existing = current.inspect<ServerProfile[]>(SERVERS_KEY)?.globalValue ?? [];
		const ids = new Set(existing.map(server => server.id));
		const added = legacyGlobal.filter(server => !ids.has(server.id));
		if (added.length > 0) {
			await writeGlobal([...existing, ...added]);
		}
		await legacy.update(SERVERS_KEY, undefined, vscode.ConfigurationTarget.Global);
	}
}

function globalProfiles(): ServerProfile[] {
	return vscode.workspace.getConfiguration(CONFIG_SECTION).inspect<ServerProfile[]>(SERVERS_KEY)?.globalValue ?? [];
}

/** Writes the user-settings list, clearing the key entirely when it becomes empty so no `[]` is left behind. */
async function writeGlobal(servers: ServerProfile[]): Promise<void> {
	await vscode.workspace
		.getConfiguration(CONFIG_SECTION)
		.update(SERVERS_KEY, servers.length > 0 ? servers : undefined, vscode.ConfigurationTarget.Global);
}

export function getScopedServerProfiles(): ScopedProfile[] {
	const project = hasProjectScope() ? projectStore?.list().map(entry => entry.profile) : [];
	return mergeScopedProfiles(globalProfiles(), project);
}

export function getServerProfiles(): ServerProfile[] {
	return getScopedServerProfiles().map(entry => entry.profile);
}

export function getServerProfile(id: string): ServerProfile | undefined {
	return getServerProfiles().find(server => server.id === id);
}

export function getProfileScope(id: string): ProfileScope | undefined {
	return getScopedServerProfiles().find(entry => entry.profile.id === id)?.scope;
}

async function removeFromProjects(store: ProjectServerStore, id: string): Promise<void> {
	const folders = new Set(store.list().filter(entry => entry.profile.id === id).map(entry => entry.folder));
	for (const folder of folders) {
		await store.update(folder, servers => servers.filter(server => server.id !== id));
	}
}

/**
 * Saves a profile into the requested scope. Changing a profile's scope moves it: it is removed from the
 * other store in the same operation so it never shows up twice. An existing project profile stays in
 * the folder whose file already holds it.
 */
export async function upsertServerProfile(profile: ServerProfile, scope: ProfileScope): Promise<void> {
	const store = requireStore();
	await loaded;

	const replaceIn = (list: ServerProfile[]) => {
		const next = [...list];
		const index = next.findIndex(server => server.id === profile.id);
		if (index >= 0) {
			next[index] = profile;
		} else {
			next.push(profile);
		}
		return next;
	};
	const global = globalProfiles();

	if (scope === 'project') {
		const folder = store.list().find(entry => entry.profile.id === profile.id)?.folder ?? folderForNewProfile(profile);
		await store.update(folder, replaceIn);
		if (global.some(server => server.id === profile.id)) {
			await writeGlobal(global.filter(server => server.id !== profile.id));
		}
	} else {
		await writeGlobal(replaceIn(global));
		await removeFromProjects(store, profile.id);
	}
}

export async function removeServerProfile(id: string): Promise<void> {
	const store = requireStore();
	await loaded;
	await removeFromProjects(store, id);
	const global = globalProfiles();
	if (global.some(server => server.id === id)) {
		await writeGlobal(global.filter(server => server.id !== id));
	}
}

/**
 * Resolves the profile whose `localPath` is the longest matching ancestor of the given file.
 * Pure so it can be unit tested without a configuration host.
 */
export function resolveServerForLocalPathIn(
	servers: readonly ServerProfile[],
	fsPath: string
): LocalPathResolution | undefined {
	const target = normalizeLocal(fsPath);

	let best: ServerProfile | undefined;
	let bestRoot = '';

	for (const server of servers) {
		if (!server.localPath) {
			continue;
		}
		const root = normalizeLocal(server.localPath);
		if (!isSameOrInside(root, target)) {
			continue;
		}
		// Compare the normalized roots against each other so a trailing separator in one profile
		// cannot make it look longer (and therefore more specific) than it really is.
		if (!best || root.length > bestRoot.length) {
			best = server;
			bestRoot = root;
		}
	}

	if (!best) {
		return undefined;
	}

	const relativePath = target.slice(bestRoot.length).replace(/\\/g, '/').replace(/^\/+/, '');
	const remotePath = relativePath ? joinRemote(best.remoteRoot, relativePath) : normalizeRemote(best.remoteRoot);
	return { server: best, remotePath, relativePath };
}

export function resolveServerForLocalPath(fsPath: string): LocalPathResolution | undefined {
	return resolveServerForLocalPathIn(getServerProfiles(), fsPath);
}

/**
 * Patterns new profiles start with. Besides VCS and dependency folders, they keep secrets and editor
 * config off the server: auto-upload of a local `.env` is a classic way to overwrite production
 * settings, and `.vscode/remote-hosts.json` holds this extension's project-scoped server details.
 */
export const DEFAULT_IGNORE_GLOBS: readonly string[] = [
	'**/.git/**',
	'**/node_modules/**',
	'**/.vscode/**',
	'**/.env',
	'**/.env.*',
	'**/.ssh/**',
	'**/*.pem',
	'**/*.key',
];

/**
 * True when the profile's ignore patterns exclude a path relative to the mapping root. A profile with no
 * `ignoreGlobs` at all (e.g. hand-written in settings) gets the defaults; an explicit `[]` ignores nothing.
 */
export function isIgnored(server: ServerProfile, relativePosixPath: string): boolean {
	return matchesAnyGlob(relativePosixPath, server.ignoreGlobs ?? DEFAULT_IGNORE_GLOBS);
}
