import * as assert from 'assert';
import * as crypto from 'crypto';
import type * as vscode from 'vscode';
import { fingerprint, HostKeyStore } from '../remote/hostKeys';

/** Minimal in-memory Memento so the store can be exercised without a real extension context. */
function fakeMemento(): vscode.Memento {
	const values = new Map<string, unknown>();
	return {
		keys: () => [...values.keys()],
		get: (<T>(key: string, fallback?: T) => (values.has(key) ? (values.get(key) as T) : fallback)) as vscode.Memento['get'],
		update: async (key: string, value: unknown) => {
			values.set(key, value);
		},
	};
}

const KEY_A = Buffer.from('ssh-ed25519 host key A');
const KEY_B = Buffer.from('ssh-ed25519 host key B');

suite('fingerprint', () => {
	test('matches the OpenSSH SHA256 format', () => {
		const expected = crypto.createHash('sha256').update(KEY_A).digest('base64').replace(/=+$/, '');
		assert.strictEqual(fingerprint(KEY_A), `SHA256:${expected}`);
		assert.ok(!fingerprint(KEY_A).endsWith('='), 'padding should be stripped');
	});

	test('different keys produce different fingerprints', () => {
		assert.notStrictEqual(fingerprint(KEY_A), fingerprint(KEY_B));
	});
});

suite('HostKeyStore', () => {
	test('an unseen host is never trusted implicitly', () => {
		const store = new HostKeyStore(fakeMemento());
		assert.strictEqual(store.isTrusted('example.com', 22, KEY_A), false);
	});

	test('isTrusted is synchronous and exact once a key is remembered', async () => {
		const memento = fakeMemento();
		await memento.update('remoteHostExplorer.knownHostKeys', {
			'example.com:22': fingerprint(KEY_A),
		});
		const store = new HostKeyStore(memento);

		assert.strictEqual(store.isTrusted('example.com', 22, KEY_A), true);
		// A different key on the same host must not be accepted.
		assert.strictEqual(store.isTrusted('example.com', 22, KEY_B), false);
		// Trust is scoped per host:port, not per host.
		assert.strictEqual(store.isTrusted('example.com', 2222, KEY_A), false);
		assert.strictEqual(store.isTrusted('other.com', 22, KEY_A), false);
	});

	test('policyFor exposes a synchronous isTrusted bound to one endpoint', async () => {
		const memento = fakeMemento();
		await memento.update('remoteHostExplorer.knownHostKeys', {
			'example.com:22': fingerprint(KEY_A),
		});
		const policy = new HostKeyStore(memento).policyFor('prod', 'example.com', 22);

		assert.strictEqual(policy.isTrusted(KEY_A), true);
		assert.strictEqual(policy.isTrusted(KEY_B), false);
	});

	test('forget makes a host unknown again', async () => {
		const memento = fakeMemento();
		await memento.update('remoteHostExplorer.knownHostKeys', {
			'example.com:22': fingerprint(KEY_A),
		});
		const store = new HostKeyStore(memento);

		await store.forget('example.com', 22);
		assert.strictEqual(store.isTrusted('example.com', 22, KEY_A), false);
	});
});
