import * as path from 'path';

/** macOS and Windows compare paths case-insensitively; Linux does not. */
const CASE_INSENSITIVE_PATHS = process.platform === 'win32' || process.platform === 'darwin';

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
