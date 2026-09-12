/**
 * Minimal glob matcher covering the subset of patterns used by `ignoreGlobs`: `**`, `*`, and `?`.
 * Written by hand rather than pulled in as a dependency so the bundled extension stays dependency-light;
 * the supported syntax is documented in the configuration schema.
 */

function escapeLiteral(character: string): string {
	return character.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

function globToRegExpSource(glob: string): string {
	// A trailing `/**` should also match the directory itself, so `**/.git/**` ignores `.git` as well
	// as everything under it.
	const pattern = glob.replace(/\/\*\*$/, '{{TRAILING_DOUBLESTAR}}');

	let source = '';
	for (let index = 0; index < pattern.length; index++) {
		if (pattern.startsWith('{{TRAILING_DOUBLESTAR}}', index)) {
			source += '(?:/.*)?';
			index += '{{TRAILING_DOUBLESTAR}}'.length - 1;
			continue;
		}

		const character = pattern[index];
		if (character === '*') {
			if (pattern[index + 1] === '*') {
				if (pattern[index + 2] === '/') {
					// `**/` spans zero or more complete path segments.
					source += '(?:[^/]*/)*';
					index += 2;
				} else {
					source += '.*';
					index += 1;
				}
			} else {
				source += '[^/]*';
			}
		} else if (character === '?') {
			source += '[^/]';
		} else {
			source += escapeLiteral(character);
		}
	}
	return source;
}

export function globToRegExp(glob: string): RegExp {
	return new RegExp(`^${globToRegExpSource(glob.trim())}$`);
}

/**
 * Matches a POSIX-style path that is relative to the mapping root against a set of globs.
 * Returns false for an empty pattern list so an unconfigured profile ignores nothing.
 */
export function matchesAnyGlob(relativePosixPath: string, globs: readonly string[] | undefined): boolean {
	if (!globs || globs.length === 0) {
		return false;
	}
	const subject = relativePosixPath.replace(/^\/+/, '');
	return globs.some(glob => {
		const trimmed = glob.trim();
		if (!trimmed) {
			return false;
		}
		try {
			return globToRegExp(trimmed).test(subject);
		} catch {
			// A malformed user-supplied pattern must never break a transfer.
			return false;
		}
	});
}
