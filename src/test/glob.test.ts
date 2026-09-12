import * as assert from 'assert';
import { matchesAnyGlob } from '../util/glob';

const DEFAULTS = ['**/.git/**', '**/node_modules/**'];

suite('glob', () => {
	test('an empty pattern list ignores nothing', () => {
		assert.strictEqual(matchesAnyGlob('src/index.ts', []), false);
		assert.strictEqual(matchesAnyGlob('src/index.ts', undefined), false);
	});

	test('the default patterns match at the root and at any depth', () => {
		assert.ok(matchesAnyGlob('.git/config', DEFAULTS));
		assert.ok(matchesAnyGlob('packages/app/.git/config', DEFAULTS));
		assert.ok(matchesAnyGlob('node_modules/left-pad/index.js', DEFAULTS));
		// A trailing `/**` should cover the directory entry itself, not only its contents.
		assert.ok(matchesAnyGlob('node_modules', DEFAULTS));
	});

	test('the default patterns leave ordinary sources alone', () => {
		assert.ok(!matchesAnyGlob('src/index.ts', DEFAULTS));
		assert.ok(!matchesAnyGlob('gitignore-notes.md', DEFAULTS));
		assert.ok(!matchesAnyGlob('src/node_modules_helper.ts', DEFAULTS));
	});

	test('* stays within one path segment and ? matches one character', () => {
		assert.ok(matchesAnyGlob('build.log', ['*.log']));
		assert.ok(!matchesAnyGlob('logs/build.log', ['*.log']));
		assert.ok(matchesAnyGlob('logs/build.log', ['**/*.log']));
		assert.ok(matchesAnyGlob('a1.tmp', ['a?.tmp']));
		assert.ok(!matchesAnyGlob('a12.tmp', ['a?.tmp']));
	});

	test('literal regex characters in a pattern are escaped', () => {
		assert.ok(matchesAnyGlob('file.min.js', ['file.min.js']));
		assert.ok(!matchesAnyGlob('fileXmin.js', ['file.min.js']));
	});

	test('a leading slash on the subject does not defeat matching', () => {
		assert.ok(matchesAnyGlob('/node_modules/x', DEFAULTS));
	});
});
