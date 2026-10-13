import * as vscode from 'vscode';
import { formatBytes, formatDuration } from '../util/format';

/**
 * What happened to one file: still moving, sent, left out by an ignore pattern, local copy kept
 * (download), server copy kept because it changed there (upload), or failed.
 */
export type TransferEntryStatus = 'running' | 'done' | 'ignored' | 'kept' | 'skipped' | 'failed';

export interface TransferEntry {
	/** Local paths as they are; remote ones as `server:/path`. */
	from: string;
	to: string;
	status: TransferEntryStatus;
	/** The local side of the transfer, so the Transfers view can open it. */
	localPath?: string;
	error?: string;
	/** The file's size when known; with `transferred`, how far a running file has got. */
	size?: number;
	transferred?: number;
}

export type TransferState = 'running' | 'done' | 'cancelled' | 'failed';

export interface TransferRecord {
	id: number;
	title: string;
	startedAt: Date;
	state: TransferState;
	entries: TransferEntry[];
	error?: string;
	/**
	 * Size of the files planned so far. A transfer of several items plans each one when it gets to it, so
	 * this can grow while the transfer runs. 0 when nothing reported a size (rsync).
	 */
	totalBytes: number;
	transferredBytes: number;
	/** Bytes per second over the last few seconds, while running. */
	speed?: number;
}

/** How far back the speed looks: long enough to smooth out bursts, short enough to follow a change. */
const SPEED_WINDOW_MS = 5000;
/** Progress arrives per chunk; samples closer together than this add nothing to the speed. */
const SPEED_SAMPLE_MS = 250;

interface SpeedSample {
	at: number;
	bytes: number;
}

/** Older transfers are dropped beyond this, so a long session doesn't hold every file ever sent. */
export const MAX_TRANSFER_RECORDS = 100;

/** The transfers of this window, newest first, shown in the Transfers view. */
export class TransferLog {
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changed.event;
	private nextId = 1;
	private list: TransferRecord[] = [];
	private finished: TransferRecord | undefined;
	/** Entries shown by `begin` that haven't ended yet. */
	private readonly moving = new WeakSet<TransferEntry>();
	private readonly samples = new WeakMap<TransferRecord, SpeedSample[]>();

	get records(): readonly TransferRecord[] {
		return this.list;
	}

	/** The transfer that ended most recently — the one a completion notification is about. */
	get lastFinished(): TransferRecord | undefined {
		return this.finished && this.list.includes(this.finished) ? this.finished : undefined;
	}

	start(title: string): TransferRecord {
		const record: TransferRecord = {
			id: this.nextId++,
			title,
			startedAt: new Date(),
			state: 'running',
			entries: [],
			totalBytes: 0,
			transferredBytes: 0,
		};
		this.list = [record, ...this.list].slice(0, MAX_TRANSFER_RECORDS);
		this.changed.fire();
		return record;
	}

	/** Adds files about to be sent to the transfer's size; entries begun for them then carry their `size`. */
	expect(record: TransferRecord, bytes: number): void {
		record.totalBytes += bytes;
		this.changed.fire();
	}

	/** Shows a file while it moves; `advance` reports its bytes and `add` with the same entry ends it. */
	begin(record: TransferRecord, entry: TransferEntry): void {
		entry.transferred = 0;
		this.moving.add(entry);
		record.entries.push(entry);
		if (!this.samples.has(record)) {
			this.samples.set(record, [{ at: Date.now(), bytes: record.transferredBytes }]);
		}
		this.changed.fire();
	}

	/** Bytes of a begun file so far. `total` sizes a file nobody knew the size of beforehand. */
	advance(record: TransferRecord, entry: TransferEntry, transferred: number, total?: number): void {
		if (entry.size === undefined && total !== undefined) {
			entry.size = total;
			record.totalBytes += total;
		}
		const previous = entry.transferred ?? 0;
		if (transferred > previous) {
			entry.transferred = transferred;
			record.transferredBytes += transferred - previous;
			this.measureSpeed(record);
		}
		this.changed.fire();
	}

	/** Records a file's outcome; for a begun entry, updates it in place. */
	add(record: TransferRecord, entry: TransferEntry): void {
		if (this.moving.delete(entry)) {
			// The last progress report may come before the final bytes; a sent file counts in full.
			if (entry.status === 'done' && entry.size !== undefined && entry.size > (entry.transferred ?? 0)) {
				record.transferredBytes += entry.size - (entry.transferred ?? 0);
				entry.transferred = entry.size;
			}
		} else {
			record.entries.push(entry);
		}
		this.changed.fire();
	}

	finish(record: TransferRecord, state: Exclude<TransferState, 'running'>, error?: string): void {
		record.state = state;
		record.error = error;
		record.speed = undefined;
		this.samples.delete(record);
		this.finished = record;
		this.changed.fire();
	}

	private measureSpeed(record: TransferRecord): void {
		const samples = this.samples.get(record);
		const now = Date.now();
		if (!samples || now - samples[samples.length - 1].at < SPEED_SAMPLE_MS) {
			return;
		}
		samples.push({ at: now, bytes: record.transferredBytes });
		while (samples.length > 2 && samples[1].at <= now - SPEED_WINDOW_MS) {
			samples.shift();
		}
		const oldest = samples[0];
		record.speed = ((record.transferredBytes - oldest.bytes) * 1000) / (now - oldest.at);
	}

	clear(): void {
		// A running transfer keeps its record so its remaining files still have somewhere to go.
		this.list = this.list.filter(record => record.state === 'running');
		this.changed.fire();
	}
}

export const transferLog = new TransferLog();

/** A running transfer's progress, e.g. "45% · 1.2 MB/s · 1m 20s left"; empty before any bytes moved. */
export function describeProgress(record: TransferRecord): string {
	const parts: string[] = [];
	const known = record.totalBytes > 0;
	if (known) {
		parts.push(`${Math.floor(Math.min(1, record.transferredBytes / record.totalBytes) * 100)}%`);
	} else if (record.transferredBytes > 0) {
		parts.push(formatBytes(record.transferredBytes));
	}
	if (record.speed !== undefined) {
		parts.push(`${formatBytes(record.speed)}/s`);
		if (known && record.speed > 0 && record.totalBytes > record.transferredBytes) {
			parts.push(`${formatDuration((record.totalBytes - record.transferredBytes) / record.speed)} left`);
		}
	}
	return parts.join(' · ');
}

/** Opens the Transfers view with the last finished transfer expanded; registered in `extension.ts`. */
export const SHOW_TRANSFERS_COMMAND = 'remoteHostExplorer.showTransfers';

const SHOW_TRANSFERS = 'Show Transfers';

/** Shows a transfer's outcome with a button that opens the per-file list in the Transfers view. */
export async function notifyTransfer(message: string, severity: 'info' | 'warning' | 'error' = 'info'): Promise<void> {
	const show =
		severity === 'error'
			? vscode.window.showErrorMessage
			: severity === 'warning'
				? vscode.window.showWarningMessage
				: vscode.window.showInformationMessage;
	if ((await show(message, SHOW_TRANSFERS)) === SHOW_TRANSFERS) {
		await vscode.commands.executeCommand(SHOW_TRANSFERS_COMMAND);
	}
}
