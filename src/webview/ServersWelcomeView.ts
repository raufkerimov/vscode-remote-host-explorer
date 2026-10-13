import * as fs from 'fs';
import * as vscode from 'vscode';

export const SERVERS_WELCOME_VIEW_ID = 'remoteHostExplorer.serversWelcome';

/**
 * The Remote Hosts view's empty state. It stands in for the tree while no server exists (see the
 * `remoteHostExplorer.noServers` context key) because `viewsWelcome` content can't be styled: VS Code
 * left-aligns its text and moves its button depending on the view's width.
 */
export class ServersWelcomeView implements vscode.WebviewViewProvider {
	constructor(private readonly extensionUri: vscode.Uri) {}

	async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
		const mediaRoot = vscode.Uri.joinPath(this.extensionUri, 'media');
		const webview = view.webview;
		webview.options = {
			// The page has no script; its only action is a command link, limited to this one command.
			enableScripts: false,
			enableCommandUris: ['remoteHostExplorer.addServer'],
			localResourceRoots: [mediaRoot],
		};

		const csp = ["default-src 'none'", `style-src ${webview.cspSource}`].join('; ');
		const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'serversWelcome.css'));
		const template = await fs.promises.readFile(vscode.Uri.joinPath(mediaRoot, 'serversWelcome.html').fsPath, 'utf8');
		webview.html = template.replace(/{{CSP}}/g, csp).replace(/{{STYLE_URI}}/g, styleUri.toString());
	}
}
