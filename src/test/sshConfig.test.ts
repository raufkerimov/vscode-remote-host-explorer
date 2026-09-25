import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseSshConfig, readSshConfigHosts } from '../config/sshConfig';

suite('ssh config', () => {
	test('reads concrete hosts with their options, first value winning', () => {
		const hosts = parseSshConfig(`
# comment
Host prod web
    HostName 203.0.113.10
    User deploy
    Port 2222
    IdentityFile ~/.ssh/deploy_ed25519
    Port 22

Host dev
    HostName=dev.example.com
    User "dev user"

Host *.internal !secret.internal
    ProxyJump bastion

Host *
    User fallback
    IdentityFile ~/.ssh/id_rsa
`);
		const byAlias = new Map(hosts.map(host => [host.alias, host]));
		assert.deepStrictEqual([...byAlias.keys()], ['prod', 'web', 'dev']);
		assert.deepStrictEqual(byAlias.get('prod'), {
			alias: 'prod',
			hostName: '203.0.113.10',
			user: 'deploy',
			port: 2222,
			identityFile: '~/.ssh/deploy_ed25519',
			usesProxy: false,
		});
		assert.strictEqual(byAlias.get('web')?.hostName, '203.0.113.10');
		assert.strictEqual(byAlias.get('dev')?.user, 'dev user');
		assert.strictEqual(byAlias.get('dev')?.identityFile, '~/.ssh/id_rsa', 'Host * defaults apply');
	});

	test('wildcard blocks apply to matching aliases, negations excluded', () => {
		const hosts = parseSshConfig(`
Host app.internal secret.internal
    HostName %h
Host *.internal !secret.internal
    ProxyJump bastion
`);
		assert.strictEqual(hosts.find(host => host.alias === 'app.internal')?.usesProxy, true);
		assert.strictEqual(hosts.find(host => host.alias === 'secret.internal')?.usesProxy, false);
		assert.strictEqual(hosts.find(host => host.alias === 'app.internal')?.hostName, 'app.internal');
	});

	test('Match blocks are skipped', () => {
		const [host] = parseSshConfig('Host a\n  User one\nMatch exec "true"\n  User two\n');
		assert.strictEqual(host.user, 'one');
	});

	test('Include pulls in other files', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhv-ssh-'));
		try {
			fs.mkdirSync(path.join(dir, 'conf.d'));
			fs.writeFileSync(path.join(dir, 'conf.d', 'work.conf'), 'Host work\n  HostName work.example.com\n');
			fs.writeFileSync(path.join(dir, 'config'), `Include ${path.join(dir, 'conf.d', '*.conf')}\nHost home\n  HostName home.example.com\n`);
			const hosts = await readSshConfigHosts(path.join(dir, 'config'));
			assert.deepStrictEqual(hosts.map(host => host.alias).sort(), ['home', 'work']);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('a missing config is simply empty', async () => {
		assert.deepStrictEqual(await readSshConfigHosts(path.join(os.tmpdir(), 'rhv-no-such-config')), []);
	});
});
