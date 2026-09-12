import type * as vscode from 'vscode';

/** Version 0.1.0 stored its state under the `remoteHostViewer` prefix. */
export const LEGACY_STATE_KEYS: ReadonlyArray<readonly [legacy: string, current: string]> = [
	['remoteHostViewer.knownHostKeys', 'remoteHostExplorer.knownHostKeys'],
	['remoteHostViewer.trackedRemoteFiles', 'remoteHostExplorer.trackedRemoteFiles'],
];

/**
 * Moves remembered host keys and tracked remote files to their current keys. A value already stored under
 * the current key is kept. Passwords are moved lazily by `SecretsManager`, since secrets can't be listed.
 */
export async function migrateLegacyState(state: vscode.Memento): Promise<void> {
	for (const [legacy, current] of LEGACY_STATE_KEYS) {
		const value = state.get(legacy);
		if (value === undefined) {
			continue;
		}
		if (state.get(current) === undefined) {
			await state.update(current, value);
		}
		await state.update(legacy, undefined);
	}
}
