const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** A byte count for people: `512 B`, `1.4 MB`, `23 GB` (binary units, as file managers show them). */
export function formatBytes(bytes: number): string {
	let value = Math.max(0, bytes);
	let unit = 0;
	while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
		value /= 1024;
		unit += 1;
	}
	if (unit === 0) {
		return `${Math.round(value)} B`;
	}
	return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${BYTE_UNITS[unit]}`;
}

/** A duration for people, to the second below an hour: `45s`, `3m 05s`, `1h 20m`. */
export function formatDuration(seconds: number): string {
	const total = Math.max(0, Math.round(seconds));
	if (total < 60) {
		return `${total}s`;
	}
	const minutes = Math.floor(total / 60);
	if (minutes < 60) {
		return `${minutes}m ${String(total % 60).padStart(2, '0')}s`;
	}
	return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}
