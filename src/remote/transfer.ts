import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { isIgnored, type ServerProfile } from '../config/serverConfig';
import type { ConnectionManager } from './ConnectionManager';
import type { RemoteClient } from './RemoteClient';
import { rsyncUpload } from './rsyncUpload';
import { joinRemote, toSafeRelativePath } from '../util/remotePath';

export interface TransferSummary {
	transferred: number;
	/** Items excluded by ignore patterns or unusable names. */
	skipped: number;
	/** Existing local files the user chose not to overwrite during a download. */
	keptLocal: number;
}

export type LocalOverwriteDecision = 'overwrite' | 'overwrite-all' | 'skip' | 'skip-all' | 'cancel';

export interface TransferRun {
	progress: vscode.Progress<{ message?: string; increment?: number }>;
	token: vscode.CancellationToken;
	summary: TransferSummary;
	/** Remembered answer for existing local files; starts as `ask` and becomes sticky after an "All" choice. */
	localConflicts: 'ask' | 'overwrite' | 'skip';
	/** Asks about one existing local file. Injectable so tests don't need a real dialog. */
	confirmLocalOverwrite: (label: string) => Promise<LocalOverwriteDecision>;
}

export async function promptLocalOverwrite(label: string): Promise<LocalOverwriteDecision> {
	const choice = await vscode.window.showWarningMessage(
		`"${label}" already exists on your computer.`,
		{
			modal: true,
			detail: 'Downloading replaces your local copy with the version from the server. Any local changes to it will be lost.',
		},
		'Overwrite',
		'Overwrite All',
		'Skip',
		'Skip All'
	);
	switch (choice) {
		case 'Overwrite':
			return 'overwrite';
		case 'Overwrite All':
			return 'overwrite-all';
		case 'Skip':
			return 'skip';
		case 'Skip All':
			return 'skip-all';
		default:
			return 'cancel';
	}
}

/**
 * Decides whether a download may write `localPath`. Downloads used to overwrite local files silently,
 * which could destroy uncommitted work; an existing file now needs the user's consent.
 */
export async function mayWriteLocalFile(run: TransferRun, localPath: string, label: string): Promise<boolean> {
	const exists = await fs.promises.access(localPath).then(
		() => true,
		() => false
	);
	if (!exists || run.localConflicts === 'overwrite') {
		return true;
	}
	if (run.localConflicts === 'skip') {
		return false;
	}

	switch (await run.confirmLocalOverwrite(label)) {
		case 'overwrite':
			return true;
		case 'overwrite-all':
			run.localConflicts = 'overwrite';
			return true;
		case 'skip':
			return false;
		case 'skip-all':
			run.localConflicts = 'skip';
			return false;
		default:
			throw new CancelledError();
	}
}

/** Throw from inside a transfer to stop it quietly; `withTransferProgress` reports it as a cancellation. */
export class CancelledError extends Error {
	constructor() {
		super('Transfer cancelled.');
	}
}

function throwIfCancelled(token: vscode.CancellationToken): void {
	if (token.isCancellationRequested) {
		throw new CancelledError();
	}
}

/**
 * Runs a transfer inside a cancellable progress notification. Without this, a recursive transfer of a
 * large tree looks identical to a frozen extension and cannot be stopped.
 */
export async function withTransferProgress(
	title: string,
	run: (run: TransferRun) => Promise<void>
): Promise<TransferSummary | undefined> {
	const summary: TransferSummary = { transferred: 0, skipped: 0, keptLocal: 0 };
	try {
		await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title, cancellable: true },
			async (progress, token) =>
				run({ progress, token, summary, localConflicts: 'ask', confirmLocalOverwrite: promptLocalOverwrite })
		);
		return summary;
	} catch (err) {
		if (err instanceof CancelledError) {
			return undefined;
		}
		throw err;
	}
}

/**
 * Path used to match ignore globs. Patterns are documented as relative to the profile's `localPath`,
 * so they must be evaluated against that root even when the transfer started deeper in the tree.
 */
function ignorePathFor(server: ServerProfile, fallbackRoot: string, childPath: string): string {
	const root = server.localPath ?? fallbackRoot;
	return path.relative(root, childPath).replace(/\\/g, '/');
}

/** Label shown in the progress notification, relative to whatever the user asked to transfer. */
function progressLabel(rootPath: string, childPath: string): string {
	return path.relative(rootPath, childPath).replace(/\\/g, '/') || path.basename(childPath);
}

export async function uploadPath(
	server: ServerProfile,
	connections: ConnectionManager,
	outputChannel: vscode.OutputChannel,
	localPath: string,
	remotePath: string,
	run: TransferRun
): Promise<void> {
	const stats = await fs.promises.stat(localPath);

	if (server.protocol === 'sftp' && server.useRsyncForUpload) {
		run.progress.report({ message: `rsync ${path.basename(localPath)}` });
		if (!stats.isDirectory()) {
			await rsyncUpload(server, { localPath, remotePath, isDirectory: false }, outputChannel, run.token);
			run.summary.transferred += 1;
			return;
		}

		// Handing rsync the whole folder would upload files the ignore patterns exclude (e.g. `.env`).
		const { files, ignored } = await collectUploadFiles(server, localPath);
		run.summary.skipped += ignored;
		if (files.length === 0) {
			return;
		}
		const listFile = path.join(os.tmpdir(), `remote-host-explorer-rsync-${crypto.randomUUID()}.txt`);
		await fs.promises.writeFile(listFile, files.join('\n') + '\n');
		try {
			await rsyncUpload(
				server,
				{ localPath, remotePath, isDirectory: true, filesFrom: listFile },
				outputChannel,
				run.token
			);
		} finally {
			await fs.promises.rm(listFile, { force: true });
		}
		run.summary.transferred += files.length;
		return;
	}

	const client = await connections.getClient(server);
	if (stats.isDirectory()) {
		await uploadDirectory(server, client, localPath, localPath, remotePath, run);
	} else {
		run.progress.report({ message: path.basename(localPath) });
		await client.put(localPath, remotePath);
		run.summary.transferred += 1;
	}
}

