/**
 * WebSocketClient — Persistent bidirectional connection to the VPS API.
 * 
 * Used in VS Code "Local Server" mode.
 * Handles auth, chat messages, and tool_request/tool_result routing.
 */

import * as vscode from 'vscode';
import { LocalToolExecutor } from '../tools/LocalToolExecutor';

// We use the 'ws' package for WebSocket in Node.js (VS Code extension host)
// eslint-disable-next-line @typescript-eslint/naming-convention
import { WebSocket } from 'ws';

export type EventCallback = (event: any) => void;
export type AuthExpiredCallback = () => void;

export class WebSocketClient {
	private ws: WebSocket | null = null;
	private apiUrl: string;
	private authToken: string;
	private tenantDomain: string;
	private toolExecutor: LocalToolExecutor;
	private eventCallback: EventCallback | null = null;
	private reconnectTimer: NodeJS.Timeout | null = null;
	private isConnecting = false;
	private isAuthenticated = false;
	// Signature (path + length) of the active file whose CONTENT we last sent —
	// so we only re-ship the (large) file body when it actually changes, not on
	// every message. Saves ~thousands of tokens per turn in a conversation.
	private _lastSentFileSig = '';

	constructor(apiUrl: string, authToken: string, tenantDomain: string = '') {
		this.apiUrl = apiUrl;
		this.authToken = authToken;
		this.tenantDomain = tenantDomain;
		this.toolExecutor = new LocalToolExecutor();
	}

	private _onAuthExpired: AuthExpiredCallback | null = null;

	/**
	 * Set callback for auth expiry (4003 close).
	 */
	onAuthExpired(callback: AuthExpiredCallback) {
		this._onAuthExpired = callback;
	}

	/**
	 * Set the callback for receiving events (SSE-equivalent).
	 */
	onEvent(callback: EventCallback) {
		this.eventCallback = callback;
	}

	/**
	 * Connect to the VPS WebSocket endpoint.
	 */
	async connect(): Promise<void> {
		if (this.isConnecting || (this.ws && this.ws.readyState === WebSocket.OPEN)) {
			return;
		}
		this.isConnecting = true;

		return new Promise((resolve, reject) => {
			let settled = false;
			const settle = (fn: Function, arg?: any) => {
				if (settled) return;
				settled = true;
				fn(arg);
			};

			// Convert HTTP URL to WS URL. Carry the tenant on the query string AND a
			// header — the server resolves it from either (browsers can't set WS
			// headers, but the node 'ws' client can, so we send both for parity).
			let wsUrl = this.apiUrl
				.replace(/^https:/, 'wss:')
				.replace(/^http:/, 'ws:')
				.replace(/\/$/, '') + '/v1/ws';
			if (this.tenantDomain) {
				wsUrl += `?tenantDomain=${encodeURIComponent(this.tenantDomain)}`;
			}

			console.log(`WebSocketClient: Connecting to ${wsUrl}`);
			this.ws = new WebSocket(wsUrl, this.tenantDomain
				? { headers: { 'X-Tenant-Domain': this.tenantDomain } }
				: undefined);

			this.ws.on('open', () => {
				console.log('WebSocketClient: Connected, sending auth...');
				this.ws!.send(JSON.stringify({
					type: 'auth',
					token: `Bearer ${this.authToken}`,
				}));
			});

			this.ws.on('message', async (raw: Buffer) => {
				try {
					const data = JSON.parse(raw.toString());
					await this.handleMessage(data, 
						() => settle(resolve),
						(err: any) => settle(reject, err)
					);
				} catch (e) {
					console.error('WebSocketClient: Failed to parse message:', e);
				}
			});

			this.ws.on('close', (code: number, reason: Buffer) => {
				console.log(`WebSocketClient: Disconnected (${code}: ${reason})`);
				this.isConnecting = false;
				this.isAuthenticated = false;
				this.ws = null;
				settle(reject, new Error(`WebSocket closed: ${code}`));

				// GAP-8 fix: On auth failure (4003), trigger re-login instead of reconnecting
				if (code === 4003) {
					console.log('WebSocketClient: Auth expired/failed. Triggering re-login.');
					this._onAuthExpired?.();
					return; // Do NOT reconnect
				}

				// Auto-reconnect after 3 seconds (unless intentionally closed)
				if (code !== 1000) {
					this.scheduleReconnect();
				}
			});

			this.ws.on('error', (err: Error) => {
				console.error('WebSocketClient: Error:', err.message);
				this.isConnecting = false;
				settle(reject, err);
			});

			// Auth timeout
			setTimeout(() => {
				if (!this.isAuthenticated) {
					settle(reject, new Error('Auth timeout'));
					this.disconnect();
				}
			}, 15000);
		});
	}

	/**
	 * Handle an incoming WebSocket message.
	 */
	private async handleMessage(data: any, resolve?: Function, reject?: Function) {
		switch (data.type) {
			case 'auth_ok':
				this.isAuthenticated = true;
				this.isConnecting = false;
				console.log('WebSocketClient: Authenticated');
				resolve?.();
				break;

			case 'error':
				if (!this.isAuthenticated) {
					reject?.(new Error(data.message));
				}
				this.eventCallback?.({ type: 'error', message: data.message });
				break;

			case 'event':
				// HITL: an irreversible action needs the human to approve it.
				if (data.event === 'approval.request') {
					await this.handleApprovalRequest(data);
				}
				// SSE-equivalent event — forward to UI
				this.eventCallback?.(data);
				break;

			case 'tool_request':
				// The VPS agent needs us to execute a tool locally
				await this.handleToolRequest(data);
				break;

			case 'pong':
				// Keepalive response
				break;

			default:
				console.warn('WebSocketClient: Unknown message type:', data.type);
		}
	}

