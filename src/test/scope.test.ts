import * as assert from 'assert';
import { mergeScopedProfiles, type ServerProfile } from '../config/serverConfig';

function profile(id: string): ServerProfile {
	return { id, name: id, protocol: 'sftp', host: `${id}.example.com`, remoteRoot: '/' };
}

suite('mergeScopedProfiles', () => {
	test('shows project servers and global servers together, project first', () => {
		const merged = mergeScopedProfiles([profile('g1'), profile('g2')], [profile('p1')]);
		assert.deepStrictEqual(
			merged.map(entry => [entry.profile.id, entry.scope]),
			[['p1', 'project'], ['g1', 'global'], ['g2', 'global']]
		);
	});

	test('a project that defines servers does not hide the global ones', () => {
		// Regression guard: VS Code's own array resolution would drop every global server here.
		const merged = mergeScopedProfiles([profile('g1')], [profile('p1')]);
		assert.ok(merged.some(entry => entry.profile.id === 'g1'));
	});

	test('with no project servers, only global servers are shown', () => {
		const merged = mergeScopedProfiles([profile('g1')], undefined);
		assert.deepStrictEqual(merged.map(entry => entry.scope), ['global']);
	});

	test('with nothing configured, the list is empty', () => {
		assert.deepStrictEqual(mergeScopedProfiles(undefined, undefined), []);
	});

	test('the project copy wins when the same id exists in both scopes', () => {
		const globalCopy = { ...profile('shared'), host: 'global.example.com' };
		const projectCopy = { ...profile('shared'), host: 'project.example.com' };
		const merged = mergeScopedProfiles([globalCopy], [projectCopy]);
		assert.strictEqual(merged.length, 1);
		assert.strictEqual(merged[0].scope, 'project');
		assert.strictEqual(merged[0].profile.host, 'project.example.com');
	});

	test('if two project folders define the same id, the first one wins', () => {
		const first = { ...profile('dup'), host: 'first.example.com' };
		const second = { ...profile('dup'), host: 'second.example.com' };
		const merged = mergeScopedProfiles([], [first, second]);
		assert.deepStrictEqual(merged.map(entry => entry.profile.host), ['first.example.com']);
	});
});
