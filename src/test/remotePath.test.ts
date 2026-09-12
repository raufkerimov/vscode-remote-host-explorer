import * as assert from 'assert';
import * as path from 'path';
import {
	basenameRemote,
	dirnameRemote,
	isSameOrInside,
	joinRemote,
	normalizeRemote,
	toSafeRelativePath,
} from '../util/remotePath';

suite('remotePath', () => {
	test('normalizeRemote collapses separators and keeps absolute roots', () => {
		assert.strictEqual(normalizeRemote('/var//www///'), '/var/www');
		assert.strictEqual(normalizeRemote('/'), '/');
		assert.strictEqual(normalizeRemote('//'), '/');
		assert.strictEqual(normalizeRemote('/var/www/../log'), '/var/log');
	});

	test('joinRemote tolerates separators on either side', () => {
		assert.strictEqual(joinRemote('/var/www/', '/html'), '/var/www/html');
		assert.strictEqual(joinRemote('/', 'index.php'), '/index.php');
		assert.strictEqual(joinRemote('/var/www', 'a', 'b'), '/var/www/a/b');
	});

	test('dirname and basename operate on POSIX paths', () => {
		assert.strictEqual(dirnameRemote('/var/www/index.php'), '/var/www');
		assert.strictEqual(basenameRemote('/var/www/index.php'), 'index.php');
		assert.strictEqual(dirnameRemote('/index.php'), '/');
	});

	test('isSameOrInside does not treat sibling prefixes as descendants', () => {
		assert.ok(isSameOrInside('/var/www', '/var/www'));
		assert.ok(isSameOrInside('/var/www', '/var/www/html'));
		// Regression: a naive startsWith check would call this a descendant.
		assert.ok(!isSameOrInside('/var/www', '/var/www-backup'));
		assert.ok(!isSameOrInside('/var/www/html', '/var/www'));
	});

	test('toSafeRelativePath strips traversal and absolute prefixes', () => {
		assert.strictEqual(toSafeRelativePath('/var/www/index.php'), path.join('var', 'www', 'index.php'));
		// A server-supplied `..` must not be able to climb out of the cache directory.
		assert.strictEqual(toSafeRelativePath('../../etc/passwd'), path.join('etc', 'passwd'));
		assert.strictEqual(toSafeRelativePath('/a/../../../b'), path.join('a', 'b'));
		assert.strictEqual(toSafeRelativePath('..'), '');
		assert.strictEqual(toSafeRelativePath('/'), '');
	});

	test('toSafeRelativePath neutralises characters that are illegal on Windows', () => {
		assert.strictEqual(toSafeRelativePath('C:/secret'), path.join('C_', 'secret'));
		assert.strictEqual(toSafeRelativePath('/a/we:ird*name?'), path.join('a', 'we_ird_name_'));
	});
});
