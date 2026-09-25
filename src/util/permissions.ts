/** `rwxr-xr-x` for the permission bits of a mode (setuid/setgid/sticky are shown by the octal form only). */
export function formatPermissions(mode: number): string {
	const letters = 'rwxrwxrwx';
	return [...letters].map((letter, index) => (mode & (0o400 >> index) ? letter : '-')).join('');
}

/** `644`, or `4755` when special bits are set. */
export function formatOctal(mode: number): string {
	return (mode & 0o7777).toString(8).padStart(3, '0');
}

/** Mode from a `user`/`group`/`other` triple of `rwx` strings, as SFTP listings report it. */
export function modeFromRights(rights: { user: string; group: string; other: string }): number {
	const bits = (value: string) => (value.includes('r') ? 4 : 0) | (value.includes('w') ? 2 : 0) | (value.includes('x') ? 1 : 0);
	return (bits(rights.user) << 6) | (bits(rights.group) << 3) | bits(rights.other);
}

/**
 * Reads what the user typed: three or four octal digits (`644`, `0755`, `2775`) or nine `rwx-` letters
 * (`rw-r--r--`). `undefined` when it is neither. Pure so it can be unit tested.
 */
export function parseModeInput(value: string): number | undefined {
	const text = value.trim();
	if (/^[0-7]{3,4}$/.test(text)) {
		return parseInt(text, 8);
	}
	if (/^[r-][w-][x-][r-][w-][x-][r-][w-][x-]$/.test(text)) {
		return modeFromRights({ user: text.slice(0, 3), group: text.slice(3, 6), other: text.slice(6, 9) });
	}
	return undefined;
}
