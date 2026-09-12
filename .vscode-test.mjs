import { defineConfig } from '@vscode/test-cli';
import * as os from 'node:os';
import * as path from 'node:path';

// VS Code opens a unix domain socket inside the user-data directory, and macOS caps those paths at
// 103 characters. Defaulting to `.vscode-test/user-data` inside a deeply nested checkout blows that
// limit and the test host fails to start, so anchor it in the OS temp directory instead.
const userDataDir = path.join(os.tmpdir(), 'remote-host-explorer-test-user-data');

export default defineConfig({
	files: 'out/test/**/*.test.js',
	launchArgs: ['--user-data-dir', userDataDir],
});
