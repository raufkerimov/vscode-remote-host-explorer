import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { isIgnored, mappingRootForLocalPath, type ServerProfile } from '../config/serverConfig';
import type { ConnectionManager } from './ConnectionManager';
import type { RemoteClient, RemoteFileEntry } from './RemoteClient';
import { rsyncUpload } from './rsyncUpload';
import { transferLog, type TransferEntry, type TransferEntryStatus } from './transferLog';
import { changedOnServerSince, knownFileStates, type KnownFileStates } from './remoteState';
import { joinRemote, toSafeRelativePath } from '../util/remotePath';

export interface TransferSummary {
	transferred: number;
	/** Items excluded by ignore patterns or unusable names. */
	skipped: number;
	/** Existing local files the user chose not to overwrite during a download. */
	keptLocal: number;
	/** Server files changed since the last transfer that the user chose not to overwrite during an upload. */
	keptRemote?: number;
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
	/** Records one file in the Transfers view; absent in tests. */
	log?: (entry: TransferEntry) => void;
	/**
	 * States recorded after earlier transfers. With `confirmRemoteOverwrite`, uploads ask before replacing a
	 * server file that changed since; both are absent in tests that don't exercise that.
	 */
	knownFiles?: KnownFileStates;
	/** Remembered answer for server files that changed; like `localConflicts`. */
	remoteConflicts?: 'ask' | 'overwrite' | 'skip';
	confirmRemoteOverwrite?: (label: string, server: ServerProfile) => Promise<LocalOverwriteDecision>;
}

/** How a remote path appears in the Transfers view. */
export function remoteLabel(server: ServerProfile, remotePath: string): string {
	return `${server.name}:${remotePath}`;
}

function logUpload(run: TransferRun, server: ServerProfile, localPath: string, remotePath: string, status: TransferEntryStatus, error?: string): void {
	run.log?.({ from: localPath, to: remoteLabel(server, remotePath), status, localPath, error });
}

function logDownload(run: TransferRun, server: ServerProfile, remotePath: string, localPath: string, status: TransferEntryStatus, error?: string): void {
	run.log?.({ from: remoteLabel(server, remotePath), to: localPath, status, localPath, error });
}

export function promptLocalOverwrite(label: string): Promise<LocalOverwriteDecision> {
	return promptOverwrite(
		`"${label}" already exists on your computer.`,
		'Downloading replaces your local copy with the version from the server. Any local changes to it will be lost.'
	);
}

export function promptRemoteOverwrite(label: string, server: ServerProfile): Promise<LocalOverwriteDecision> {
	return promptOverwrite(
		`"${label}" changed on ${server.name} since you last uploaded or downloaded it.`,
		'Someone may have edited it on the server. Uploading replaces that newer copy with yours.'
	);
}