/**
 * Every file under `rootLocalPath` that the profile's ignore patterns allow, as POSIX paths relative to
 * that root. Ignored folders are not descended into.
 */
export async function collectUploadFiles(
	server: ServerProfile,
	rootLocalPath: string
): Promise<{ files: string[]; ignored: number }> {
	const files: string[] = [];
	let ignored = 0;

	const walk = async (directory: string): Promise<void> => {
		for (const item of await fs.promises.readdir(directory, { withFileTypes: true })) {
			const childPath = path.join(directory, item.name);
			if (isIgnored(server, ignorePathFor(server, rootLocalPath, childPath))) {
				ignored += 1;
				continue;
			}
			if (item.isDirectory()) {
				await walk(childPath);
			} else {
				files.push(path.relative(rootLocalPath, childPath).replace(/\\/g, '/'));
			}
		}
	};

	await walk(rootLocalPath);
	return { files, ignored };
}

async function uploadDirectory(
	server: ServerProfile,
	client: RemoteClient,
	rootLocalPath: string,
	localDirPath: string,
	remoteDirPath: string,
	run: TransferRun
): Promise<void> {
	throwIfCancelled(run.token);
	await client.mkdir(remoteDirPath);

	const items = await fs.promises.readdir(localDirPath, { withFileTypes: true });
	for (const item of items) {
		throwIfCancelled(run.token);

		const childLocalPath = path.join(localDirPath, item.name);
		const childRemotePath = joinRemote(remoteDirPath, item.name);

		if (isIgnored(server, ignorePathFor(server, rootLocalPath, childLocalPath))) {
			run.summary.skipped += 1;
			continue;
		}

		if (item.isDirectory()) {
			await uploadDirectory(server, client, rootLocalPath, childLocalPath, childRemotePath, run);
		} else {
			run.progress.report({ message: progressLabel(rootLocalPath, childLocalPath) });
			await client.put(childLocalPath, childRemotePath);
			run.summary.transferred += 1;
		}
	}
}

export async function downloadPath(
	server: ServerProfile,
	client: RemoteClient,
	remotePath: string,
	localPath: string,
	isDirectory: boolean,
	run: TransferRun
): Promise<void> {
	if (isDirectory) {
		await downloadDirectory(server, client, localPath, remotePath, localPath, run);
		return;
	}
	if (!(await mayWriteLocalFile(run, localPath, path.basename(localPath)))) {
		run.summary.keptLocal += 1;
		return;
	}
	run.progress.report({ message: path.basename(localPath) });
	await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
	await client.get(remotePath, localPath);
	run.summary.transferred += 1;
}

async function downloadDirectory(
	server: ServerProfile,
	client: RemoteClient,
	rootLocalPath: string,
	remoteDirPath: string,
	localDirPath: string,
	run: TransferRun
): Promise<void> {
	throwIfCancelled(run.token);
	await fs.promises.mkdir(localDirPath, { recursive: true });

	const entries = await client.list(remoteDirPath);
	for (const entry of entries) {
		throwIfCancelled(run.token);

		// Entry names come from the server and are never trusted as path components.
		const safeName = toSafeRelativePath(entry.name);
		if (!safeName) {
			run.summary.skipped += 1;
			continue;
		}

		const childLocalPath = path.join(localDirPath, safeName);

		if (isIgnored(server, ignorePathFor(server, rootLocalPath, childLocalPath))) {
			run.summary.skipped += 1;
			continue;
		}

		if (entry.isDirectory) {
			await downloadDirectory(server, client, rootLocalPath, entry.path, childLocalPath, run);
		} else {
			const label = progressLabel(rootLocalPath, childLocalPath);
			if (!(await mayWriteLocalFile(run, childLocalPath, label))) {
				run.summary.keptLocal += 1;
				continue;
			}
			run.progress.report({ message: label });
			await client.get(entry.path, childLocalPath);
			run.summary.transferred += 1;
		}
	}
}

/** Recursively copies a remote file or directory to another remote path on the same server. */
export async function copyRemoteTree(
	client: RemoteClient,
	fromPath: string,
	toPath: string,
	isDirectory: boolean,
	run: TransferRun
): Promise<void> {
	throwIfCancelled(run.token);

	if (!isDirectory) {
		run.progress.report({ message: fromPath });
		await client.copy(fromPath, toPath);
		run.summary.transferred += 1;
		return;
	}

	await client.mkdir(toPath);
	const entries = await client.list(fromPath);
	for (const entry of entries) {
		throwIfCancelled(run.token);
		await copyRemoteTree(client, entry.path, joinRemote(toPath, entry.name), entry.isDirectory, run);
	}
}
