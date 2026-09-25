import * as vscode from 'vscode';
import type { ServerProfile } from './serverConfig';

/**
 * Production servers whose confirmation for *repeated* changes (saving, auto-upload) was waived until the
 * window reloads. Explicit actions — upload, delete, move — always ask.
 */
const waivedRepeated = new Set<string>();

const CONTINUE = 'Continue';
const DONT_ASK_AGAIN = "Continue, Don't Ask Again Until Reload";

export interface ProductionConfirmOptions {
	/** A change the user makes over and over (saving a file): offer to stop asking until the window reloads. */
	repeated?: boolean;
}

/**
 * Asks before changing files on a server marked as production. Resolves `true` straight away for any
 * other server, so callers can guard every write without checking the flag themselves.
 */
export async function confirmProductionChange(
	server: ServerProfile,
	action: string,
	{ repeated = false }: ProductionConfirmOptions = {}
): Promise<boolean> {
	if (!server.production || (repeated && waivedRepeated.has(server.id))) {
		return true;
	}
	const choice = await vscode.window.showWarningMessage(
		`"${server.name}" is a production server.`,
		{ modal: true, detail: `${action}\n\nThis changes files on the live server.` },
		CONTINUE,
		...(repeated ? [DONT_ASK_AGAIN] : [])
	);
	if (choice === DONT_ASK_AGAIN) {
		waivedRepeated.add(server.id);
	}
	return choice === CONTINUE || choice === DONT_ASK_AGAIN;
}

/** Scheme of the URI a server row carries so the decoration below can colour production servers. */
export const SERVER_URI_SCHEME = 'remotehostexplorer-server';

export function serverRowUri(server: ServerProfile): vscode.Uri {
	return vscode.Uri.from({ scheme: SERVER_URI_SCHEME, path: `/${server.id}`, query: server.production ? 'production' : '' });
}

/** Colours production server rows red with a "P" badge, so the live server stands out in the tree. */
export class ProductionDecorationProvider implements vscode.FileDecorationProvider {
	provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
		if (uri.scheme !== SERVER_URI_SCHEME || uri.query !== 'production') {
			return undefined;
		}
		return new vscode.FileDecoration('P', 'Production server', new vscode.ThemeColor('list.errorForeground'));
	}
}