async function promptOverwrite(message: string, detail: string): Promise<LocalOverwriteDecision> {
	const choice = await vscode.window.showWarningMessage(
		message,
		{ modal: true, detail },
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

/**
 * Decides whether an upload may replace the server's copy. Only a file that changed on the server since
 * this extension last transferred it needs consent; the answer can apply to the rest of the run.
 */
export async function mayOverwriteRemoteFile(
	run: TransferRun,
	server: ServerProfile,
	remotePath: string,
	current: RemoteFileEntry | undefined,
	label: string
): Promise<boolean> {
	if (!current || current.isDirectory || !run.knownFiles || !run.confirmRemoteOverwrite || run.remoteConflicts === 'overwrite') {
		return true;
	}
	if (!changedOnServerSince(run.knownFiles.get(server.id, remotePath), current, server.protocol)) {
		return true;
	}
	if (run.remoteConflicts === 'skip') {
		return false;
	}
	switch (await run.confirmRemoteOverwrite(label, server)) {
		case 'overwrite':
			return true;
		case 'overwrite-all':
			run.remoteConflicts = 'overwrite';
			return true;
		case 'skip':
			return false;
		case 'skip-all':
			run.remoteConflicts = 'skip';
			return false;
		default:
			throw new CancelledError();
	}
}

/** Whether uploads in this run check the server copy first, which costs a listing per folder. */
function checksRemoteChanges(run: TransferRun): boolean {
	return Boolean(run.knownFiles && run.confirmRemoteOverwrite && run.remoteConflicts !== 'overwrite');
}

/** Records both copies' state after a transfer. Never fails the transfer: the record is only a hint. */
async function recordTransfer(
	run: TransferRun,
	server: ServerProfile,
	client: RemoteClient,
	remotePath: string,
	localPath: string,
	remote?: RemoteFileEntry
): Promise<void> {
	if (!run.knownFiles) {
		return;
	}
	try {
		const [remoteState, localState] = await Promise.all([
			remote ?? client.stat(remotePath),
			fs.promises.stat(localPath),
		]);
		if (remoteState) {
			run.knownFiles.set(server.id, remotePath, {
				remoteModifiedAt: remoteState.modifiedAt,
				localModifiedAt: localState.mtimeMs,
				size: remoteState.size,
			});
		}
	} catch {
		// Without a record the next upload simply doesn't check; nothing else depends on it.
	}
}

/**
 * Records the files a folder upload sent, reading each server folder once. A `stat` per file would cost
 * a folder listing per file over FTP, which has no stat for arbitrary paths.
 */
async function recordFolderUpload(run: TransferRun, server: ServerProfile, client: RemoteClient, sent: readonly PlannedFile[]): Promise<void> {
	if (!run.knownFiles || sent.length === 0) {
		return;
	}
	const byFolder = new Map<string, PlannedFile[]>();
	for (const file of sent) {
		const folder = path.posix.dirname(file.to);
		byFolder.set(folder, [...(byFolder.get(folder) ?? []), file]);
	}
	for (const [folder, files] of byFolder) {
		const listing = new Map((await client.list(folder).catch(() => [])).map(entry => [entry.path, entry]));
		for (const file of files) {
			const entry = listing.get(file.to);
			if (entry) {
				await recordTransfer(run, server, client, file.to, file.from, entry);
			}
		}
	}
}

function keepRemote(run: TransferRun, server: ServerProfile, localPath: string, remotePath: string): void {
	logUpload(run, server, localPath, remotePath, 'skipped');
	run.summary.keptRemote = (run.summary.keptRemote ?? 0) + 1;
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
 * Files sent at once within one folder transfer. SFTP multiplexes requests over its single connection, so
 * several files can move in parallel; an FTP control connection runs one command at a time.
 */
export const SFTP_PARALLEL_TRANSFERS = 4;

function parallelTransfersFor(server: ServerProfile): number {
	return server.protocol === 'sftp' ? SFTP_PARALLEL_TRANSFERS : 1;
}

/**
 * Runs `worker` over `items` with at most `limit` running at once. After cancellation or the first failure
 * no new item starts; the running ones settle, then the first error (or `CancelledError`) is thrown.
 */
export async function runWithLimit<T>(
	items: readonly T[],
	limit: number,
	token: vscode.CancellationToken,
	worker: (item: T) => Promise<void>
): Promise<void> {
	let next = 0;
	const failures: unknown[] = [];
	const lane = async (): Promise<void> => {
		while (failures.length === 0 && next < items.length) {
			if (token.isCancellationRequested) {
				failures.push(new CancelledError());
				return;
			}
			const item = items[next++];
			try {
				await worker(item);
			} catch (err) {
				failures.push(err);
			}
		}
	};
	const lanes = Math.max(1, Math.min(limit, items.length));
	await Promise.all(Array.from({ length: lanes }, lane));
	if (failures.length > 0) {
		throw failures[0];
	}
}

/** One file of a folder transfer, decided during planning so the transfer itself needs no prompts. */
interface PlannedFile {
	from: string;
	to: string;
	label: string;
	/** Downloads: the listing entry, recorded as the server's state once the file is fetched. */
	remote?: RemoteFileEntry;
}

async function transferPlannedFiles(
	server: ServerProfile,
	run: TransferRun,
	direction: 'upload' | 'download',
	files: readonly PlannedFile[],
	transfer: (file: PlannedFile) => Promise<void>
): Promise<void> {
	const log = direction === 'upload' ? logUpload : logDownload;
	const increment = files.length > 0 ? 100 / files.length : 0;
	await runWithLimit(files, parallelTransfersFor(server), run.token, async file => {
		run.progress.report({ message: file.label });
		try {
			await transfer(file);
		} catch (err) {
			log(run, server, file.from, file.to, 'failed', (err as Error).message);
			throw err;
		}
		log(run, server, file.from, file.to, 'done');
		run.summary.transferred += 1;
		run.progress.report({ increment });
	});
}

/**
 * Runs a transfer inside a cancellable progress notification. Without this, a recursive transfer of a
 * large tree looks identical to a frozen extension and cannot be stopped.
 */
export async function withTransferProgress(
	title: string,
	run: (run: TransferRun) => Promise<void>
): Promise<TransferSummary | undefined> {
	const summary: TransferSummary = { transferred: 0, skipped: 0, keptLocal: 0, keptRemote: 0 };
	const record = transferLog.start(title);
	try {
		await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title, cancellable: true },
			async (progress, token) =>
				run({
					progress,
					token,
					summary,
					localConflicts: 'ask',
					confirmLocalOverwrite: promptLocalOverwrite,
					log: entry => transferLog.add(record, entry),
					knownFiles: knownFileStates,
					remoteConflicts: 'ask',
					confirmRemoteOverwrite: promptRemoteOverwrite,
				})
		);
		transferLog.finish(record, 'done');
		return summary;
	} catch (err) {
		if (err instanceof CancelledError) {
			transferLog.finish(record, 'cancelled');
			return undefined;
		}
		transferLog.finish(record, 'failed', (err as Error).message);
		throw err;
	}
}

/**
 * Path used to match ignore globs. Patterns are documented as relative to the mapping's local folder, so
 * they are evaluated against that folder even when the transfer started deeper in the tree. Outside every
 * mapping (a download into any folder) they are relative to what the user asked to transfer.
 */
function ignorePathFor(server: ServerProfile, fallbackRoot: string, childPath: string): string {
	const root = mappingRootForLocalPath(server, childPath) ?? fallbackRoot;
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
			const client = checksRemoteChanges(run) || run.knownFiles ? await connections.getClient(server) : undefined;
			if (client && checksRemoteChanges(run)) {
				const current = await client.stat(remotePath);
				if (!(await mayOverwriteRemoteFile(run, server, remotePath, current, path.basename(localPath)))) {
					keepRemote(run, server, localPath, remotePath);
					return;
				}
			}
			await rsyncUpload(server, { localPath, remotePath, isDirectory: false }, outputChannel, run.token);
			logUpload(run, server, localPath, remotePath, 'done');
			run.summary.transferred += 1;
			if (client) {
				await recordTransfer(run, server, client, remotePath, localPath);
			}
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
		for (const file of files) {
			logUpload(run, server, path.join(localPath, ...file.split('/')), joinRemote(remotePath, file), 'done');
		}
		run.summary.transferred += files.length;
		return;
	}

	const client = await connections.getClient(server);
	if (stats.isDirectory()) {
		const files: PlannedFile[] = [];
		await planUploadDirectory(server, client, localPath, localPath, remotePath, run, files);
		const sent: PlannedFile[] = [];
		try {
			await transferPlannedFiles(server, run, 'upload', files, async file => {
				await client.put(file.from, file.to);
				sent.push(file);
			});
		} finally {
			await recordFolderUpload(run, server, client, sent);
		}
	} else {
		if (checksRemoteChanges(run)) {
			const current = await client.stat(remotePath);
			if (!(await mayOverwriteRemoteFile(run, server, remotePath, current, path.basename(localPath)))) {
				keepRemote(run, server, localPath, remotePath);
				return;
			}
		}
		run.progress.report({ message: path.basename(localPath) });
		try {
			await client.put(localPath, remotePath);
		} catch (err) {
			logUpload(run, server, localPath, remotePath, 'failed', (err as Error).message);
			throw err;
		}
		logUpload(run, server, localPath, remotePath, 'done');
		run.summary.transferred += 1;
		await recordTransfer(run, server, client, remotePath, localPath);
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

/** Creates the remote folders (parents first) and lists the files to send, applying ignore patterns. */
async function planUploadDirectory(
	server: ServerProfile,
	client: RemoteClient,
	rootLocalPath: string,
	localDirPath: string,
	remoteDirPath: string,
	run: TransferRun,
	files: PlannedFile[]
): Promise<void> {
	throwIfCancelled(run.token);
	await client.mkdir(remoteDirPath);
	// One listing per folder answers "did this file change on the server?" for all of its files.
	const existing = checksRemoteChanges(run)
		? new Map((await client.list(remoteDirPath).catch(() => [])).map(entry => [entry.name, entry]))
		: new Map<string, RemoteFileEntry>();

	const items = await fs.promises.readdir(localDirPath, { withFileTypes: true });
	for (const item of items) {
		throwIfCancelled(run.token);

		const childLocalPath = path.join(localDirPath, item.name);
		const childRemotePath = joinRemote(remoteDirPath, item.name);

		if (isIgnored(server, ignorePathFor(server, rootLocalPath, childLocalPath))) {
			logUpload(run, server, childLocalPath, childRemotePath, 'ignored');
			run.summary.skipped += 1;
			continue;
		}

		if (item.isDirectory()) {
			await planUploadDirectory(server, client, rootLocalPath, childLocalPath, childRemotePath, run, files);
		} else {
			const label = progressLabel(rootLocalPath, childLocalPath);
			if (!(await mayOverwriteRemoteFile(run, server, childRemotePath, existing.get(item.name), label))) {
				keepRemote(run, server, childLocalPath, childRemotePath);
				continue;
			}
			files.push({ from: childLocalPath, to: childRemotePath, label });
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
		const files: PlannedFile[] = [];
		await planDownloadDirectory(server, client, localPath, remotePath, localPath, run, files);
		await transferPlannedFiles(server, run, 'download', files, async file => {
			await client.get(file.from, file.to);
			await recordTransfer(run, server, client, file.from, file.to, file.remote);
		});
		return;
	}
	if (!(await mayWriteLocalFile(run, localPath, path.basename(localPath)))) {
		logDownload(run, server, remotePath, localPath, 'kept');
		run.summary.keptLocal += 1;
		return;
	}
	run.progress.report({ message: path.basename(localPath) });
	await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
	try {
		await client.get(remotePath, localPath);
	} catch (err) {
		logDownload(run, server, remotePath, localPath, 'failed', (err as Error).message);
		throw err;
	}
	logDownload(run, server, remotePath, localPath, 'done');
	run.summary.transferred += 1;
	await recordTransfer(run, server, client, remotePath, localPath);
}

/**
 * Creates the local folders and lists the files to fetch. Every question about an existing local file is
 * asked here, one at a time, before any file is transferred.
 */
async function planDownloadDirectory(
	server: ServerProfile,
	client: RemoteClient,
	rootLocalPath: string,
	remoteDirPath: string,
	localDirPath: string,
	run: TransferRun,
	files: PlannedFile[]
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
			logDownload(run, server, entry.path, childLocalPath, 'ignored');
			run.summary.skipped += 1;
			continue;
		}

		if (entry.isDirectory) {
			await planDownloadDirectory(server, client, rootLocalPath, entry.path, childLocalPath, run, files);
		} else {
			const label = progressLabel(rootLocalPath, childLocalPath);
			if (!(await mayWriteLocalFile(run, childLocalPath, label))) {
				logDownload(run, server, entry.path, childLocalPath, 'kept');
				run.summary.keptLocal += 1;
				continue;
			}
			files.push({ from: entry.path, to: childLocalPath, label, remote: entry });
		}
	}
}

/** Recursively copies a remote file or directory to another remote path on the same server. */
export async function copyRemoteTree(
	server: ServerProfile,
	client: RemoteClient,
	fromPath: string,
	toPath: string,
	isDirectory: boolean,
	run: TransferRun
): Promise<void> {
	throwIfCancelled(run.token);

	if (!isDirectory) {
		run.progress.report({ message: fromPath });
		try {
			await client.copy(fromPath, toPath);
		} catch (err) {
			run.log?.({ from: remoteLabel(server, fromPath), to: remoteLabel(server, toPath), status: 'failed', error: (err as Error).message });
			throw err;
		}
		run.log?.({ from: remoteLabel(server, fromPath), to: remoteLabel(server, toPath), status: 'done' });
		run.summary.transferred += 1;
		return;
	}

	await client.mkdir(toPath);
	const entries = await client.list(fromPath);
	for (const entry of entries) {
		throwIfCancelled(run.token);
		await copyRemoteTree(server, client, entry.path, joinRemote(toPath, entry.name), entry.isDirectory, run);
	}
}
