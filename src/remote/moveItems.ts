import * as vscode from 'vscode';
import type { RemoteClient } from './RemoteClient';
import { basenameRemote, dirnameRemote, isSameOrInside, joinRemote, normalizeRemote } from '../util/remotePath';

export interface MoveSource {
	path: string;
	name: string;
	isDirectory: boolean;
}

/** `replace` overwrites, `skip` leaves this item alone, `cancel` stops the whole batch. */
export type ConflictDecision = 'replace' | 'skip' | 'cancel';

export interface MoveResult {
	moved: number;
	skipped: number;
	/** Directories whose listing changed: every source parent plus the target. */
	affectedDirectories: Set<string>;
}

export async function promptForConflict(
	name: string,
	targetDir: string,
	detail = 'Moving it here would replace the existing item.'
): Promise<ConflictDecision> {
	const choice = await vscode.window.showWarningMessage(
		`"${name}" already exists in ${targetDir}.`,
		{ modal: true, detail },
		'Replace',
		'Skip'
	);
	return choice === 'Replace' ? 'replace' : choice === 'Skip' ? 'skip' : 'cancel';
}

/**
 * Moves remote items into `targetDir` on one server. Shared by drag-and-drop and cut/paste so both apply
 * the same guards: no-op moves are skipped, a directory can't be moved into itself, and existing
 * destinations are only replaced after confirmation.
 */
export async function moveRemoteItems(
	client: RemoteClient,
	sources: readonly MoveSource[],
	targetDir: string,
	onMoved: (fromPath: string, toPath: string) => Promise<void>,
	resolveConflict: (name: string, targetDir: string) => Promise<ConflictDecision> = promptForConflict
): Promise<MoveResult> {
	const target = normalizeRemote(targetDir);
	const result: MoveResult = { moved: 0, skipped: 0, affectedDirectories: new Set([target]) };

	for (const source of sources) {
		const sourcePath = normalizeRemote(source.path);
		const destinationPath = joinRemote(target, basenameRemote(sourcePath));

		if (sourcePath === destinationPath) {
			result.skipped += 1;
			continue;
		}
		// Moving a directory into itself or one of its descendants would detach the subtree.
		if (source.isDirectory && isSameOrInside(sourcePath, target)) {
			vscode.window.showWarningMessage(`Cannot move "${source.name}" into itself.`);
			result.skipped += 1;
			continue;
		}

		if (await client.exists(destinationPath)) {
			const decision = await resolveConflict(basenameRemote(destinationPath), target);
			if (decision === 'cancel') {
				break;
			}
			if (decision === 'skip') {
				result.skipped += 1;
				continue;
			}
			await client.delete(destinationPath, source.isDirectory);
		}

		await client.rename(sourcePath, destinationPath);
		await onMoved(sourcePath, destinationPath);
		result.moved += 1;
		result.affectedDirectories.add(dirnameRemote(sourcePath));
	}

	return result;
}
