import * as assert from 'assert';
import type * as vscode from 'vscode';
import { MISSING_SSH_AGENT_MESSAGE, sshAgentSocket } from '../remote/clientFactory';
import { ftpSecurityFor } from '../remote/FtpClient';
import { remoteShellCommand } from '../remote/sshTerminal';
import { CancelledError, runWithLimit } from '../remote/transfer';
import { parseUriList } from '../tree/RemoteTreeProvider';

function token(cancelled = () => false): vscode.CancellationToken {
	return {
		get isCancellationRequested() {
			return cancelled();
		},
		onCancellationRequested: () => ({ dispose: () => undefined }),
	} as vscode.CancellationToken;
}

const tick = () => new Promise(resolve => setImmediate(resolve));

suite('runWithLimit', () => {
	test('never runs more than the limit at once, and runs every item', async () => {
		let running = 0;
		let peak = 0;
		const done: number[] = [];
		await runWithLimit([1, 2, 3, 4, 5, 6, 7], 3, token(), async item => {
			running += 1;
			peak = Math.max(peak, running);
			await tick();
			running -= 1;
			done.push(item);
		});
		assert.strictEqual(peak, 3);
		assert.deepStrictEqual(done.sort(), [1, 2, 3, 4, 5, 6, 7]);
	});

	test('a failure stops new items from starting and is rethrown', async () => {
		const started: number[] = [];
		await assert.rejects(
			runWithLimit([1, 2, 3, 4, 5], 1, token(), async item => {
				started.push(item);
				if (item === 2) {
					throw new Error('boom');
				}
			}),
			/boom/
		);
		assert.deepStrictEqual(started, [1, 2]);
	});

	test('cancellation stops before the next item', async () => {
		let cancelled = false;
		const started: number[] = [];
		await assert.rejects(
			runWithLimit([1, 2, 3], 1, token(() => cancelled), async item => {
				started.push(item);
				cancelled = true;
			}),
			CancelledError
		);
		assert.deepStrictEqual(started, [1]);
	});
});

suite('ftpSecurityFor', () => {
	test('FTPS on port 990 uses implicit TLS, any other port explicit TLS', () => {
		assert.strictEqual(ftpSecurityFor('ftps', 990), 'implicit');
		assert.strictEqual(ftpSecurityFor('ftps', 21), true);
		assert.strictEqual(ftpSecurityFor('ftps', 2121), true);
	});

	test('plain FTP is never encrypted', () => {
		assert.strictEqual(ftpSecurityFor('ftp', 990), false);
	});
});

suite('sshAgentSocket', () => {
	test('uses SSH_AUTH_SOCK when it is set', () => {
		assert.strictEqual(sshAgentSocket({ SSH_AUTH_SOCK: '/tmp/agent.sock' }, 'linux'), '/tmp/agent.sock');
		assert.strictEqual(sshAgentSocket({ SSH_AUTH_SOCK: 'pageant' }, 'win32'), 'pageant');
	});

	test('falls back to the OpenSSH agent pipe on Windows only', () => {
		assert.strictEqual(sshAgentSocket({}, 'win32'), '\\\\.\\pipe\\openssh-ssh-agent');
		assert.strictEqual(sshAgentSocket({}, 'darwin'), undefined);
		assert.ok(MISSING_SSH_AGENT_MESSAGE.includes('ssh-add'));
	});
});

suite('remoteShellCommand', () => {
	test('quotes the folder so spaces and quotes cannot break out of the cd', () => {
		assert.strictEqual(
			remoteShellCommand("/var/www/it's here; rm -rf ~"),
			`cd '/var/www/it'\\''s here; rm -rf ~' 2>/dev/null; exec "\${SHELL:-/bin/sh}" -l`
		);
	});
});

suite('parseUriList', () => {
	test('reads one URI per line and skips comments and blank lines', () => {
		const uris = parseUriList('# dragged from Finder\r\nfile:///Users/me/site/index.php\r\n\r\nfile:///Users/me/site/assets\n');
		assert.deepStrictEqual(
			uris.map(uri => uri.path),
			['/Users/me/site/index.php', '/Users/me/site/assets']
		);
		assert.ok(uris.every(uri => uri.scheme === 'file'));
	});
});