	/**
	 * Handle a tool_request from the VPS — execute locally and send result back.
	 */
	private async handleToolRequest(data: any) {
		const { requestId, toolName, toolArgs } = data;
		console.log(`WebSocketClient: Tool request ${requestId}: ${toolName}`);

		try {
			const result = await this.toolExecutor.execute(toolName, toolArgs || {});

			this.send({
				type: 'tool_result',
				requestId,
				result,
			});
		} catch (e: any) {
			this.send({
				type: 'tool_error',
				requestId,
				error: e.message,
			});
		}
	}

	/**
	 * HITL: prompt the user to approve/deny an irreversible action via a
	 * native VS Code modal, then send the decision back to the server.
	 */
	private async handleApprovalRequest(data: any) {
		const approvalId = data.approvalId;
		const toolName = data.tool_name || 'action';
		if (!approvalId) {
			return;
		}

		const argsPreview = data.tool_args
			? JSON.stringify(data.tool_args).slice(0, 300)
			: '';
		const choice = await vscode.window.showWarningMessage(
			`The agent wants to run "${toolName}". Approve this action?`,
			{ modal: true, detail: argsPreview },
			'Approve',
			'Deny',
		);

		// Modal dismissed (Esc) counts as a denial — fail safe.
		const approved = choice === 'Approve';
		this.send({
			type: 'approval_response',
			approvalId,
			approved,
			reason: approved ? 'approved in VS Code' : 'denied in VS Code',
		});
	}

	/**
	 * Send a chat message.
	 */
	sendChat(message: string, conversationId?: string, attachments?: any[]) {
		// Gather VS Code context
		const workspaceFolders = vscode.workspace.workspaceFolders;
		const workspaceRoot = workspaceFolders?.[0]?.uri.fsPath || 'None';

		const openFiles: string[] = [];
		for (const editor of vscode.window.visibleTextEditors) {
			if (editor.document.uri.scheme === 'file') {
				openFiles.push(vscode.workspace.asRelativePath(editor.document.uri, false));
			}
		}

		// Include the ACTIVE file's content + any selection so the agent sees the
		// open workspace (not just filenames). To avoid re-shipping the whole file
		// body on EVERY message (a large per-turn token cost), we only send the
		// content when the active file or its size CHANGED since we last sent it;
		// otherwise we send just the filename (the agent reads it on demand via
		// view_file — a cheap local call in Local mode). Selection is always sent
		// (small, and the user's focus changes per turn).
		const MAX_ACTIVE_CHARS = 12000;
		let activeFile: string | undefined;
		let activeFileContent: string | undefined;
		let activeFileTruncated = false;
		let selectedText: string | undefined;
		const activeEditor = vscode.window.activeTextEditor;
		if (activeEditor?.document.uri.scheme === 'file') {
			activeFile = vscode.workspace.asRelativePath(activeEditor.document.uri, false);
			const full = activeEditor.document.getText();
			const sig = `${activeFile}:${full.length}`;
			if (sig !== this._lastSentFileSig) {
				activeFileContent = full.slice(0, MAX_ACTIVE_CHARS);
				activeFileTruncated = full.length > MAX_ACTIVE_CHARS;
				this._lastSentFileSig = sig;
			}
			const sel = activeEditor.document.getText(activeEditor.selection);
			if (sel && sel.trim()) { selectedText = sel.slice(0, 8000); }
		}

		this.send({
			type: 'chat',
			message,
			conversationId,
			attachments: attachments && attachments.length ? attachments : undefined,
			context: {
				workspaceRoot,
				activeFile,
				activeFileContent,
				activeFileTruncated,
				selectedText,
				openFiles,
			},
		});
	}

	/**
	 * Send stop signal.
	 */
	sendStop() {
		this.send({ type: 'stop' });
	}

	/**
	 * Send a raw message.
	 */
	private send(data: any) {
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify(data));
		} else {
			console.warn('WebSocketClient: Cannot send — not connected');
		}
	}

	/**
	 * Check if connected and authenticated.
	 */
	get isConnected(): boolean {
		return this.ws !== null && this.ws.readyState === WebSocket.OPEN && this.isAuthenticated;
	}

	/**
	 * Disconnect cleanly.
	 */
	disconnect() {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		if (this.ws) {
			this.ws.close(1000, 'Client disconnect');
			this.ws = null;
		}
		this.isAuthenticated = false;
		this.isConnecting = false;
	}

	/**
	 * Update auth token (e.g., after re-login).
	 */
	updateToken(token: string) {
		this.authToken = token;
	}

	/**
	 * Schedule a reconnect attempt.
	 */
	private scheduleReconnect() {
		if (this.reconnectTimer) return;
		console.log('WebSocketClient: Scheduling reconnect in 3s...');
		this.reconnectTimer = setTimeout(async () => {
			this.reconnectTimer = null;
			try {
				await this.connect();
			} catch (e: any) {
				console.error('WebSocketClient: Reconnect failed:', e.message);
				this.scheduleReconnect(); // Try again
			}
		}, 3000);
	}
}
