import * as vscode from 'vscode';
import { WebSocketClient } from '../services/WebSocketClient';

type WorkspaceMode = 'local' | 'cloud';

export class ChatViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'agent.chatView';

	// Secret-store keys for the JWT pair.
	public static readonly TOKEN_KEY = 'agent.authToken';
	public static readonly REFRESH_KEY = 'agent.refreshToken';

	private _view?: vscode.WebviewView;
	private _wsClient: WebSocketClient | null = null;
	private _currentMode: WorkspaceMode;
	// Single-flight guard so concurrent 401s trigger only one refresh.
	private _refreshInFlight: Promise<string | null> | null = null;

	constructor(
		private readonly _extensionUri: vscode.Uri,
		private readonly _context: vscode.ExtensionContext
	) {
		// Read initial mode from VS Code settings
		const config = vscode.workspace.getConfiguration('agent');
		this._currentMode = (config.get<string>('workspaceMode', 'local') as WorkspaceMode);
	}

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	) {
		this._view = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [
				this._extensionUri
			]
		};

		webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

		// Per-tenant branding from the SINGLE source (/TenantConfig — same as
		// web/chatbot/Teams): brand the panel title + push branding to the webview.
		this._loadBranding(webviewView);

		// Check if we have a token and send initial mode
		this._context.secrets.get(ChatViewProvider.TOKEN_KEY).then((token) => {
			if (!token) {
				webviewView.webview.postMessage({ type: 'require_login' });
			}
			// Always send current mode so webview can display it
			webviewView.webview.postMessage({ type: 'mode_changed', mode: this._currentMode });
		});

		webviewView.webview.onDidReceiveMessage(async (data) => {
			switch (data.type) {
				case 'login_request':
					{
						await this.handleLogin(data.username, data.password);
						break;
					}
				case 'logout_request':
					{
						await this.handleLogout();
						break;
					}
				case 'user_input':
					{
						await this.handleUserInput(data.text, data.conversationId, data.attachments);
						break;
					}
				case 'apply_diff':
					{
						await this.handleApplyDiff(data.diff);
						break;
					}
				case 'load_conversations':
					{
						await this.handleLoadConversations();
						break;
					}
				case 'load_conversation':
					{
						await this.handleLoadConversation(data.conversationId);
						break;
					}
				case 'delete_conversation':
					{
						await this.handleDeleteConversation(data.conversationId);
						break;
					}
				case 'new_chat':
					{
						this._view?.webview.postMessage({ type: 'new_chat_ready' });
						break;
					}
				case 'switch_mode':
					{
						await this.handleSwitchMode(data.mode);
						break;
					}
				case 'stop_generation':
					{
						// Stop handled by the WebSocket or stream cancellation
						break;
					}
				case 'approval_response':
					{
						await this.handleApprovalResponse(
							data.approvalId,
							data.approved,
							data.reason
						);
						break;
					}
			}
		});
	}

	// ── Mode Switching ──────────────────────────────────────────────

	private async handleSwitchMode(mode: WorkspaceMode) {
		if (mode === this._currentMode) return;

		// Disconnect existing WebSocket if switching away from local
		if (this._currentMode === 'local' && this._wsClient) {
			this._wsClient.disconnect();
			this._wsClient = null;
		}

		this._currentMode = mode;
		
		// Persist to VS Code settings
		const config = vscode.workspace.getConfiguration('agent');
		await config.update('workspaceMode', mode, vscode.ConfigurationTarget.Global);

		vscode.window.showInformationMessage(
			`Agent: Switched to ${mode === 'local' ? '🖥️ Local Server' : '☁️ Cloud Server'} mode`
		);

		// Notify webview of mode change
		this._view?.webview.postMessage({ type: 'mode_changed', mode });
	}

	private async handleLogout() {
		// Disconnect WebSocket on logout
		if (this._wsClient) {
			this._wsClient.disconnect();
			this._wsClient = null;
		}
		await this._context.secrets.delete(ChatViewProvider.TOKEN_KEY);
		await this._context.secrets.delete(ChatViewProvider.REFRESH_KEY);
		this._view?.webview.postMessage({ type: 'require_login' });
		vscode.window.showInformationMessage('Agent: Signed out.');
	}

	// ── Conversation History (always via HTTP, regardless of mode) ───

	private getApiUrl(): string {
		const config = vscode.workspace.getConfiguration('agent');
		// Routed through the central Storeglance gateway (SMSystem parity):
		// /api/agent/{**} → Agent.API, carrying X-Tenant-Domain for tenant resolution.
		return config.get<string>('apiUrl') || 'https://api.storeglance.com/api/agent';
	}

	/** The tenant this extension targets, sent as X-Tenant-Domain (like agent.web). */
	private getTenantDomain(): string {
		const config = vscode.workspace.getConfiguration('agent');
		return config.get<string>('tenantDomain') || '';
	}

	/**
	 * Load per-tenant branding from /TenantConfig (the SINGLE source shared by the
	 * web, chatbot, and Teams channels) and apply it: brand the panel title with the
	 * org name and forward the branding to the webview. Best-effort; never throws.
	 */
	private async _loadBranding(view: vscode.WebviewView): Promise<void> {
		try {
			const domain = this.getTenantDomain();
			if (!domain) { return; }
			const res = await fetch(`${this.getApiUrl()}/TenantConfig?subdomain=${encodeURIComponent(domain)}`, {
				headers: { 'X-Tenant-Domain': domain },
			});
			if (!res.ok) { return; }
			const cfg: any = await res.json();
			if (cfg?.orgName) { view.title = cfg.orgName; }
			view.webview.postMessage({
				type: 'branding',
				orgName: cfg?.orgName || '',
				logoUrl: cfg?.logoUrl || '',
				themeColor: cfg?.themeColor || '',
			});
		} catch {
			/* neutral — keep default title */
		}
	}

	// ── Token lifecycle (refresh-token rotation aware) ───────────────

	/**
	 * Renew the access token using the stored refresh token.
	 * The backend rotates refresh tokens (single-use), so BOTH new tokens
	 * are persisted — replaying the old refresh token would be treated as
	 * theft and revoke the whole session. Single-flighted to avoid races.
	 */
	private async tryRefreshToken(): Promise<string | null> {
		if (this._refreshInFlight) {
			return this._refreshInFlight;
		}
		this._refreshInFlight = (async () => {
			const accessToken = await this._context.secrets.get(ChatViewProvider.TOKEN_KEY);
			const refreshToken = await this._context.secrets.get(ChatViewProvider.REFRESH_KEY);
			if (!accessToken || !refreshToken) {
				return null;
			}
			try {
				const response = await fetch(`${this.getApiUrl()}/Login`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json', 'X-AG-Source': 'vscode',
						...(this.getTenantDomain() ? { 'X-Tenant-Domain': this.getTenantDomain() } : {}) },
					body: JSON.stringify({
						grantType: 'refresh_token',
						token: { token: accessToken, refreshToken: refreshToken }
					})
				});
				if (!response.ok) {
					return null;
				}
				const data: any = await response.json();
				if (data.isAuthenticated && data.accessToken) {
					await this._context.secrets.store(ChatViewProvider.TOKEN_KEY, data.accessToken);
					if (data.refreshToken) {
						await this._context.secrets.store(ChatViewProvider.REFRESH_KEY, data.refreshToken);
					}
					return data.accessToken as string;
				}
				return null;
			} catch {
				return null;
			} finally {
				this._refreshInFlight = null;
			}
		})();
		return this._refreshInFlight;
	}

	/** Clear both tokens and prompt the webview to re-authenticate. */
	private async forceReLogin(message?: string): Promise<void> {
		await this._context.secrets.delete(ChatViewProvider.TOKEN_KEY);
		await this._context.secrets.delete(ChatViewProvider.REFRESH_KEY);
		this._view?.webview.postMessage({ type: 'require_login' });
		if (message) {
			vscode.window.showWarningMessage(message);
		}
	}

	/**
	 * Authenticated fetch: attaches the Bearer token and, on a 401, transparently
	 * refreshes once and retries. Returns null if the user must re-authenticate
	 * (caller should stop). Centralizes the previously-duplicated 401 handling.
	 */
	private async authedFetch(path: string, options: any = {}, _retried = false): Promise<Response | null> {
		const token = await this._context.secrets.get(ChatViewProvider.TOKEN_KEY);
		if (!token) {
			await this.forceReLogin();
			return null;
		}
		const headers = {
			...(options.headers || {}),
			'Authorization': `Bearer ${token}`,
			'X-AG-Source': 'vscode',
			...(this.getTenantDomain() ? { 'X-Tenant-Domain': this.getTenantDomain() } : {})
		};
		const response = await fetch(`${this.getApiUrl()}${path}`, { ...options, headers });
		if (response.status === 401 && !_retried) {
			const newToken = await this.tryRefreshToken();
			if (newToken) {
				return this.authedFetch(path, options, true);
			}
			await this.forceReLogin();
			return null;
		}
		return response;
	}

	private async handleLoadConversations() {
		try {
			const response = await this.authedFetch('/v1/chat/conversations', { method: 'GET' });
			if (!response) {
				return; // re-login already requested
			}
			if (!response.ok) {
				throw new Error(`API returned ${response.status}`);
			}

			const conversations = await response.json();
			this._view?.webview.postMessage({ type: 'conversations_loaded', conversations });
		} catch (error: any) {
			console.error('Failed to load conversations:', error);
			this._view?.webview.postMessage({ type: 'conversations_loaded', conversations: [] });
		}
	}

	private async handleLoadConversation(conversationId: string) {
		try {
			const response = await this.authedFetch(`/v1/chat/conversations/${conversationId}`, { method: 'GET' });
			if (!response) {
				return; // re-login already requested
			}
			if (!response.ok) {
				throw new Error(`API returned ${response.status}`);
			}

			const detail: any = await response.json();
			const messages = (detail.messages || []).map((m: any, idx: number) => ({
				id: m.message_id?.toString() || `hist-${idx}`,
				role: m.role as 'user' | 'assistant',
				content: m.content || '',
				tool_calls: m.tool_calls || undefined
			}));

			this._view?.webview.postMessage({
				type: 'conversation_loaded',
				conversationId,
				messages
			});
		} catch (error: any) {
			vscode.window.showErrorMessage('Failed to load conversation: ' + error.message);
		}
	}

	private async handleDeleteConversation(conversationId: string) {
		try {
			const response = await this.authedFetch(`/v1/chat/conversations/${conversationId}`, { method: 'DELETE' });
			if (!response) return; // re-login already requested

			// Refresh the list
			await this.handleLoadConversations();
		} catch (error: any) {
			console.error('Failed to delete conversation:', error);
		}
	}

	// ── HITL Approval Response ───────────────────────────────────────

	private async handleApprovalResponse(approvalId: string, approved: boolean, reason?: string) {
		if (!approvalId) return;

		// In Local/WS mode, send via WebSocket directly
		if (this._currentMode === 'local' && this._wsClient?.isConnected) {
			// The WebSocketClient already handles approval via vscode modal,
			// but this covers the case where the webview UI sends approval_response.
			(this._wsClient as any).send?.({
				type: 'approval_response',
				approvalId,
				approved,
				reason: reason || (approved ? 'approved in VS Code' : 'denied in VS Code'),
			});
			return;
		}

		// Cloud mode: POST to the HTTP API
		try {
			await this.authedFetch(`/v1/chat/approvals/${approvalId}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					approved,
					reason: reason || (approved ? 'approved in VS Code' : 'denied in VS Code'),
				}),
			});
		} catch (error: any) {
			console.error('Failed to resolve approval:', error);
			vscode.window.showErrorMessage('Agent: Failed to submit approval decision.');
		}
	}

	private async handleLogin(username: string, password: string) {
		try {
			const apiUrl = this.getApiUrl();

			const response = await fetch(`${apiUrl}/Login`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'X-AG-Source': 'vscode',
					...(this.getTenantDomain() ? { 'X-Tenant-Domain': this.getTenantDomain() } : {})
				},
				body: JSON.stringify({
					grantType: 'client_credentials',
					userName: username,
					password: password
				})
			});

			if (!response.ok) {
				// Surface the server's message (now generic & safe — e.g.
				// "Invalid username or password" or a lockout notice).
				let detail = `Server error (${response.status})`;
				try {
					const body: any = await response.json();
					detail = body.detail || body.message || detail;
				} catch { /* non-JSON error body */ }
				throw new Error(detail);
			}

			const data: any = await response.json();
			if (data.isAuthenticated && data.accessToken) {
				// Store BOTH tokens — the refresh token is required to renew the
				// session without re-prompting for credentials every 24h.
				await this._context.secrets.store(ChatViewProvider.TOKEN_KEY, data.accessToken);
				if (data.refreshToken) {
					await this._context.secrets.store(ChatViewProvider.REFRESH_KEY, data.refreshToken);
				}
				this._view?.webview.postMessage({ type: 'login_success' });
				vscode.window.showInformationMessage('Agent: Login Successful');
			} else {
				throw new Error(data.message || 'Login failed.');
			}
		} catch (error: any) {
			this._view?.webview.postMessage({ type: 'login_failed', error: error.message });
			vscode.window.showErrorMessage('Agent Login Error: ' + error.message);
		}
	}

	private async handleApplyDiff(diff: any) {
		try {
			let document = vscode.window.activeTextEditor?.document;
			
			if (diff.target_file) {
				let targetPath = diff.target_file;

				// GAP-7 fix: In Cloud mode, strip VPS workspace prefix
				// e.g. "/var/agent-workspaces/default/user_1/app.py" → "app.py"
				if (this._currentMode === 'cloud') {
					const vpsPrefix = /^\/var\/agent-workspaces\/[^/]+\/user_\d+\//;
					if (vpsPrefix.test(targetPath)) {
						targetPath = targetPath.replace(vpsPrefix, '');
					}
				}

				let targetUri: vscode.Uri | undefined;
				
				if (targetPath.startsWith('/') || targetPath.match(/^[a-zA-Z]:\\/)) {
					targetUri = vscode.Uri.file(targetPath);
				} else {
					const workspaceFolders = vscode.workspace.workspaceFolders;
					if (workspaceFolders && workspaceFolders.length > 0) {
						targetUri = vscode.Uri.joinPath(workspaceFolders[0].uri, targetPath);
					}
				}

				if (targetUri) {
					document = await vscode.workspace.openTextDocument(targetUri);
					await vscode.window.showTextDocument(document);
				}
			}

			if (!document) {
				vscode.window.showErrorMessage('Agent: No active text editor or valid target file found to apply diff.');
				return;
			}

			const edit = new vscode.WorkspaceEdit();
			
			if (diff.replacement_content && typeof diff.start_line === 'number' && typeof diff.end_line === 'number') {
				const lineCount = document.lineCount;
				const startLine = Math.max(0, diff.start_line - 1);
				let endLine = Math.min(lineCount, diff.end_line);

				let endPosition: vscode.Position;
				if (endLine < lineCount) {
					endPosition = new vscode.Position(endLine, 0);
				} else {
					endPosition = document.lineAt(lineCount - 1).range.end;
				}

				const range = new vscode.Range(
					new vscode.Position(startLine, 0),
					endPosition
				);
				
				let replacement = diff.replacement_content;
				if (!replacement.endsWith('\n') && endLine < lineCount) {
					replacement += '\n';
				}

				edit.replace(document.uri, range, replacement);
			} else if (diff.code_content) {
				const fullRange = new vscode.Range(
					document.positionAt(0),
					document.positionAt(document.getText().length)
				);
				edit.replace(document.uri, fullRange, diff.code_content);
			} else {
				vscode.window.showWarningMessage('Agent: Unrecognized diff format. Could not apply.');
				return;
			}

			const success = await vscode.workspace.applyEdit(edit);
			if (success) {
				vscode.window.showInformationMessage('Agent: Code changes applied successfully.');
			} else {
				vscode.window.showErrorMessage('Agent: Failed to apply code changes to the workspace.');
			}
		} catch (error: any) {
			vscode.window.showErrorMessage('Agent Error applying diff: ' + error.message);
		}
	}

	// ── User Input Handling (mode-aware) ─────────────────────────────

	private async handleUserInput(text: string, conversationId?: string, attachments?: any[]) {
		if (!this._view) return;

		if (this._currentMode === 'local') {
			await this._handleUserInput_Local(text, conversationId, attachments);
		} else {
			await this._handleUserInput_Cloud(text, conversationId, attachments);
		}
	}

	// ── LOCAL SERVER MODE (WebSocket + bidirectional tools) ──────────

	private async _handleUserInput_Local(text: string, conversationId?: string, attachments?: any[]) {
		if (!this._view) return;

		const authToken = await this._context.secrets.get(ChatViewProvider.TOKEN_KEY);
		if (!authToken) {
			this._view.webview.postMessage({ type: 'require_login' });
			return;
		}

		// Tell webview we are thinking
		this._view.webview.postMessage({ type: 'thinking', context: {} });

		try {
			// Ensure WebSocket is connected
			if (!this._wsClient || !this._wsClient.isConnected) {
				const apiUrl = this.getApiUrl();
				// Carry the tenant on the WS handshake (same X-Tenant-Domain the HTTP
				// calls send) so the server binds the right tenant DB — without it the
				// connection falls back to the default tenant.
				this._wsClient = new WebSocketClient(apiUrl, authToken, this.getTenantDomain());

				// Set up event handler
				this._wsClient.onEvent((event: any) => {
					this._handleWsEvent(event);
				});

				// JWT expiry on the socket: try a refresh-token renewal first;
				// only force re-login if that fails.
				this._wsClient.onAuthExpired(async () => {
					this._wsClient?.disconnect();
					this._wsClient = null;
					const newToken = await this.tryRefreshToken();
					if (newToken) {
						vscode.window.showInformationMessage('Agent: Session renewed. Please resend your message.');
					} else {
						await this.forceReLogin('Agent: Session expired. Please sign in again.');
					}
				});

				await this._wsClient.connect();
			}

			// Send the chat message (+ inline attachments) via WebSocket
			this._wsClient.sendChat(text, conversationId, attachments);

		} catch (error: any) {
			vscode.window.showErrorMessage('Agent WebSocket Error: ' + error.message);
			this._view.webview.postMessage({
				type: 'agent_response',
				text: `**Error:** Failed to connect via WebSocket. (${error.message})`,
				isNew: true
			});
		}
	}

	/**
	 * Fetch a generated media file's bytes (authenticated) and forward a
	 * renderable data URI to the webview (the webview can't call the API itself).
	 */
	private async _fetchArtifact(fileId: number, kind?: string, mediaType?: string) {
		if (!this._view || fileId == null) return;
		try {
			const authToken = await this._context.secrets.get(ChatViewProvider.TOKEN_KEY);
			const base = this.getApiUrl().replace(/\/$/, '');
			const res = await fetch(`${base}/v1/media/${fileId}`, {
				headers: {
					'Authorization': `Bearer ${authToken}`,
					'X-Tenant-Domain': this.getTenantDomain(),
				},
			});
			if (!res.ok) { return; }
			const buf = Buffer.from(await res.arrayBuffer());
			const mt = mediaType || res.headers.get('content-type') || 'image/png';
			const dataUri = `data:${mt};base64,${buf.toString('base64')}`;
			this._view.webview.postMessage({ type: 'artifact', kind: kind || 'image', mediaType: mt, dataUri });
		} catch {
			/* best-effort — a failed media fetch never breaks the turn */
		}
	}

	/**
	 * Handle incoming WebSocket events and forward to webview UI.
	 */
	private _handleWsEvent(event: any) {
		if (!this._view) return;

		const eventType = event.event;

		switch (eventType) {
			case 'thinking.delta':
				// Reasoning ("thinking") delta — rendered in a separate
				// collapsible block, distinct from the answer.
				this._view.webview.postMessage({
					type: 'thinking_delta',
					text: event.content || '',
				});
				break;

			case 'message.delta':
				this._view.webview.postMessage({
					type: 'agent_response',
					text: event.content || '',
					isNew: false, // Will be set correctly by webview
				});
				break;

			case 'tool.start':
				this._view.webview.postMessage({
					type: 'agent_response',
					text: '',
					isNew: false,
					tool_calls: [{ name: event.toolName, args: event.toolArgs, status: 'running' }]
				});
				break;

			case 'tool.end':
				this._view.webview.postMessage({
					type: 'agent_response',
					text: '',
					isNew: false,
					tool_calls: [{ name: event.toolName, status: 'completed' }]
				});
				break;

			case 'message.end':
				this._view.webview.postMessage({
					type: 'agent_response_end',
					conversationId: event.conversationId,
					conversationTokens: event.conversationTokens,
					conversationCostUsd: event.conversationCostUsd,
				});
				break;

			case 'message.start':
				// First event — mark next delta as new message
				this._view.webview.postMessage({
					type: 'agent_response',
					text: '',
					isNew: true,
				});
				break;

			case 'artifact':
				// Part 2 — model generated media. Fetch the bytes (authed) and
				// hand the webview a renderable data URI.
				this._fetchArtifact(event.fileId, event.kind, event.mediaType);
				break;

			case 'warning':
				this._view.webview.postMessage({ type: 'warning', message: event.message || '' });
				break;

			case 'plan':
				this._view.webview.postMessage({
					type: 'plan_update',
					steps: event.steps || [],
				});
				break;

			case 'citations':
				this._view.webview.postMessage({
					type: 'citations_update',
					sources: event.sources || [],
				});
				break;

			case 'activity':
				this._view.webview.postMessage({
					type: 'activity',
					label: event.label || '',
				});
				break;

			case 'error':
				this._view.webview.postMessage({
					type: 'agent_response',
					text: `**Error:** ${event.message}`,
					isNew: true,
				});
				break;

			case 'done':
				// Stream complete
				break;
		}
	}

	// ── CLOUD SERVER MODE (HTTP SSE, identical to web chat) ──────────

	private async _uploadAttachments(attachments?: any[]): Promise<number[]> {
		const ids: number[] = [];
		if (!attachments || !attachments.length) { return ids; }
		const authToken = await this._context.secrets.get(ChatViewProvider.TOKEN_KEY);
		const base = this.getApiUrl().replace(/\/$/, '');
		for (const a of attachments) {
			try {
				const buf = Buffer.from(a.dataB64, 'base64');
				const fd = new FormData();
				fd.append('file', new Blob([buf], { type: a.mediaType || 'application/octet-stream' }), a.fileName || 'file');
				const res = await fetch(`${base}/v1/files`, {
					method: 'POST',
					headers: { 'Authorization': `Bearer ${authToken}`, 'X-Tenant-Domain': this.getTenantDomain() },
					body: fd as any,
				});
				if (res.ok) { const j: any = await res.json(); if (j.fileId != null) { ids.push(j.fileId); } }
			} catch { /* skip a failed upload */ }
		}
		return ids;
	}

	private async _handleUserInput_Cloud(text: string, conversationId?: string, attachments?: any[]) {
		if (!this._view) return;

		// 1. Resolve context
		const workspaceFolders = vscode.workspace.workspaceFolders;
		const workspaceRoot = workspaceFolders && workspaceFolders.length > 0 ? workspaceFolders[0].uri.fsPath : 'None';
		
		let contextStr = `\n\n<agent_context>\n`;
		contextStr += `[Workspace Root: ${workspaceRoot}]\n`;
		// BUG-3 fix: In Cloud mode, tell agent about the sandbox workspace
		if (this._currentMode === 'cloud') {
			contextStr += `[Mode: Cloud — file operations run on VPS sandbox, NOT local machine]\n`;
			contextStr += `[Use relative paths for file operations — they resolve to your VPS workspace]\n`;
		}

		const visibleEditors = vscode.window.visibleTextEditors.filter(e => e.document.uri.scheme === 'file');
		let contextData: any = { files: [], hasSelection: false };
		
		if (visibleEditors.length > 0) {
			contextStr += `[Open Files:]\n`;
			for (const editor of visibleEditors) {
				const relativePath = vscode.workspace.asRelativePath(editor.document.uri, false);
				contextStr += `- ${relativePath}\n`;
				contextData.files.push(relativePath);
			}
		}

		const activeEditor = vscode.window.activeTextEditor;
		if (activeEditor && activeEditor.document.uri.scheme === 'file') {
			const activeRelative = vscode.workspace.asRelativePath(activeEditor.document.uri, false);
			contextStr += `\n[Active File: ${activeRelative}]\n`;
			
			const selection = activeEditor.selection;
			const selectedText = activeEditor.document.getText(selection);
			if (selectedText) {
				contextStr += `[Selected Text in ${activeRelative}:]\n\`\`\`\n${selectedText}\n\`\`\`\n`;
				contextData.hasSelection = true;
			}
		}
		contextStr += `</agent_context>\n`;

		this._view.webview.postMessage({ 
			type: 'thinking',
			context: contextData 
		});

		try {
			const fullText = text + contextStr;
			const attachmentIds = await this._uploadAttachments(attachments);

			// authedFetch attaches the Bearer token and transparently refreshes
			// on a 401, so a streaming chat survives an expired access token.
			const response = await this.authedFetch('/v1/chat', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					message: fullText || ' ',
					stream: true,
					conversation_id: conversationId,
					attachmentIds: attachmentIds.length ? attachmentIds : undefined,
				})
			});

			if (!response) {
				return; // re-login already requested
			}

			if (!response.ok) {
				throw new Error(`API returned ${response.status} ${response.statusText}`);
			}

			// SSE Parsing (existing Cloud mode logic)
			const reader = response.body?.getReader();
			const decoder = new TextDecoder();
			let isNew = true;
			let buffer = '';

			if (reader) {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					
					buffer += decoder.decode(value, { stream: true });
					const lines = buffer.split('\n');
					buffer = lines.pop() || '';

					for (const line of lines) {
						const trimmed = line.trim();
						if (!trimmed.startsWith('data: ')) continue;
						
						const dataStr = trimmed.slice(6).trim();
						if (dataStr === '[DONE]') break;

						try {
							const data = JSON.parse(dataStr);
							
							if (data.event === 'message.delta') {
								this._view.webview.postMessage({ 
									type: 'agent_response', 
									text: data.content || '',
									isNew: isNew
								});
								isNew = false;
							} else if (data.event === 'tool.start') {
								this._view.webview.postMessage({
									type: 'agent_response',
									text: '',
									isNew: isNew,
									tool_calls: [{ name: data.toolName, args: data.toolArgs, status: 'running' }]
								});
								isNew = false;
							} else if (data.event === 'tool.end') {
								this._view.webview.postMessage({
									type: 'agent_response',
									text: '',
									isNew: isNew,
									tool_calls: [{ name: data.toolName, args: data.toolArgs, status: 'completed' }]
								});
								isNew = false;
							} else if (data.event === 'message.end') {
								this._view.webview.postMessage({
									type: 'agent_response_end',
									conversationId: data.conversationId,
									conversationTokens: data.conversationTokens,
									conversationCostUsd: data.conversationCostUsd,
								});
							} else if (data.event === 'plan') {
								this._view.webview.postMessage({ type: 'plan_update', steps: data.steps || [] });
							} else if (data.event === 'artifact') {
								this._fetchArtifact(data.fileId, data.kind, data.mediaType);
							} else if (data.event === 'warning') {
								this._view.webview.postMessage({ type: 'warning', message: data.message || '' });
							} else if (data.event === 'citations') {
								this._view.webview.postMessage({ type: 'citations_update', sources: data.sources || [] });
							} else if (data.event === 'approval.request') {
								this._view.webview.postMessage({
									type: 'approval_request',
									approvalId: data.approvalId,
									toolName: data.toolName,
									toolArgs: data.toolArgs || {},
									timeout_s: data.timeout_s || 300,
								});
							} else if (data.event === 'activity') {
								this._view.webview.postMessage({
									type: 'activity',
									label: data.label || '',
								});
							}
						} catch (e) {
							console.warn('Failed to parse SSE data:', dataStr);
						}
					}
				}
			} else {
				const data: any = await response.json();
				this._view.webview.postMessage({ 
					type: 'agent_response', 
					text: data.reply || 'No reply from agent.',
					isNew: true
				});
			}
		} catch (error: any) {
			vscode.window.showErrorMessage('Agent API Error: ' + error.message);
			this._view.webview.postMessage({ 
				type: 'agent_response', 
				text: `**Error:** Failed to connect to Agent backend. (${error.message})`,
				isNew: true
			});
		}
	}

	private _getHtmlForWebview(webview: vscode.Webview) {
		const version = Date.now().toString();
		let scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'webview-ui', 'dist', 'assets', 'index.js'));
		let styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'webview-ui', 'dist', 'assets', 'index.css'));
		
		scriptUri = scriptUri.with({ query: `v=${version}` });
		styleUri = styleUri.with({ query: `v=${version}` });

		const nonce = getNonce();

		return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource}; img-src ${webview.cspSource} https: data:; font-src ${webview.cspSource} data:; connect-src ${webview.cspSource};">
				<title>Agent</title>
				<link rel="stylesheet" crossorigin href="${styleUri}">
			</head>
			<body>
				<div id="root"></div>
				<script type="module" nonce="${nonce}" src="${scriptUri}"></script>
			</body>
			</html>`;
	}
}

function getNonce() {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}
