import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { expandHome } from '../util/localPath';

/** The settings of one `Host` alias in `~/.ssh/config` that a server profile can use. */
export interface SshConfigHost {
	alias: string;
	hostName?: string;
	user?: string;
	port?: number;
	identityFile?: string;
	/** Reaches the server through `ProxyJump`/`ProxyCommand`, which this extension can't do. */
	usesProxy: boolean;
}

interface Block {
	/** `undefined` for options before the first `Host` line, which apply to every host. */
	patterns?: string[];
	options: [string, string][];
}

/** `Keyword value`, `Keyword=value`, and double-quoted values, as ssh_config(5) allows. */
function parseLine(line: string): [string, string] | undefined {
	const trimmed = line.trim();
	if (!trimmed || trimmed.startsWith('#')) {
		return undefined;
	}
	const match = /^(\S+?)(?:\s*=\s*|\s+)(.*)$/.exec(trimmed);
	if (!match) {
		return undefined;
	}
	return [match[1].toLowerCase(), match[2].trim().replace(/^"(.*)"$/, '$1')];
}

/** ssh's host pattern matching: `*` and `?` wildcards, `!` negation. */
function matchesPatterns(alias: string, patterns: readonly string[]): boolean {
	const toRegex = (pattern: string) =>
		new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
	let matched = false;
	for (const pattern of patterns) {
		if (pattern.startsWith('!')) {
			if (toRegex(pattern.slice(1)).test(alias)) {
				return false;
			}
		} else if (toRegex(pattern).test(alias)) {
			matched = true;
		}
	}
	return matched;
}

/**
 * Parses an ssh config into the concrete aliases it defines (patterns with wildcards are not hosts you
 * can pick). As in ssh, the first value found for an option wins, taken from every block whose patterns
 * match the alias in file order — so `Host *` defaults apply too. `Match` blocks depend on runtime
 * conditions and are skipped. Pure so it can be unit tested.
 */
export function parseSshConfig(text: string): SshConfigHost[] {
	const blocks: Block[] = [{ options: [] }];
	let skipping = false;
	for (const line of text.split(/\r?\n/)) {
		const parsed = parseLine(line);
		if (!parsed) {
			continue;
		}
		const [keyword, value] = parsed;
		if (keyword === 'host') {
			skipping = false;
			blocks.push({ patterns: value.split(/\s+/).filter(Boolean), options: [] });
		} else if (keyword === 'match') {
			skipping = true;
		} else if (!skipping) {
			blocks[blocks.length - 1].options.push([keyword, value]);
		}
	}

	const aliases = new Set<string>();
	for (const block of blocks) {
		for (const pattern of block.patterns ?? []) {
			if (!/[*?!]/.test(pattern)) {
				aliases.add(pattern);
			}
		}
	}

	return [...aliases].map(alias => {
		const options = new Map<string, string>();
		for (const block of blocks) {
			if (block.patterns && !matchesPatterns(alias, block.patterns)) {
				continue;
			}
			for (const [keyword, value] of block.options) {
				if (!options.has(keyword)) {
					options.set(keyword, value);
				}
			}
		}
		const port = Number(options.get('port'));
		const hostName = options.get('hostname')?.replace(/%h/g, alias);
		return {
			alias,
			hostName,
			user: options.get('user'),
			port: Number.isInteger(port) && port > 0 ? port : undefined,
			identityFile: options.get('identityfile'),
			usesProxy: options.has('proxyjump') || options.has('proxycommand'),
		};
	});
}

/** Where ssh looks for relative `Include` paths in the user's config. */
const SSH_DIR = path.join(os.homedir(), '.ssh');

/** Expands `Include` lines in place (relative to `~/.ssh`, `*` wildcards in the file name), a few levels deep. */
async function readWithIncludes(file: string, depth = 0): Promise<string> {
	const text = await fs.promises.readFile(file, 'utf8');
	if (depth >= 5) {
		return text;
	}
	const lines: string[] = [];
	for (const line of text.split(/\r?\n/)) {
		const parsed = parseLine(line);
		if (parsed?.[0] !== 'include') {
			lines.push(line);
			continue;
		}
		for (const pattern of parsed[1].split(/\s+/).filter(Boolean)) {
			const expanded = expandHome(pattern);
			const absolute = path.isAbsolute(expanded) ? expanded : path.join(SSH_DIR, expanded);
			const directory = path.dirname(absolute);
			const namePattern = new RegExp(`^${path.basename(absolute).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
			const names = (await fs.promises.readdir(directory).catch(() => [] as string[])).filter(name => namePattern.test(name)).sort();
			for (const name of names) {
				lines.push(await readWithIncludes(path.join(directory, name), depth + 1).catch(() => ''));
			}
		}
	}
	return lines.join('\n');
}

/** Hosts from the user's `~/.ssh/config`, or an empty list when there is none. */
export async function readSshConfigHosts(file = path.join(SSH_DIR, 'config')): Promise<SshConfigHost[]> {
	try {
		return parseSshConfig(await readWithIncludes(file));
	} catch {
		return [];
	}
}
