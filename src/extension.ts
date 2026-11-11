import * as vscode from 'vscode';
import { ChatViewProvider } from './providers/ChatViewProvider';

export function activate(context: vscode.ExtensionContext) {
	console.log('Agent is now active!');

	const provider = new ChatViewProvider(context.extensionUri, context);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider('agent.chatView', provider)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('agent.start', () => {
			vscode.commands.executeCommand('workbench.view.extension.agent-sidebar');
		})
	);
}

export function deactivate() {}
