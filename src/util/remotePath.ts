import * as path from 'path';

/** Collapses duplicate separators and resolves `.`/`..` segments in a POSIX remote path. */
export function normalizeRemote(remotePath: string): string {
	const isAbsolute = remotePath.startsWith('/');
	const resolved = path.posix.normalize(remotePath).replace(/\/+$/, '');
	if (isAbsolute) {
		return resolved === '' ? '/' : resolved;
	}
	return resolved === '.' ? '' : resolved;
}

/** Joins remote path segments, tolerating leading/trailing separators on any of them. */
export function joinRemote(...segments: string[]): string {
	const [first, ...rest] = segments;
	const joined = path.posix.join(first ?? '', ...rest.map(segment => segment.replace(/^\/+/, '')));
	return normalizeRemote(joined);
}

export function dirnameRemote(remotePath: string): string {
	return path.posix.dirname(normalizeRemote(remotePath));
}

export function basenameRemote(remotePath: string): string {
	return path.posix.basename(normalizeRemote(remotePath));
}

/** True when `candidate` is `base` itself or lives somewhere beneath it. */
export function isSameOrInside(base: string, candidate: string): boolean {
	const normalizedBase = normalizeRemote(base);
	const normalizedCandidate = normalizeRemote(candidate);
	return normalizedCandidate === normalizedBase || normalizedCandidate.startsWith(normalizedBase.replace(/\/$/, '') + '/');
}

/**
 * Converts a server-supplied remote path into a relative local path that cannot escape its base
 * directory. Remote listings are untrusted input: a hostile or misbehaving server can return entries
 * named `..`, absolute paths, or Windows drive letters, any of which would otherwise let a write
 * land outside the cache directory.
 */
export function toSafeRelativePath(remotePath: string): string {
	const segments = remotePath
		.replace(/\\/g, '/')
		.split('/')
		.map(segment => segment.trim())
		.filter(segment => segment !== '' && segment !== '.' && segment !== '..')
		// Strip characters that are illegal in Windows path segments, plus anything that could be
		// read as a drive qualifier, so the same cache layout is valid on every platform.
		.map(segment => segment.replace(/[:*?"<>|]/g, '_'))
		.filter(Boolean);
	return segments.join(path.sep);
}
