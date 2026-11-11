/**
 * LocalToolExecutor — Executes agent tools locally on the user's machine.
 * 
 * Used in VS Code "Local Server" mode. When the VPS agent sends a tool_request,
 * this executor runs it using Node.js fs/child_process and VS Code APIs.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as child_process from 'child_process';
import * as os from 'os';

export class LocalToolExecutor {
	private workspaceRoot: string;

	constructor() {
		const folders = vscode.workspace.workspaceFolders;
		this.workspaceRoot = folders && folders.length > 0 ? folders[0].uri.fsPath : os.homedir();
	}

	/**
	 * Execute a tool locally and return the result as a string.
	 */
	async execute(toolName: string, toolArgs: Record<string, any>): Promise<string> {
		try {
			switch (toolName) {
				case 'view_file':
					return this.viewFile(toolArgs);
				case 'write_to_file':
					return this.writeToFile(toolArgs);
				case 'list_dir':
					return this.listDir(toolArgs);
				case 'grep_search':
					return this.grepSearch(toolArgs);
				case 'replace_file_content':
					return this.replaceFileContent(toolArgs);
				case 'multi_replace_file_content':
					return this.multiReplaceFileContent(toolArgs);
				case 'run_command':
					return await this.runCommand(toolArgs);
				case 'ask_question':
					return await this.askQuestion(toolArgs);
				default:
					return `Error: Unknown local tool '${toolName}'`;
			}
		} catch (e: any) {
			return `Error executing ${toolName}: ${e.message}`;
		}
	}

	// ── view_file ──────────────────────────────────────────────────────

	private viewFile(args: Record<string, any>): string {
		const filePath = this.resolvePath(args.absolute_path);
		if (!fs.existsSync(filePath)) {
			return `Error: File not found: ${filePath}`;
		}
		const stat = fs.statSync(filePath);
		if (stat.isDirectory()) {
			return `Error: ${filePath} is a directory. Use list_dir instead.`;
		}

		const content = fs.readFileSync(filePath, 'utf-8');
		const allLines = content.split('\n');
		const totalLines = allLines.length;

		let startLine = args.start_line ? Math.max(1, args.start_line) : 1;
		let endLine = args.end_line ? Math.min(totalLines, args.end_line) : totalLines;

		// Cap at 800 lines
		if (endLine - startLine + 1 > 800) {
			endLine = startLine + 799;
		}

		const lines = allLines.slice(startLine - 1, endLine);
		const numbered = lines.map((line, i) => `${startLine + i}: ${line}`);

		const header = `File: ${filePath} | Total: ${totalLines} lines | Showing: ${startLine}-${endLine}`;
		return header + '\n' + numbered.join('\n');
	}

	// ── write_to_file ──────────────────────────────────────────────────

	private writeToFile(args: Record<string, any>): string {
		const filePath = this.resolvePath(args.target_file);
		if (fs.existsSync(filePath) && !args.overwrite) {
			return `Error: ${filePath} already exists. Set overwrite=true to replace.`;
		}
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, args.code_content, 'utf-8');
		const lineCount = (args.code_content || '').split('\n').length;
		return `Successfully wrote ${lineCount} lines to ${filePath}`;
	}

	// ── list_dir ────────────────────────────────────────────────────────

	private listDir(args: Record<string, any>): string {
		const dirPath = this.resolvePath(args.directory_path);
		if (!fs.existsSync(dirPath)) {
			return `Error: Directory not found: ${dirPath}`;
		}
		if (!fs.statSync(dirPath).isDirectory()) {
			return `Error: ${dirPath} is a file, not a directory.`;
		}

		const items = fs.readdirSync(dirPath).sort();
		const dirs: string[] = [];
		const files: string[] = [];
		const skip = new Set(['.git', '.DS_Store', '__pycache__', '.ag_data', 'node_modules']);

		for (const item of items) {
			if (skip.has(item)) continue;
			const full = path.join(dirPath, item);
			try {
				const st = fs.statSync(full);
				if (st.isDirectory()) {
					let children = -1;
					try { children = fs.readdirSync(full).length; } catch { }
					dirs.push(`  ${item}/ (${children} children)`);
				} else {
					const size = st.size;
					const sizeStr = size < 1024 ? `${size}B` :
						size < 1048576 ? `${(size / 1024).toFixed(1)}KB` :
							`${(size / 1048576).toFixed(1)}MB`;
					files.push(`  ${item} (${sizeStr})`);
				}
			} catch {
				files.push(`  ${item} (unreadable)`);
			}
		}

		const output = [`Directory: ${dirPath}`];
		if (dirs.length) { output.push(`Directories (${dirs.length}):`); output.push(...dirs); }
		if (files.length) { output.push(`Files (${files.length}):`); output.push(...files); }
		if (!dirs.length && !files.length) { output.push('(empty)'); }
		return output.join('\n');
	}

	// ── grep_search ─────────────────────────────────────────────────────

	private grepSearch(args: Record<string, any>): string {
		const searchPath = this.resolvePath(args.search_path);
		if (!fs.existsSync(searchPath)) {
			return `Error: Path not found: ${searchPath}`;
		}

		const query = args.query || '';
		const isRegex = args.is_regex || false;
		const caseInsensitive = args.case_insensitive || false;
		const includes = args.includes || [];

		// Use execFileSync to prevent shell injection (BUG-4 fix)
		try {
			const grepArgs: string[] = ['-rn'];
			if (caseInsensitive) grepArgs.push('-i');

			// Handle includes (can be array or comma-separated string)
			const includeList = Array.isArray(includes) ? includes : 
				(typeof includes === 'string' && includes ? includes.split(',') : []);
			for (const glob of includeList) {
				grepArgs.push(`--include=${glob.trim()}`);
			}

			// Exclude common dirs
			grepArgs.push('--exclude-dir=.git', '--exclude-dir=node_modules', 
				'--exclude-dir=__pycache__', '--exclude-dir=.ag_data');

			if (isRegex) {
				grepArgs.push('-E', query);
			} else {
				grepArgs.push('-F', query);
			}
			grepArgs.push(searchPath);

			const result = child_process.execFileSync('grep', grepArgs, {
				encoding: 'utf-8',
				maxBuffer: 1024 * 1024,
				timeout: 30000,
			}).trim();

			if (!result) return 'No matches found.';

			const lines = result.split('\n').slice(0, 50);
			const header = `Found ${lines.length} matches${lines.length >= 50 ? ' (capped at 50)' : ''}`;
			return header + ':\n' + lines.join('\n');
		} catch (e: any) {
			if (e.status === 1) return 'No matches found.';
			return `Error in grep: ${e.message}`;
		}
	}

	// ── replace_file_content ────────────────────────────────────────────

	private replaceFileContent(args: Record<string, any>): string {
		const filePath = this.resolvePath(args.target_file);
		if (!fs.existsSync(filePath)) {
			return `Error: File not found: ${filePath}`;
		}
		let content = fs.readFileSync(filePath, 'utf-8');
		const target = args.target_content || '';
		const replacement = args.replacement_content || '';
		const allowMultiple = args.allow_multiple || false;
		const startLine = args.start_line ? Math.max(1, args.start_line) : undefined;
		const endLine = args.end_line ? args.end_line : undefined;

		// If start_line/end_line provided, search only within that range
		if (startLine && endLine) {
			const lines = content.split('\n');
			const before = lines.slice(0, startLine - 1).join('\n');
			const section = lines.slice(startLine - 1, endLine).join('\n');
			const after = lines.slice(endLine).join('\n');

			if (!section.includes(target)) {
				return `Error: target_content not found within lines ${startLine}-${endLine}.`;
			}

			const occurrences = section.split(target).length - 1;
			if (occurrences > 1 && !allowMultiple) {
				return `Error: target_content found ${occurrences} times in range. Set allow_multiple=true or narrow the range.`;
			}

			const newSection = allowMultiple 
				? section.split(target).join(replacement)
				: section.replace(target, replacement);

			content = [before, newSection, after].filter(s => s !== '').join('\n');
		} else {
			// No line range — global search
			const count = content.split(target).length - 1;
			if (count === 0) return 'Error: target_content not found in file.';
			if (count > 1 && !allowMultiple) {
				return `Error: target_content found ${count} times. Use start_line/end_line to disambiguate or set allow_multiple=true.`;
			}

			content = allowMultiple
				? content.split(target).join(replacement)
				: content.replace(target, replacement);
		}

		fs.writeFileSync(filePath, content, 'utf-8');
		return `Successfully replaced content in ${filePath}`;
	}

	// ── multi_replace_file_content ──────────────────────────────────────

	private multiReplaceFileContent(args: Record<string, any>): string {
		const filePath = this.resolvePath(args.target_file);
		if (!fs.existsSync(filePath)) {
			return `Error: File not found: ${filePath}`;
		}

		// BUG-1 fix: Agent sends 'replacement_chunks' with 'target_content'/'replacement_content'
		let chunks: any[];
		const rawChunks = args.replacement_chunks || args.replacements;
		try {
			chunks = typeof rawChunks === 'string'
				? JSON.parse(rawChunks)
				: rawChunks;
		} catch (e: any) {
			return `Error: Invalid JSON in replacement_chunks: ${e.message}`;
		}

		if (!chunks || !Array.isArray(chunks) || chunks.length === 0) {
			return 'Error: No replacement chunks provided.';
		}

		let content = fs.readFileSync(filePath, 'utf-8');

		// Validate all chunks exist before applying
		for (let i = 0; i < chunks.length; i++) {
			const t = chunks[i].target_content || chunks[i].target || '';
			if (!content.includes(t)) {
				return `Error: Chunk ${i} target_content not found in file.`;
			}
		}

		// Apply in reverse position order to preserve indices
		const positions = chunks.map((c) => ({
			pos: content.indexOf(c.target_content || c.target || ''),
			chunk: c
		}));
		positions.sort((a, b) => b.pos - a.pos);

		for (const { chunk } of positions) {
			const target = chunk.target_content || chunk.target || '';
			const replacement = chunk.replacement_content || chunk.replacement || '';
			content = content.replace(target, replacement);
		}

		fs.writeFileSync(filePath, content, 'utf-8');
		return `Successfully applied ${chunks.length} replacements to ${filePath}`;
	}

	// ── run_command ──────────────────────────────────────────────────────

	private static readonly MAX_OUTPUT_LINES = 100;

	private async runCommand(args: Record<string, any>): Promise<string> {
		const cwd = this.resolvePath(args.cwd || this.workspaceRoot);
		const cmd = args.command_line || '';
		const timeoutMs = args.wait_ms_before_async || 30000;

		// Block interactive commands
		if (/(?:^|[\s|;&])(nano|vim|vi|emacs|less|more|htop|top)(?:\s|$)/.test(cmd)) {
			return `Error: Interactive command not supported.`;
		}

		try {
			const result = child_process.execSync(cmd, {
				cwd,
				encoding: 'utf-8',
				maxBuffer: 1024 * 1024,
				timeout: Math.min(timeoutMs, 120000),
				env: { ...process.env, PAGER: 'cat', GIT_PAGER: 'cat' },
			});
			return this.truncateOutput(result.trim()) || 'Command completed with no output.';
		} catch (e: any) {
			if (e.stdout || e.stderr) {
				const combined = ((e.stdout || '') + '\n' + (e.stderr || '')).trim();
				return this.truncateOutput(combined);
			}
			return `Error: ${e.message}`;
		}
	}

	/**
	 * Truncate output to MAX_OUTPUT_LINES to prevent token exhaustion.
	 * Large command output sent via WebSocket → agent prompt can exhaust context.
	 */
	private truncateOutput(output: string): string {
		const lines = output.split('\n');
		if (lines.length <= LocalToolExecutor.MAX_OUTPUT_LINES) {
			return output;
		}
		const head = lines.slice(0, LocalToolExecutor.MAX_OUTPUT_LINES);
		const omitted = lines.length - LocalToolExecutor.MAX_OUTPUT_LINES;
		return head.join('\n') + `\n\n... (${omitted} lines omitted, showing first ${LocalToolExecutor.MAX_OUTPUT_LINES})`;
	}

	// ── ask_question ────────────────────────────────────────────────────

	private async askQuestion(args: Record<string, any>): Promise<string> {
		const answer = await vscode.window.showInputBox({
			prompt: args.question || 'Agent is asking:',
			placeHolder: 'Type your answer...',
		});
		return answer || '(User did not answer)';
	}

	// ── Path Resolution ─────────────────────────────────────────────────

	private resolvePath(p: string): string {
		if (!p) return this.workspaceRoot;
		if (path.isAbsolute(p)) return p;
		return path.resolve(this.workspaceRoot, p);
	}
}
