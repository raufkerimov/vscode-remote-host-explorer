const esbuild = require("esbuild");

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
	name: 'esbuild-problem-matcher',

	setup(build) {
		build.onStart(() => {
			console.log('[watch] build started');
		});
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				console.error(`    ${location.file}:${location.line}:${location.column}:`);
			});
			console.log('[watch] build finished');
		});
	},
};

/**
 * `ssh2` optionally loads two native modules — `cpu-features` (cipher-preference hints) and its own
 * prebuilt `sshcrypto.node` — each behind a `try { require(...) } catch {}`. We deliberately never ship
 * native addons (see CLAUDE.md: locally built .node files crash the Extension Host on macOS), so instead
 * of leaving them as unbundled externals that would fail with an unhelpful MODULE_NOT_FOUND at runtime,
 * they resolve to a stub that throws on load. ssh2 catches it and uses its pure-JS implementations.
 * @type {import('esbuild').Plugin}
 */
const stubNativeOptionalDepsPlugin = {
	name: 'stub-native-optional-deps',

	setup(build) {
		const NATIVE_OPTIONAL = /^(cpu-features|\.\/crypto\/build\/Release\/sshcrypto\.node)$/;

		build.onResolve({ filter: NATIVE_OPTIONAL }, args => ({
			path: args.path,
			namespace: 'native-optional-stub',
		}));

		build.onLoad({ filter: /.*/, namespace: 'native-optional-stub' }, args => ({
			contents: `throw new Error(${JSON.stringify(
				`Native optional dependency "${args.path}" is intentionally not bundled; ssh2 falls back to its JavaScript implementation.`
			)});`,
			loader: 'js',
		}));
	},
};

async function main() {
	const ctx = await esbuild.context({
		entryPoints: [
			'src/extension.ts'
		],
		bundle: true,
		format: 'cjs',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'node',
		// VS Code 1.90 (the `engines.vscode` floor) runs extensions on Node 20.9; compile bundled
		// dependency syntax down to that rather than assuming the newest runtime.
		target: 'node20.9',
		outfile: 'dist/extension.js',
		// `vscode` is provided by the Extension Host at runtime and can never be bundled. Everything else —
		// including ssh2/ssh2-sftp-client, which are pure JavaScript — is bundled so the packaged .vsix is
		// self-contained and does not need node_modules shipped alongside it.
		external: ['vscode'],
		// jsonc-parser's default UMD build loads its own files through a dynamic `require` that esbuild
		// can't follow, leaving them out of the bundle. Its ES module build uses static imports.
		alias: { 'jsonc-parser': 'jsonc-parser/lib/esm/main.js' },
		logLevel: 'silent',
		plugins: [
			stubNativeOptionalDepsPlugin,
			/* add to the end of plugins array */
			esbuildProblemMatcherPlugin,
		],
	});
	if (watch) {
		await ctx.watch();
	} else {
		await ctx.rebuild();
		await ctx.dispose();
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
