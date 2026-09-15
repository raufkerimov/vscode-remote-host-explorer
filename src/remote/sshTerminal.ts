import { StringDecoder } from 'string_decoder';
import * as vscode from 'vscode';
import type { ClientChannel } from 'ssh2';

/** Quotes a value for the POSIX shell on the server, which runs the command the terminal starts. */
function posixQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Starts the user's login shell in `remoteDir`, staying in the home folder if that folder is missing. */
export function remoteShellCommand(remoteDir: string): string {
	return `cd ${posixQuote(remoteDir)} 2>/dev/null; exec "\${SHELL:-/bin/sh}" -l`;
}

/**
 * VS Code terminal backed by a shell channel on the pooled SSH connection. No `ssh` binary is involved,
 * so it works on any machine and never asks for a password the extension already has.
 */
export class SshPseudoterminal implements vscode.Pseudoterminal {
	private readonly writeEmitter = new vscode.EventEmitter<string>();
	readonly onDidWrite = this.writeEmitter.event;
	private readonly closeEmitter = new vscode.EventEmitter<number | void>();
	readonly onDidClose = this.closeEmitter.event;
	private channel?: ClientChannel;
	private closedByUser = false;

	constructor(private readonly openChannel: (size: { rows: number; cols: number }) => Promise<ClientChannel>) {}

	open(initialDimensions: vscode.TerminalDimensions | undefined): void {
		const size = { rows: initialDimensions?.rows ?? 24, cols: initialDimensions?.columns ?? 80 };
		this.openChannel(size).then(
			channel => {
				if (this.closedByUser) {
					channel.close();
					return;
				}
				this.channel = channel;
				// A multi-byte character can be split across chunks; the decoders stitch it back together.
				const stdout = new StringDecoder('utf8');
				const stderr = new StringDecoder('utf8');
				channel.on('data', (data: Buffer) => this.writeEmitter.fire(stdout.write(data)));
				channel.stderr.on('data', (data: Buffer) => this.writeEmitter.fire(stderr.write(data)));
				let exitCode: number | undefined;
				channel.on('exit', (code: number | null) => {
					exitCode = code ?? undefined;
				});
				channel.on('close', () => this.closeEmitter.fire(exitCode));
			},
			(err: Error) => {
				// Keep the terminal open so the reason stays readable.
				this.writeEmitter.fire(`\r\nCould not open a shell: ${err.message}\r\n`);
			}
		);
	}

	close(): void {
		this.closedByUser = true;
		this.channel?.close();
	}

	handleInput(data: string): void {
		this.channel?.write(data);
	}

	setDimensions(dimensions: vscode.TerminalDimensions): void {
		this.channel?.setWindow(dimensions.rows, dimensions.columns, 0, 0);
	}
}
