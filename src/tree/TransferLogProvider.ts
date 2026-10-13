import * as path from 'path';
import * as vscode from 'vscode';
import { describeProgress, type TransferEntry, type TransferLog, type TransferRecord } from '../remote/transferLog';
import { formatBytes } from '../util/format';

type TransferNode = TransferRecord | TransferEntry;

function isRecord(node: TransferNode): node is TransferRecord {
	return 'entries' in node;
}

/** How long updates are gathered before the view redraws; a folder transfer logs files in quick bursts. */
const REFRESH_DELAY_MS = 200;

const ENTRY_ICONS: Record<TransferEntry['status'], vscode.ThemeIcon> = {
	running: new vscode.ThemeIcon('loading~spin'),
	done: new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed')),
	ignored: new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('disabledForeground')),
	kept: new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('disabledForeground')),
	skipped: new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('disabledForeground')),
	failed: new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed')),
};

const ENTRY_NOTES: Record<TransferEntry['status'], string> = {
	running: '',
	done: '',
	ignored: 'ignored · ',
	kept: 'kept local copy · ',
	skipped: 'kept newer server copy · ',
	failed: 'failed · ',
};

/**
 * Summary shown next to a transfer: while running, e.g. "14:25:01 · 45% · 1.2 MB/s · 1m 20s left · 3
 * transferred"; once finished, e.g. "14:25:01 · 3 transferred, 1 ignored · 12 MB".
 */
export function describeRecord(record: TransferRecord): string {
	const counts = new Map<TransferEntry['status'], number>();
	for (const entry of record.entries) {
		counts.set(entry.status, (counts.get(entry.status) ?? 0) + 1);
	}
	const parts = [
		`${counts.get('done') ?? 0} transferred`,
		counts.get('ignored') ? `${counts.get('ignored')} ignored` : '',
		counts.get('kept') || counts.get('skipped') ? `${(counts.get('kept') ?? 0) + (counts.get('skipped') ?? 0)} kept` : '',
		counts.get('failed') ? `${counts.get('failed')} failed` : '',
	].filter(Boolean);
	const running = record.state === 'running';
	const state = running ? describeProgress(record) || 'running' : record.state === 'done' ? '' : record.state;
	const moved = !running && record.transferredBytes > 0 ? formatBytes(record.transferredBytes) : '';
	return [record.startedAt.toLocaleTimeString(), state, parts.join(', '), moved].filter(Boolean).join(' · ');
}

/** "45% · 1.2 MB of 2.7 MB · " for a file still moving; just the bytes when its size is unknown. */
function describeEntryProgress(entry: TransferEntry): string {
	if (entry.status !== 'running' || entry.transferred === undefined) {
		return '';
	}
	if (entry.size === undefined) {
		return `${formatBytes(entry.transferred)} · `;
	}
	const percent = entry.size > 0 ? Math.floor(Math.min(1, entry.transferred / entry.size) * 100) : 0;
	return `${percent}% · ${formatBytes(entry.transferred)} of ${formatBytes(entry.size)} · `;
}

/** The Transfers panel: one row per transfer, expanding to every file as `from → to`. */
export class TransferLogProvider implements vscode.TreeDataProvider<TransferNode>, vscode.Disposable {
	private readonly changed = new vscode.EventEmitter<undefined>();
	readonly onDidChangeTreeData = this.changed.event;
	private readonly subscription: vscode.Disposable;
	private timer: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly log: TransferLog) {
		this.subscription = log.onDidChange(() => {
			this.timer ??= setTimeout(() => {
				this.timer = undefined;
				this.changed.fire(undefined);
			}, REFRESH_DELAY_MS);
		});
	}

	getChildren(node?: TransferNode): TransferNode[] {
		if (!node) {
			return [...this.log.records];
		}
		return isRecord(node) ? node.entries : [];
	}

	/** Needed by `TreeView.reveal`: files belong to their transfer, transfers are top level. */
	getParent(node: TransferNode): TransferNode | undefined {
		return isRecord(node) ? undefined : this.log.records.find(record => record.entries.includes(node));
	}

	getTreeItem(node: TransferNode): vscode.TreeItem {
		if (isRecord(node)) {
			const item = new vscode.TreeItem(
				node.title,
				// Always expandable: a transfer starts with no files, and a row created as a leaf may not
				// become expandable when its files arrive.
				vscode.TreeItemCollapsibleState.Collapsed
			);
			item.id = `transfer:${node.id}`;
			item.description = describeRecord(node);
			item.tooltip = node.error ? `${node.title}\n${node.error}` : node.title;
			item.iconPath =
				node.state === 'running'
					? new vscode.ThemeIcon('sync~spin')
					: node.state === 'failed'
						? new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'))
						: node.state === 'cancelled'
							? new vscode.ThemeIcon('circle-slash')
							: new vscode.ThemeIcon('check', new vscode.ThemeColor('testing.iconPassed'));
			return item;
		}

		const item = new vscode.TreeItem(path.basename(node.localPath ?? node.to), vscode.TreeItemCollapsibleState.None);
		item.description = `${describeEntryProgress(node)}${ENTRY_NOTES[node.status]}${node.from} → ${node.to}`;
		const size = node.size !== undefined ? `\n\n${formatBytes(node.size)}` : '';
		item.tooltip = `${node.from}\n→ ${node.to}${size}${node.error ? `\n\n${node.error}` : ''}`;
		item.iconPath = ENTRY_ICONS[node.status];
		// Opening the local side lets you check what was sent or received; ignored downloads never got there.
		if (node.localPath && (node.status === 'done' || node.status === 'kept')) {
			item.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(node.localPath)] };
		}
		return item;
	}

	dispose(): void {
		if (this.timer) {
			clearTimeout(this.timer);
		}
		this.subscription.dispose();
		this.changed.dispose();
	}
}
