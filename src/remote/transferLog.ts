import * as vscode from 'vscode';

/**
 * What happened to one file: sent, left out by an ignore pattern, local copy kept (download), server copy
 * kept because it changed there (upload), or failed.
 */
export type TransferEntryStatus = 'done' | 'ignored' | 'kept' | 'skipped' | 'failed';

export interface TransferEntry {
	/** Local paths as they are; remote ones as `server:/path`. */
	from: string;
	to: string;
	status: TransferEntryStatus;
	/** The local side of the transfer, so the Transfers view can open it. */
	localPath?: string;
	error?: string;
}

export type TransferState = 'running' | 'done' | 'cancelled' | 'failed';

export interface TransferRecord {
	id: number;
	title: string;
	startedAt: Date;
	state: TransferState;
	entries: TransferEntry[];
	error?: string;
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

	get records(): readonly TransferRecord[] {
		return this.list;
	}

	/** The transfer that ended most recently — the one a completion notification is about. */
	get lastFinished(): TransferRecord | undefined {
		return this.finished && this.list.includes(this.finished) ? this.finished : undefined;
	}

	start(title: string): TransferRecord {
		const record: TransferRecord = { id: this.nextId++, title, startedAt: new Date(), state: 'running', entries: [] };
		this.list = [record, ...this.list].slice(0, MAX_TRANSFER_RECORDS);
		this.changed.fire();
		return record;
	}

	add(record: TransferRecord, entry: TransferEntry): void {
		record.entries.push(entry);
		this.changed.fire();
	}

	finish(record: TransferRecord, state: Exclude<TransferState, 'running'>, error?: string): void {
		record.state = state;
		record.error = error;
		this.finished = record;
		this.changed.fire();
	}

	clear(): void {
		// A running transfer keeps its record so its remaining files still have somewhere to go.
		this.list = this.list.filter(record => record.state === 'running');
		this.changed.fire();
	}
}

export const transferLog = new TransferLog();

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
