import * as assert from 'assert';
import * as crypto from 'crypto';
import * as tls from 'tls';
import type * as vscode from 'vscode';
import { sharesEndpoint } from '../commands/serverCommands';
import type { ServerProfile } from '../config/serverConfig';
import { certificateNames, DraftMemento, fingerprint, HostKeyStore } from '../remote/hostKeys';

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

/** Just the fields the host name check and the store read. */
function fakeCertificate(subjectaltname: string): tls.PeerCertificate {
	return { subject: { CN: 'prod.example-host.net' }, subjectaltname } as tls.PeerCertificate;
}

const SHARED_HOSTING_CERT = fakeCertificate('DNS:*.prod.example-host.net, DNS:prod.example-host.net');
const OTHER_CERT = fakeCertificate('DNS:attacker.example');

suite('FTPS certificate names', () => {
	test('the certificates this handles are the ones Node refuses for the host name', () => {
		assert.ok(tls.checkServerIdentity('my-site.example', SHARED_HOSTING_CERT) instanceof Error);
	});

	test('a certificate is identified by its alternative names, falling back to the common name', () => {
		assert.strictEqual(certificateNames(SHARED_HOSTING_CERT), 'DNS:*.prod.example-host.net, DNS:prod.example-host.net');
		assert.strictEqual(certificateNames({ subject: { CN: 'ftp.example' } } as tls.PeerCertificate), 'CN:ftp.example');
		assert.strictEqual(certificateNames({ subject: {} } as tls.PeerCertificate), '');
	});

	test('nothing is accepted until the user accepted it, and only for that endpoint and those names', async () => {
		const memento = fakeMemento();
		const store = new HostKeyStore(memento);
		assert.strictEqual(store.isCertificateAccepted('my-site.example', 21, SHARED_HOSTING_CERT), false);

		await memento.update('remoteHostExplorer.acceptedCertificateNames', {
			'my-site.example:21': certificateNames(SHARED_HOSTING_CERT),
		});
		const policy = store.certificatePolicyFor('site', 'my-site.example', 21);
		assert.strictEqual(policy.isTrusted(SHARED_HOSTING_CERT), true);
		// A renewed certificate for the same names is still accepted.
		assert.strictEqual(policy.isTrusted(fakeCertificate('DNS:*.prod.example-host.net, DNS:prod.example-host.net')), true);
		assert.strictEqual(policy.isTrusted(OTHER_CERT), false);
		assert.strictEqual(store.isCertificateAccepted('my-site.example', 990, SHARED_HOSTING_CERT), false);
		assert.strictEqual(store.isCertificateAccepted('other.example', 21, SHARED_HOSTING_CERT), false);
	});

	test('a certificate without names is never accepted', async () => {
		const memento = fakeMemento();
		await memento.update('remoteHostExplorer.acceptedCertificateNames', { 'my-site.example:21': '' });
		const store = new HostKeyStore(memento);
		assert.strictEqual(store.isCertificateAccepted('my-site.example', 21, { subject: {} } as tls.PeerCertificate), false);
	});

	test('forgetCertificate makes the next connection ask again, without touching host keys', async () => {
		const memento = fakeMemento();
		await memento.update('remoteHostExplorer.acceptedCertificateNames', {
			'my-site.example:21': certificateNames(SHARED_HOSTING_CERT),
		});
		await memento.update('remoteHostExplorer.knownHostKeys', { 'my-site.example:21': fingerprint(KEY_A) });
		const store = new HostKeyStore(memento);

		await store.forgetCertificate('my-site.example', 21);
		assert.strictEqual(store.isCertificateAccepted('my-site.example', 21, SHARED_HOSTING_CERT), false);
		assert.strictEqual(store.isTrusted('my-site.example', 21, KEY_A), true);
	});
});

suite('Trust accepted in the server form', () => {
	test('stays in memory until the server is saved, and only the saved endpoint is kept', async () => {
		const memento = fakeMemento();
		await memento.update('remoteHostExplorer.knownHostKeys', { 'old.example:22': fingerprint(KEY_B) });
		const store = new HostKeyStore(memento);
		// What `store.draft()` builds; written to directly here instead of through the prompts.
		const draftState = new DraftMemento(memento);
		const draft = new HostKeyStore(draftState);
		await draftState.update('remoteHostExplorer.knownHostKeys', {
			'old.example:22': fingerprint(KEY_B),
			'tested.example:22': fingerprint(KEY_A),
			'other.example:22': fingerprint(KEY_A),
		});
		await draftState.update('remoteHostExplorer.acceptedCertificateNames', {
			'tested.example:21': certificateNames(SHARED_HOSTING_CERT),
		});

		// The draft sees its own decisions and the saved ones; the real store sees only the saved ones.
		assert.strictEqual(draft.isTrusted('tested.example', 22, KEY_A), true);
		assert.strictEqual(draft.isTrusted('old.example', 22, KEY_B), true);
		assert.strictEqual(store.isTrusted('tested.example', 22, KEY_A), false);

		await store.keepFrom(draft, 'sftp', 'tested.example', 22);
		assert.strictEqual(store.isTrusted('tested.example', 22, KEY_A), true);
		assert.strictEqual(store.isTrusted('other.example', 22, KEY_A), false, 'only the saved endpoint is kept');
		assert.strictEqual(store.isCertificateAccepted('tested.example', 21, SHARED_HOSTING_CERT), false);

		await store.keepFrom(draft, 'ftps', 'tested.example', 21);
		assert.strictEqual(store.isCertificateAccepted('tested.example', 21, SHARED_HOSTING_CERT), true);
	});

	test('forget reports whether anything was remembered', async () => {
		const memento = fakeMemento();
		await memento.update('remoteHostExplorer.knownHostKeys', { 'example.com:22': fingerprint(KEY_A) });
		const store = new HostKeyStore(memento);
		assert.strictEqual(await store.forget('example.com', 22), true);
		assert.strictEqual(await store.forget('example.com', 22), false);
		assert.strictEqual(await store.forgetCertificate('example.com', 21), false);
	});
});

suite('sharesEndpoint', () => {
	const profile = (id: string, protocol: ServerProfile['protocol'], host: string, port?: number): ServerProfile => ({
		id,
		name: id,
		protocol,
		host,
		port,
		remoteRoot: '/',
	});

	test('another profile on the same protocol, host, and port keeps the trust', () => {
		const dev = profile('dev', 'sftp', 'example.com');
		assert.strictEqual(sharesEndpoint(dev, [dev, profile('prod', 'sftp', 'example.com', 22)]), true);
	});

	test('the profile itself, another port, host, or protocol does not', () => {
		const dev = profile('dev', 'ftps', 'example.com');
		assert.strictEqual(sharesEndpoint(dev, [dev]), false);
		assert.strictEqual(sharesEndpoint(dev, [profile('a', 'ftps', 'example.com', 990)]), false);
		assert.strictEqual(sharesEndpoint(dev, [profile('b', 'ftps', 'other.com')]), false);
		assert.strictEqual(sharesEndpoint(dev, [profile('c', 'ftp', 'example.com')]), false);
	});
});
