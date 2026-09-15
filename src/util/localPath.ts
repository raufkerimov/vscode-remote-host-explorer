import * as os from 'os';
import * as path from 'path';

/** macOS and Windows compare paths case-insensitively; Linux does not. */
const CASE_INSENSITIVE_PATHS = process.platform === 'win32' || process.platform === 'darwin';

/**
 * Expands a leading `~` to the home folder, as a shell would. Profiles can then say `~/.ssh/id_rsa` and
 * work for everyone who shares the file, whatever their user name.
 */
export function expandHome(fsPath: string, home: string = os.homedir()): string {
	if (fsPath === '~') {
		return home;
	}
	return /^~[/\\]/.test(fsPath) ? path.join(home, fsPath.slice(2)) : fsPath;
}

/** Absolute path without a trailing separator. */
export function normalizeLocal(fsPath: string): string {
	return path.resolve(fsPath).replace(/[/\\]+$/, '');
}

/** Comparison key for a normalized path. */
export function pathKey(fsPath: string): string {
	return CASE_INSENSITIVE_PATHS ? fsPath.toLowerCase() : fsPath;
}

/** True when `target` is `root` itself or somewhere inside it. Both must already be normalized. */
export function isSameOrInside(root: string, target: string): boolean {
	const rootKey = pathKey(root);
	const targetKey = pathKey(target);
	return targetKey === rootKey || targetKey.startsWith(rootKey + '/') || targetKey.startsWith(rootKey + '\\');
}
