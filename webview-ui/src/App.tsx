import { useState, useRef, useEffect, memo } from 'react'
import {
  History, LogOut, Sparkles, Bot, Monitor, Cloud, ChevronDown, ChevronRight,
  Check, Copy, Trash2, MessageSquarePlus, FileCode, Loader2, Wrench, ShieldAlert,
  ShieldCheck, ShieldX, Gauge, X, ArrowUp, Paperclip, FileText,
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import 'highlight.js/styles/github-dark-dimmed.css'

// ── IDE bridge (VS Code + Visual Studio WebView2) ───────────────────────────
// @ts-ignore
const vscodeApi = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
const ideBridge = {
  postMessage: (message: any) => {
    if (vscodeApi) vscodeApi.postMessage(message);
    else if ((window as any).chrome?.webview?.postMessage) (window as any).chrome.webview.postMessage(message);
  },
  getState: () => (vscodeApi ? vscodeApi.getState() : undefined),
  setState: (state: any) => { if (vscodeApi) vscodeApi.setState(state); },
  isAvailable: () => !!vscodeApi || !!(window as any).chrome?.webview,
};

// ── Formatting helpers ──────────────────────────────────────────────────────
const formatTokens = (n: number): string => {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
};
const formatCost = (usd: number): string => {
  if (!usd || usd <= 0) return '';
  if (usd < 0.01) return '<$0.01';
  return '$' + usd.toFixed(usd < 1 ? 3 : 2);
};
function cleanContent(content: string): string {
  if (!content) return '';
  return content.replace(/<antigravity_context>[\s\S]*?<\/antigravity_context>/gi, '').trim();
}

// ── Types ───────────────────────────────────────────────────────────────────
type BrainSource = { title: string; documentId?: string; type?: string; sourcePath?: string; snippet?: string }
type ToolCall = { name: string; args: any; status: 'running' | 'completed' }
// Attachment shown in a bubble (dataUri renders inline); the wire form sent to
// the host carries dataB64 + mediaType.
type Attachment = { kind: string; dataUri?: string; fileName?: string }
type PendingAtt = { kind: string; mediaType: string; fileName: string; dataB64: string; dataUri: string }
type Message = {
  id: string
  role: 'user' | 'assistant'
  content?: string
  thinking?: string
  tool_calls?: ToolCall[]
  context?: { files: string[]; hasSelection: boolean }
  sources?: BrainSource[]
  attachments?: Attachment[]
}
type PendingApproval = { approvalId: string; toolName: string; toolArgs: any; timeout_s: number }
type Conversation = {
  conversationId: string; title: string | null; messageCount: number
  source: string; createdAt: string; updatedAt: string
}

const initialState = ideBridge.getState();
const welcomeMessages: Message[] = [
  { id: '1', role: 'assistant', content: '' },
];
const initialMessages: Message[] = initialState?.messages || welcomeMessages;
const isWelcomeOnly = (msgs: Message[]) => msgs.length <= 1 && msgs[0]?.id === '1';

const SUGGESTIONS = [
  'Explain the file I have open',
  'Find and fix a bug in this project',
  'Write unit tests for the selected code',
];

// ── Markdown code block (syntax highlighting + copy) ────────────────────────
const CodeBlock = ({ children, className }: any) => {
  const [copied, setCopied] = useState(false);
  const codeText = String(children).replace(/\n$/, '');
  const match = /language-(\w+)/.exec(className || '');
  const language = match ? match[1] : 'code';
  const copy = () => {
    navigator.clipboard.writeText(codeText);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };
  return (
    <div className="relative group/code my-3 rounded-lg overflow-hidden border border-[var(--kendo-color-border)] max-w-full">
      <div className="flex items-center justify-between px-3 py-1.5 bg-[var(--kendo-color-base)] border-b border-[var(--kendo-color-border)]">
        <span className="text-[10px] font-medium tracking-wide text-[var(--kendo-color-on-app-surface)] opacity-50 lowercase">{language}</span>
        <button onClick={copy} title="Copy"
          className="flex items-center gap-1 text-[11px] opacity-50 hover:opacity-100 transition-opacity">
          {copied ? <Check className="w-3 h-3 text-[var(--kendo-color-success)]" /> : <Copy className="w-3 h-3" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className={`!m-0 !rounded-none !bg-[var(--kendo-color-app-surface)] overflow-x-auto max-w-full text-[12.5px] leading-relaxed ${className || ''}`}>
        <code>{children}</code>
      </pre>
    </div>
  );
};

// Syntax highlighting is a FINALIZE-time concern: running rehype-highlight over
// the whole (growing) message on every streamed token is O(n²) on the single
// webview thread and freezes the UI ("not responding"). While a message is
// still streaming we render cheap markdown (no highlight); once done we do the
// full highlight pass once. memo() also stops completed messages from
// re-rendering on every delta of the active one.
const MarkdownInner = ({ text, highlight }: { text: string; highlight: boolean }) => (
  <div className="text-[13.5px] leading-relaxed min-w-0 max-w-full break-words
    prose prose-sm
    [--tw-prose-body:var(--kendo-color-on-app-surface)]
    [--tw-prose-headings:var(--kendo-color-on-app-surface)]
    [--tw-prose-bold:var(--kendo-color-on-app-surface)]
    [--tw-prose-quotes:var(--kendo-color-on-app-surface)]
    [--tw-prose-bullets:var(--kendo-color-border)]
    [--tw-prose-counters:var(--kendo-color-on-app-surface)]
    [--tw-prose-hr:var(--kendo-color-border)]
    [--tw-prose-quote-borders:var(--kendo-color-border)]
    [--tw-prose-th-borders:var(--kendo-color-border)]
    [--tw-prose-td-borders:var(--kendo-color-border)]
    prose-p:my-2 prose-headings:mt-3 prose-headings:mb-1.5 prose-headings:break-words
    prose-pre:my-0 prose-pre:bg-transparent prose-pre:p-0 prose-pre:border-0
    prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5
    prose-code:break-words prose-a:text-[var(--kendo-color-primary)] prose-a:no-underline hover:prose-a:underline">
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={highlight ? [rehypeHighlight] : []}
      components={{
        code({ inline, className, children, ...props }: any) {
          const isBlock = !inline && /language-(\w+)/.test(className || '');
          if (isBlock) return <CodeBlock className={className}>{children}</CodeBlock>;
          return (
            <code className="px-1.5 py-0.5 mx-0.5 rounded bg-[var(--kendo-color-base)] border border-[var(--kendo-color-border)] text-[12.5px] break-words" {...props}>
              {children}
            </code>
          );
        },
      }}
    >
      {cleanContent(text)}
    </ReactMarkdown>
  </div>
);
// Re-render only when the text or the highlight flag actually changes.
const Markdown = memo(MarkdownInner,
  (a, b) => a.text === b.text && a.highlight === b.highlight);

// ── Collapsible "Thinking" (reasoning) ──────────────────────────────────────
const ThinkingBlock = ({ thinking, done }: { thinking: string; done: boolean }) => {
  const [open, setOpen] = useState(!done);
  useEffect(() => { if (done) setOpen(false); }, [done]);
  return (
    <div className="mb-2 rounded-lg border border-[var(--kendo-color-border)] bg-[var(--kendo-color-base)]/40 overflow-hidden">
      <button onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] font-medium text-[var(--kendo-color-on-app-surface)] opacity-60 hover:opacity-90 transition-opacity select-none">
        <Sparkles className="w-3 h-3 text-[var(--kendo-color-primary)]" />
        <span>{done ? 'Thought process' : 'Thinking…'}</span>
        <ChevronDown className={`w-3 h-3 ml-auto transition-transform ${open ? '' : '-rotate-90'}`} />
      </button>
      {open && (
        <div className="px-3 pb-2.5 pt-0.5 text-[12px] leading-relaxed text-[var(--kendo-color-on-app-surface)] opacity-70 whitespace-pre-wrap font-mono max-h-64 overflow-y-auto break-words custom-scrollbar">
          {thinking}
        </div>
      )}
    </div>
  );
};

// ── Quiet tool disclosure (latest tool + count, expandable args) ────────────
const ToolDisclosure = ({ tools }: { tools: ToolCall[] }) => {
  const [open, setOpen] = useState(false);
  if (!tools.length) return null;
  const latest = tools[tools.length - 1];
  const running = tools.some(t => t.status === 'running');
  return (
    <div className="my-2 rounded-lg border border-[var(--kendo-color-border)] bg-[var(--kendo-color-base)]/50 overflow-hidden max-w-full">
      <button onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] hover:bg-[var(--kendo-color-base)] transition-colors select-none">
        {running
          ? <Loader2 className="w-3.5 h-3.5 text-[var(--kendo-color-primary)] animate-spin flex-none" />
          : <Wrench className="w-3.5 h-3.5 text-[var(--kendo-color-on-app-surface)] opacity-50 flex-none" />}
        <span className="font-medium text-[var(--kendo-color-on-app-surface)] opacity-80 truncate">
          {running ? 'Using' : 'Used'} <span className="font-mono">{latest.name}</span>
        </span>
        {tools.length > 1 && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--kendo-color-base)] border border-[var(--kendo-color-border)] opacity-70 flex-none">
            {tools.length}
          </span>
        )}
        <ChevronDown className={`w-3 h-3 ml-auto opacity-50 transition-transform flex-none ${open ? '' : '-rotate-90'}`} />
      </button>
      {open && (
        <div className="px-3 pb-2.5 pt-1 space-y-2 border-t border-[var(--kendo-color-border)]">
          {tools.map((t, i) => (
            <div key={i} className="text-[11px]">
              <div className="flex items-center gap-1.5 text-[var(--kendo-color-on-app-surface)] opacity-70 font-mono">
                {t.status === 'running'
                  ? <Loader2 className="w-3 h-3 animate-spin" />
                  : <Check className="w-3 h-3 text-[var(--kendo-color-success)]" />}
                {t.name}
              </div>
              {t.args && Object.keys(t.args || {}).length > 0 && (
                <pre className="mt-1 p-2 rounded bg-[var(--kendo-color-app-surface)] border border-[var(--kendo-color-border)] overflow-x-auto max-w-full text-[10.5px] leading-relaxed opacity-80 custom-scrollbar">
                  {JSON.stringify(t.args, null, 2)}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ── Code suggestion (suggest_diff) with Apply Patch ─────────────────────────
const SuggestDiffCard = ({ tool }: { tool: ToolCall }) => {
  const patch = tool.args?.replacement_content || tool.args?.code_content || '';
  return (
    <div className="my-2 rounded-xl border border-[var(--kendo-color-border)] bg-[var(--kendo-color-base)]/50 overflow-hidden max-w-full">
      <div className="flex items-center justify-between px-3.5 py-2 border-b border-[var(--kendo-color-border)]">
        <span className="flex items-center gap-2 text-[12.5px] font-medium">
          <FileCode className="w-3.5 h-3.5 text-[var(--kendo-color-primary)]" /> Code suggestion
        </span>
        <button onClick={() => ideBridge.isAvailable() && ideBridge.postMessage({ type: 'apply_diff', diff: tool.args })}
          className="px-3 py-1 rounded-lg bg-[var(--kendo-color-primary)] text-white text-[11.5px] font-semibold hover:opacity-90 active:scale-95 transition-all">
          Apply patch
        </button>
      </div>
      <pre className="m-0 p-3 text-[11.5px] leading-relaxed overflow-x-auto max-w-full whitespace-pre custom-scrollbar opacity-90">{patch}</pre>
    </div>
  );
};

// ── HITL approval card ──────────────────────────────────────────────────────
const ApprovalCard = ({ approval, onRespond }: {
  approval: PendingApproval; onRespond: (id: string, approved: boolean) => void;
}) => {
  const [open, setOpen] = useState(false);
  const argsStr = approval.toolArgs ? JSON.stringify(approval.toolArgs, null, 2) : null;
  return (
    <div className="my-3 rounded-xl border border-amber-500/30 bg-amber-500/[0.06] overflow-hidden max-w-full">
      <div className="flex items-center gap-2.5 px-4 pt-3 pb-1.5">
        <ShieldAlert className="w-4 h-4 text-amber-500 flex-none" />
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-amber-500">Approval required</div>
          <div className="text-[11px] opacity-60">The agent wants to run an irreversible action.</div>
        </div>
      </div>
      <div className="px-4 py-2 text-[12.5px]">
        <span className="opacity-70">Tool </span>
        <code className="px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/20 text-amber-600 dark:text-amber-300 font-mono text-[12px]">
          {approval.toolName}
        </code>
        {argsStr && (
          <div className="mt-1.5">
            <button onClick={() => setOpen(!open)}
              className="flex items-center gap-1 text-[11px] opacity-60 hover:opacity-100 transition-opacity">
              {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />} Arguments
            </button>
            {open && (
              <pre className="mt-1.5 p-2.5 rounded-lg bg-[var(--kendo-color-app-surface)] border border-[var(--kendo-color-border)] text-[11px] leading-relaxed overflow-auto max-h-44 max-w-full font-mono opacity-85 custom-scrollbar">
                {argsStr}
              </pre>
            )}
          </div>
        )}
      </div>
      <div className="flex gap-2 px-4 pb-3.5 pt-1">
        <button onClick={() => onRespond(approval.approvalId, true)}
          className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-[13px] font-semibold text-white bg-[var(--kendo-color-success)] hover:opacity-90 active:scale-[0.98] transition-all">
          <ShieldCheck className="w-4 h-4" /> Approve
        </button>
        <button onClick={() => onRespond(approval.approvalId, false)}
          className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-[13px] font-semibold text-[var(--kendo-color-error)] bg-[var(--kendo-color-error)]/10 border border-[var(--kendo-color-error)]/25 hover:bg-[var(--kendo-color-error)]/15 active:scale-[0.98] transition-all">
          <ShieldX className="w-4 h-4" /> Deny
        </button>
      </div>
    </div>
  );
};

// ── History panel ───────────────────────────────────────────────────────────
function groupConversationsByDate(conversations: Conversation[]): Record<string, Conversation[]> {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const lastWeek = new Date(today.getTime() - 7 * 86400000);
  const groups: Record<string, Conversation[]> = {};
  conversations.forEach(conv => {
    const date = new Date(conv.updatedAt || conv.createdAt);
    const label = date >= today ? 'Today' : date >= yesterday ? 'Yesterday' : date >= lastWeek ? 'Previous 7 days' : 'Older';
    (groups[label] ||= []).push(conv);
  });
  return groups;
}

const HistoryPanel = ({ conversations, activeConversationId, onSelect, onDelete, onNewChat, onClose, isLoading }: {
  conversations: Conversation[]; activeConversationId: string | null;
  onSelect: (id: string) => void; onDelete: (id: string) => void;
  onNewChat: () => void; onClose: () => void; isLoading: boolean;
}) => {
  const grouped = groupConversationsByDate(conversations);
  const order = ['Today', 'Yesterday', 'Previous 7 days', 'Older'];
  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-[var(--kendo-color-app-surface)] animate-slideIn">
      <div className="flex-none flex items-center justify-between px-4 h-12 border-b border-[var(--kendo-color-border)]">
        <div className="flex items-center gap-2 text-[13px] font-semibold">
          <History className="w-4 h-4 text-[var(--kendo-color-primary)]" /> Chat history
        </div>
        <div className="flex items-center gap-1">
          <button onClick={onNewChat} title="New chat"
            className="p-1.5 rounded-md text-[var(--kendo-color-primary)] hover:bg-[var(--kendo-color-base)] transition-colors">
            <MessageSquarePlus className="w-4 h-4" />
          </button>
          <button onClick={onClose} title="Close"
            className="p-1.5 rounded-md opacity-60 hover:opacity-100 hover:bg-[var(--kendo-color-base)] transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
        {isLoading ? (
          <div className="flex items-center justify-center py-16 opacity-60">
            <Loader2 className="w-5 h-5 animate-spin" />
          </div>
        ) : conversations.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 px-6 text-center opacity-60">
            <MessageSquarePlus className="w-8 h-8 mb-3 opacity-40" />
            <p className="text-[13px]">No conversations yet</p>
          </div>
        ) : (
          order.filter(l => grouped[l]?.length).map(label => (
            <div key={label} className="py-1">
              <div className="px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider opacity-40">{label}</div>
              {grouped[label].map(conv => {
                const active = conv.conversationId === activeConversationId;
                const title = conv.title || 'New conversation';
                return (
                  <div key={conv.conversationId} onClick={() => onSelect(conv.conversationId)}
                    className={`group flex items-center gap-3 px-4 py-2.5 cursor-pointer transition-colors min-w-0
                      ${active ? 'bg-[var(--kendo-color-primary)]/8 text-[var(--kendo-color-primary)]' : 'hover:bg-[var(--kendo-color-base)]'}`}>
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] truncate">{title}</div>
                      <div className="text-[10.5px] opacity-50 mt-0.5">{conv.messageCount} messages</div>
                    </div>
                    <button onClick={(e) => { e.stopPropagation(); onDelete(conv.conversationId); }}
                      title="Delete"
                      className="opacity-0 group-hover:opacity-100 p-1.5 rounded-md hover:bg-[var(--kendo-color-error)]/10 hover:text-[var(--kendo-color-error)] transition-all flex-none">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>
    </div>
  );
};

// ── Typing indicator ────────────────────────────────────────────────────────
const TypingDots = ({ label }: { label: string }) => (
  <div className="flex items-center gap-2.5 py-1 text-[12.5px] text-[var(--kendo-color-on-app-surface)] opacity-60">
    <div className="flex gap-1">
      <span className="w-1.5 h-1.5 rounded-full bg-[var(--kendo-color-primary)] animate-bounce [animation-delay:-0.3s]" />
      <span className="w-1.5 h-1.5 rounded-full bg-[var(--kendo-color-primary)] animate-bounce [animation-delay:-0.15s]" />
      <span className="w-1.5 h-1.5 rounded-full bg-[var(--kendo-color-primary)] animate-bounce" />
    </div>
    <span>{label || 'Thinking…'}</span>
  </div>
);

// ── Assistant avatar ────────────────────────────────────────────────────────
const AgentAvatar = ({ logoUrl }: { logoUrl?: string }) => (
  logoUrl
    ? <img src={logoUrl} alt="" className="w-6 h-6 rounded-md object-contain bg-white border border-[var(--kendo-color-border)] flex-none"
        onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
    : <div className="w-6 h-6 rounded-md bg-[var(--kendo-color-primary)]/12 border border-[var(--kendo-color-primary)]/20 flex items-center justify-center flex-none">
        <Sparkles className="w-3.5 h-3.5 text-[var(--kendo-color-primary)]" />
      </div>
);

// ════════════════════════════════════════════════════════════════════════════
// Main App
// ════════════════════════════════════════════════════════════════════════════
function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(initialState?.isAuthenticated ?? true)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [loginError, setLoginError] = useState('')
  const [isLoggingIn, setIsLoggingIn] = useState(false)

  const [input, setInput] = useState('')
  const [pendingAtts, setPendingAtts] = useState<PendingAtt[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [messages, setMessages] = useState<Message[]>(initialMessages)
  const [isThinking, setIsThinking] = useState(initialState?.isThinking || false)
  // True for the whole duration of a turn (send → agent_response_end). Drives
  // the "skip syntax highlighting while streaming" optimisation. (isThinking
  // flips false on the first text delta, so it can't mark the streaming msg.)
  const [isStreaming, setIsStreaming] = useState(false)
  const [activity, setActivity] = useState('')
  const [conversationId, setConversationId] = useState<string | null>(initialState?.conversationId || null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const [showHistory, setShowHistory] = useState(false)
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [isLoadingHistory, setIsLoadingHistory] = useState(false)

  const [workspaceMode, setWorkspaceMode] = useState<'local' | 'cloud'>(initialState?.workspaceMode || 'local')
  const [showModeDropdown, setShowModeDropdown] = useState(false)
  const [usage, setUsage] = useState<{ tokens: number; costUsd: number }>({ tokens: 0, costUsd: 0 })
  const [branding, setBranding] = useState<{ orgName: string; logoUrl: string; themeColor: string }>({ orgName: '', logoUrl: '', themeColor: '' })
  const [planSteps, setPlanSteps] = useState<string[]>([])
  const [planExpanded, setPlanExpanded] = useState(true)
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>([])

  // Auto-resize composer
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }, [input]);

  // Smart auto-scroll (only when already near the bottom)
  useEffect(() => {
    const parent = scrollRef.current;
    if (parent) {
      const nearBottom = parent.scrollHeight - parent.scrollTop - parent.clientHeight < 120;
      if (nearBottom) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
    if (ideBridge.isAvailable()) {
      ideBridge.setState({ messages, isThinking, isAuthenticated, conversationId, workspaceMode });
    }
  }, [messages, isThinking, activity, planSteps, pendingApprovals, isAuthenticated, conversationId, workspaceMode])

  // Inbound messages from the extension host
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const message = event.data;
      switch (message.type) {
        case 'branding':
          setBranding({ orgName: message.orgName || '', logoUrl: message.logoUrl || '', themeColor: message.themeColor || '' });
          break;
        case 'require_login':
          setIsAuthenticated(false); break;
        case 'login_success':
          setIsAuthenticated(true); setIsLoggingIn(false); setLoginError(''); setUsername(''); setPassword(''); break;
        case 'login_failed':
          setIsLoggingIn(false); setLoginError(message.error || 'Login failed'); break;
        case 'agent_response_end':
          setActivity(''); setIsStreaming(false);
          if (message.conversationId) {
            setConversationId(message.conversationId);
            if (ideBridge.isAvailable()) ideBridge.postMessage({ type: 'load_conversations' });
          }
          if (message.conversationTokens != null || message.conversationCostUsd != null) {
            setUsage({ tokens: message.conversationTokens || 0, costUsd: message.conversationCostUsd || 0 });
          }
          break;
        case 'thinking_delta':
          setIsThinking(true)
          setMessages(prev => {
            const last = prev[prev.length - 1];
            if (last && last.role === 'assistant')
              return [...prev.slice(0, -1), { ...last, thinking: (last.thinking || '') + message.text }];
            return [...prev, { id: Date.now().toString(), role: 'assistant', content: '', thinking: message.text }];
          })
          break;
        case 'agent_response':
          setIsThinking(false); setActivity('')
          setMessages(prev => {
            const last = prev[prev.length - 1];
            if (last && last.role === 'assistant' && !message.isNew && last.id !== '1') {
              const mergedTools = [...(last.tool_calls || [])];
              if (message.tool_calls) {
                message.tool_calls.forEach((nt: ToolCall) => {
                  const idx = mergedTools.findIndex(t => t.name === nt.name && t.status === 'running');
                  if (idx >= 0 && nt.status === 'completed') mergedTools[idx].status = 'completed';
                  else mergedTools.push(nt);
                });
              }
              return [...prev.slice(0, -1), { ...last, content: (last.content || '') + (message.text || ''), tool_calls: mergedTools }];
            }
            // start a new assistant message (replace the welcome placeholder)
            const base = (last && last.id === '1') ? prev.slice(0, -1) : prev;
            return [...base, { id: Date.now().toString(), role: 'assistant', content: message.text || '', tool_calls: message.tool_calls }];
          })
          break;
        case 'plan_update':
          if (message.steps && message.steps.length) { setPlanSteps(message.steps); setPlanExpanded(true); }
          break;
        case 'citations_update':
          if (message.sources && message.sources.length) {
            setMessages(prev => {
              const last = prev[prev.length - 1];
              if (last && last.role === 'assistant') {
                const existing = last.sources || [];
                const seen = new Set(existing.map(s => s.documentId || s.title));
                const merged = [...existing, ...message.sources.filter((s: BrainSource) => !seen.has(s.documentId || s.title))];
                return [...prev.slice(0, -1), { ...last, sources: merged }];
              }
              return prev;
            });
          }
          break;
        case 'approval_request':
          if (message.approvalId) setPendingApprovals(prev => [...prev, {
            approvalId: message.approvalId, toolName: message.toolName || 'action',
            toolArgs: message.toolArgs || {}, timeout_s: message.timeout_s || 300,
          }]);
          break;
        case 'thinking':
          setIsThinking(true)
          if (message.context) setMessages(prev => {
            const last = prev[prev.length - 1];
            if (last && last.role === 'user') return [...prev.slice(0, -1), { ...last, context: message.context }];
            return prev;
          })
          break;
        case 'activity':
          setActivity(message.label || ''); break;
        case 'artifact':
          // Part 2 — model generated media; host provides a renderable dataUri.
          setMessages(prev => {
            const copy = [...prev];
            const last = copy[copy.length - 1];
            if (last && last.role === 'assistant') {
              last.attachments = [...(last.attachments || []),
                { kind: message.kind || 'image', dataUri: message.dataUri, fileName: 'generated' }];
            }
            return [...copy];
          });
          break;
        case 'warning':
          setActivity(message.message || ''); break;
        case 'conversations_loaded':
          setConversations(message.conversations || []); setIsLoadingHistory(false); break;
        case 'conversation_loaded':
          setConversationId(message.conversationId);
          setMessages(message.messages?.length ? message.messages : welcomeMessages);
          setShowHistory(false); setIsThinking(false); setIsStreaming(false); setActivity('');
          setUsage({ tokens: 0, costUsd: 0 }); setPlanSteps([]); setPendingApprovals([]);
          break;
        case 'new_chat_ready':
          setMessages(welcomeMessages); setConversationId(null);
          setIsThinking(false); setIsStreaming(false); setActivity(''); setPlanSteps([]); setPendingApprovals([]);
          setUsage({ tokens: 0, costUsd: 0 });
          break;
        case 'mode_changed':
          setWorkspaceMode(message.mode || 'local'); break;
      }
    };
    // VS Code delivers host messages on the window 'message' event; WebView2
    // (Visual Studio) delivers them on window.chrome.webview's 'message' event
    // and does NOT fire the window event. Listen on BOTH so the same webview
    // works in both hosts. (event.data is the parsed JSON object in each case.)
    window.addEventListener('message', handleMessage);
    const cw = (window as any).chrome?.webview;
    if (cw?.addEventListener) cw.addEventListener('message', handleMessage);

    // Tell the host the webview is mounted and ready to receive messages, so it
    // can (re)send require_login / branding / mode without racing page load.
    ideBridge.postMessage({ type: 'webview_ready' });

    return () => {
      window.removeEventListener('message', handleMessage);
      if (cw?.removeEventListener) cw.removeEventListener('message', handleMessage);
    };
  }, []);

  // Actions
  const handleLogout = () => { ideBridge.isAvailable() ? ideBridge.postMessage({ type: 'logout_request' }) : setIsAuthenticated(false); };
  const handleNewChat = () => {
    setMessages(welcomeMessages); setInput(''); setConversationId(null);
    setIsThinking(false); setActivity(''); setShowHistory(false); setPlanSteps([]); setPendingApprovals([]);
    if (ideBridge.isAvailable()) {
      ideBridge.setState({ messages: welcomeMessages, isThinking: false, isAuthenticated, conversationId: null });
      ideBridge.postMessage({ type: 'new_chat' });
    }
  };
  const handleOpenHistory = () => {
    setShowHistory(true); setIsLoadingHistory(true);
    if (ideBridge.isAvailable()) ideBridge.postMessage({ type: 'load_conversations' });
  };
  const handleSelectConversation = (id: string) => { if (ideBridge.isAvailable()) ideBridge.postMessage({ type: 'load_conversation', conversationId: id }); };
  const handleDeleteConversation = (id: string) => {
    if (ideBridge.isAvailable()) ideBridge.postMessage({ type: 'delete_conversation', conversationId: id });
    if (id === conversationId) handleNewChat();
  };
  const switchMode = (mode: 'local' | 'cloud') => {
    setShowModeDropdown(false);
    if (workspaceMode !== mode) {
      setWorkspaceMode(mode);
      if (ideBridge.isAvailable()) ideBridge.postMessage({ type: 'switch_mode', mode });
    }
  };

  const kindOfMime = (mt: string) =>
    mt.startsWith('image/') ? 'image' : mt === 'application/pdf' ? 'document'
      : mt.startsWith('audio/') ? 'audio' : mt.startsWith('video/') ? 'video' : 'document';
  const addFiles = (files: FileList | null) => {
    if (!files) return;
    Array.from(files).forEach(file => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUri = String(reader.result || '');
        const dataB64 = dataUri.includes(',') ? dataUri.split(',')[1] : dataUri;
        setPendingAtts(prev => [...prev, {
          kind: kindOfMime(file.type || ''), mediaType: file.type || 'application/octet-stream',
          fileName: file.name, dataB64, dataUri,
        }]);
      };
      reader.readAsDataURL(file);
    });
  };
  const removeAtt = (i: number) => setPendingAtts(prev => prev.filter((_, idx) => idx !== i));

  const send = (text: string) => {
    const value = text.trim();
    if ((!value && pendingAtts.length === 0) || isThinking) return;
    const atts = pendingAtts;
    setMessages(prev => {
      const base = isWelcomeOnly(prev) ? [] : prev;
      return [...base, {
        id: Date.now().toString(), role: 'user', content: value,
        attachments: atts.map(a => ({ kind: a.kind, dataUri: a.dataUri, fileName: a.fileName })),
      }];
    });
    setInput(''); setPendingAtts([]); setIsThinking(true); setIsStreaming(true);
    setActivity(''); setPlanSteps([]); setPendingApprovals([]);
    if (ideBridge.isAvailable()) ideBridge.postMessage({
      type: 'user_input', text: value, conversationId,
      attachments: atts.map(a => ({ fileName: a.fileName, mediaType: a.mediaType, dataB64: a.dataB64 })),
    });
  };
  const handleSend = () => send(input);

  const handleLoginSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!username || !password) return;
    setIsLoggingIn(true); setLoginError('');
    if (ideBridge.isAvailable()) ideBridge.postMessage({ type: 'login_request', username, password });
    else setTimeout(() => setIsAuthenticated(true), 800);
  };

  const respondApproval = (approvalId: string, approved: boolean) => {
    setPendingApprovals(prev => prev.filter(a => a.approvalId !== approvalId));
    if (ideBridge.isAvailable()) ideBridge.postMessage({
      type: 'approval_response', approvalId, approved,
      reason: approved ? 'approved in VS Code' : 'denied in VS Code',
    });
  };

  // ── Login screen ──────────────────────────────────────────────────────────
  if (!isAuthenticated) {
    return (
      <div className="flex flex-col h-screen items-center justify-center px-6 bg-[var(--kendo-color-app-surface)] text-[var(--kendo-color-on-app-surface)]">
        <div className="w-full max-w-xs flex flex-col items-center gap-6">
          {branding.logoUrl
            ? <img src={branding.logoUrl} alt="" className="w-14 h-14 rounded-2xl object-contain bg-white shadow-sm border border-[var(--kendo-color-border)]"
                onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
            : <div className="w-14 h-14 rounded-2xl bg-[var(--kendo-color-primary)] flex items-center justify-center shadow-sm"><Bot className="w-7 h-7 text-white" /></div>}
          <div className="text-center">
            <h1 className="text-lg font-semibold">{branding.orgName ? `Sign in to ${branding.orgName}` : 'Sign in'}</h1>
            <p className="text-[12.5px] opacity-50 mt-1">Continue to your AI agent</p>
          </div>
          <form onSubmit={handleLoginSubmit} className="w-full flex flex-col gap-3">
            <input type="text" placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} disabled={isLoggingIn}
              className="px-3.5 py-2.5 bg-[var(--kendo-color-base)] border border-[var(--kendo-color-border)] rounded-xl text-[13px] outline-none focus:border-[var(--kendo-color-primary)] transition-colors" />
            <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={isLoggingIn}
              className="px-3.5 py-2.5 bg-[var(--kendo-color-base)] border border-[var(--kendo-color-border)] rounded-xl text-[13px] outline-none focus:border-[var(--kendo-color-primary)] transition-colors" />
            {loginError && <p className="text-[12px] text-[var(--kendo-color-error)] px-1">{loginError}</p>}
            <button type="submit" disabled={isLoggingIn || !username || !password}
              className="mt-1 py-2.5 rounded-xl bg-[var(--kendo-color-primary)] text-white text-[13px] font-semibold hover:opacity-90 active:scale-[0.99] transition-all disabled:opacity-50 flex items-center justify-center gap-2">
              {isLoggingIn ? <><Loader2 className="w-4 h-4 animate-spin" /> Signing in…</> : 'Sign in'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  const showEmptyState = isWelcomeOnly(messages) && !isThinking;
  // The actively-streaming assistant message = the last one while thinking.
  // It renders without syntax highlighting (cheap) until the turn completes,
  // so a long code-heavy stream never re-highlights per token and freezes.
  const streamingMsgId = isStreaming ? messages[messages.length - 1]?.id : undefined;

  // ── Main chat ───────────────────────────────────────────────────────────────
  return (
    <div className="relative flex flex-col h-screen min-h-0 bg-[var(--kendo-color-app-surface)] text-[var(--kendo-color-on-app-surface)] overflow-hidden antialiased">
      {showHistory && (
        <HistoryPanel conversations={conversations} activeConversationId={conversationId}
          onSelect={handleSelectConversation} onDelete={handleDeleteConversation}
          onNewChat={handleNewChat} onClose={() => setShowHistory(false)} isLoading={isLoadingHistory} />
      )}

      {/* Header */}
      <header className="flex-none flex items-center justify-between gap-2 px-3 h-12 border-b border-[var(--kendo-color-border)] bg-[var(--kendo-color-app-surface)]">
        <div className="flex items-center gap-2 min-w-0">
          <AgentAvatar logoUrl={branding.logoUrl} />
          <span className="text-[13px] font-semibold truncate">{branding.orgName || 'Agent'}</span>
        </div>
        <div className="flex items-center gap-1 flex-none">
          {usage.tokens > 0 && (
            <div title="Tokens & estimated cost for this conversation"
              className="hidden sm:flex items-center gap-1 px-2 py-1 rounded-md text-[11px] tabular-nums text-[var(--kendo-color-on-app-surface)] opacity-60">
              <Gauge className="w-3 h-3" />{formatTokens(usage.tokens)}
              {usage.costUsd > 0 && <span>· {formatCost(usage.costUsd)}</span>}
            </div>
          )}
          {/* Mode selector */}
          <div className="relative">
            <button onClick={() => setShowModeDropdown(v => !v)} title="Execution mode"
              className="flex items-center gap-1.5 px-2 py-1.5 rounded-md text-[11.5px] font-medium hover:bg-[var(--kendo-color-base)] transition-colors"
              style={{ color: workspaceMode === 'local' ? 'var(--kendo-color-success)' : 'var(--kendo-color-primary)' }}>
              {workspaceMode === 'local' ? <Monitor className="w-3.5 h-3.5" /> : <Cloud className="w-3.5 h-3.5" />}
              <span className="hidden sm:inline">{workspaceMode === 'local' ? 'Local' : 'Cloud'}</span>
              <ChevronDown className="w-3 h-3 opacity-60" />
            </button>
            {showModeDropdown && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowModeDropdown(false)} />
                <div className="absolute right-0 top-full mt-1.5 z-50 w-60 rounded-xl bg-[var(--kendo-color-app-surface)] border border-[var(--kendo-color-border)] shadow-xl overflow-hidden">
                  {([['local', Monitor, 'Local Server', 'Tools run on your machine', 'var(--kendo-color-success)'],
                     ['cloud', Cloud, 'Cloud Server', 'Execution offloaded to the VPS', 'var(--kendo-color-primary)']] as const).map(
                    ([mode, Icon, title, desc, color]) => (
                    <button key={mode} onClick={() => switchMode(mode as 'local' | 'cloud')}
                      className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-[var(--kendo-color-base)] transition-colors">
                      <Icon className="w-4 h-4 flex-none" style={{ color: workspaceMode === mode ? color : undefined }} />
                      <div className="min-w-0 flex-1">
                        <div className="text-[12.5px] font-medium">{title}</div>
                        <div className="text-[11px] opacity-55 leading-tight">{desc}</div>
                      </div>
                      {workspaceMode === mode && <Check className="w-4 h-4 flex-none" style={{ color }} />}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          <div className="w-px h-5 bg-[var(--kendo-color-border)] mx-0.5" />
          <button onClick={handleNewChat} title="New chat"
            className="p-1.5 rounded-md opacity-65 hover:opacity-100 hover:bg-[var(--kendo-color-base)] transition-all"><MessageSquarePlus className="w-4 h-4" /></button>
          <button onClick={handleOpenHistory} title="History"
            className="p-1.5 rounded-md opacity-65 hover:opacity-100 hover:bg-[var(--kendo-color-base)] transition-all"><History className="w-4 h-4" /></button>
          <button onClick={handleLogout} title="Sign out"
            className="p-1.5 rounded-md opacity-65 hover:opacity-100 hover:text-[var(--kendo-color-error)] hover:bg-[var(--kendo-color-error)]/10 transition-all"><LogOut className="w-4 h-4" /></button>
        </div>
      </header>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden custom-scrollbar">
        {showEmptyState ? (
          <div className="h-full flex flex-col items-center justify-center px-6 text-center animate-fadeIn">
            <div className="relative ag-glow flex items-center justify-center">
              {branding.logoUrl
                ? <img src={branding.logoUrl} alt="" className="relative z-10 w-16 h-16 rounded-2xl object-contain bg-white shadow-lg border border-[var(--kendo-color-border)]"
                    onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                : <div className="relative z-10 w-16 h-16 rounded-2xl ag-gradient-primary flex items-center justify-center shadow-lg">
                    <Sparkles className="w-8 h-8 text-white" />
                  </div>}
            </div>
            <h2 className="text-[19px] font-bold mt-5 ag-gradient-text">{branding.orgName ? `${branding.orgName} Agent` : 'How can I help?'}</h2>
            <p className="text-[12.5px] opacity-55 mt-1.5 max-w-xs leading-relaxed">Ask about your code, run tasks, or explore the project.</p>
            <div className="mt-7 w-full max-w-sm flex flex-col gap-2 stagger">
              {SUGGESTIONS.map(s => (
                <button key={s} onClick={() => send(s)}
                  className="group flex items-center gap-2 text-left text-[12.5px] px-3.5 py-3 rounded-xl border border-[var(--kendo-color-border)] bg-[var(--kendo-color-base)]/40 hover:bg-[var(--kendo-color-base)] hover:border-[var(--kendo-color-primary)]/50 ag-elevate-hover">
                  <Sparkles className="w-3.5 h-3.5 text-[var(--kendo-color-primary)] opacity-70 flex-none" />
                  <span className="flex-1">{s}</span>
                  <ChevronRight className="w-3.5 h-3.5 opacity-0 -translate-x-1 group-hover:opacity-60 group-hover:translate-x-0 transition-all flex-none" />
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="max-w-3xl mx-auto w-full px-4 py-4 flex flex-col gap-5 min-w-0">
            {messages.filter(m => !(m.id === '1')).map(msg => (
              msg.role === 'user' ? (
                <div key={msg.id} className="flex justify-end min-w-0 animate-msg-in">
                  <div className="max-w-[85%] min-w-0 px-3.5 py-2.5 rounded-2xl rounded-tr-md ag-gradient-primary text-white text-[13.5px] leading-relaxed break-words whitespace-pre-wrap overflow-hidden shadow-md">
                    {msg.attachments && msg.attachments.length > 0 && (
                      <div className="mb-1.5 flex flex-wrap gap-1.5">
                        {msg.attachments.map((a, i) => a.kind === 'image' && a.dataUri
                          ? <img key={i} src={a.dataUri} alt={a.fileName || ''} className="max-w-[200px] max-h-[200px] rounded-lg object-cover" />
                          : <span key={i} className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-[11px] bg-white/15"><FileText className="w-3 h-3" />{a.fileName || a.kind}</span>
                        )}
                      </div>
                    )}
                    {msg.content}
                    {msg.context?.files?.length ? (
                      <div className="mt-2 flex items-center gap-1.5 text-[11px] text-white/80 bg-white/10 rounded-md px-2 py-1 w-fit max-w-full">
                        <FileCode className="w-3 h-3 flex-none" />
                        <span className="truncate">{msg.context.files[0].split(/[/\\]/).pop()}</span>
                        {msg.context.files.length > 1 && <span>+{msg.context.files.length - 1}</span>}
                        {msg.context.hasSelection && <span className="italic">(sel)</span>}
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : (
                <div key={msg.id} className="flex gap-3 min-w-0 animate-msg-in">
                  <AgentAvatar logoUrl={branding.logoUrl} />
                  <div className="flex-1 min-w-0 pt-0.5">
                    {msg.thinking && <ThinkingBlock thinking={msg.thinking} done={!!msg.content} />}
                    {(() => {
                      const tools = msg.tool_calls || [];
                      const diffs = tools.filter(t => t.name === 'suggest_diff');
                      const others = tools.filter(t => t.name !== 'suggest_diff');
                      return (<>
                        {others.length > 0 && <ToolDisclosure tools={others} />}
                        {diffs.map((t, i) => <SuggestDiffCard key={i} tool={t} />)}
                      </>);
                    })()}
                    {msg.content ? <Markdown text={msg.content} highlight={msg.id !== streamingMsgId} /> : (!msg.thinking && (!msg.tool_calls || !msg.tool_calls.length) && !(msg.attachments && msg.attachments.length) && <TypingDots label={activity} />)}
                    {msg.attachments && msg.attachments.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {msg.attachments.map((a, i) => a.kind === 'image' && a.dataUri
                          ? <img key={i} src={a.dataUri} alt={a.fileName || ''} className="max-w-[280px] max-h-[280px] rounded-lg border border-[var(--kendo-color-border)] object-cover" />
                          : <span key={i} className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-[11px] border border-[var(--kendo-color-border)]"><FileText className="w-3 h-3 opacity-60" />{a.fileName || a.kind}</span>
                        )}
                      </div>
                    )}
                    {msg.sources && msg.sources.length > 0 && (
                      <div className="mt-3 flex flex-wrap items-center gap-1.5">
                        <span className="text-[10px] font-semibold uppercase tracking-wide opacity-40">Sources</span>
                        {msg.sources.map((s, i) => (
                          <span key={i} title={s.snippet || s.sourcePath || s.title}
                            className="inline-flex items-center gap-1 max-w-[200px] px-2 py-0.5 rounded-full text-[11px] border border-[var(--kendo-color-border)] bg-[var(--kendo-color-base)]/50 opacity-80">
                            <FileCode className="w-3 h-3 flex-none opacity-60" /><span className="truncate">{s.title}</span>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )
            ))}

            {/* Execution plan */}
            {planSteps.length > 0 && (
              <div className="rounded-xl border border-[var(--kendo-color-border)] bg-[var(--kendo-color-base)]/40 overflow-hidden">
                <button onClick={() => setPlanExpanded(v => !v)}
                  className="w-full flex items-center gap-2 px-3.5 py-2 text-[12.5px] font-medium hover:bg-[var(--kendo-color-base)] transition-colors">
                  <ChevronDown className={`w-3.5 h-3.5 opacity-60 transition-transform ${planExpanded ? '' : '-rotate-90'}`} />
                  Plan <span className="text-[11px] opacity-50 ml-auto">{planSteps.length} steps</span>
                </button>
                {planExpanded && (
                  <ol className="px-4 pb-3 pl-9 text-[12.5px] leading-relaxed list-decimal opacity-85 space-y-0.5">
                    {planSteps.map((s, i) => <li key={i}>{s}</li>)}
                  </ol>
                )}
              </div>
            )}

            {/* Standalone thinking row (no assistant message yet) */}
            {isThinking && messages[messages.length - 1]?.role !== 'assistant' && (
              <div className="flex gap-3 min-w-0">
                <AgentAvatar logoUrl={branding.logoUrl} />
                <div className="pt-1"><TypingDots label={activity} /></div>
              </div>
            )}

            {/* Approvals */}
            {pendingApprovals.map(appr => (
              <ApprovalCard key={appr.approvalId} approval={appr} onRespond={respondApproval} />
            ))}

            <div ref={bottomRef} />
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="flex-none px-3 pb-3 pt-2 bg-[var(--kendo-color-app-surface)]">
        <div className="max-w-3xl mx-auto w-full">
          {pendingAtts.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {pendingAtts.map((a, i) => (
                <div key={i} className="inline-flex items-center gap-1.5 pl-1 pr-1.5 py-1 rounded-lg border border-[var(--kendo-color-border)] bg-[var(--kendo-color-base)]/50 text-[11px]">
                  {a.kind === 'image'
                    ? <img src={a.dataUri} alt="" className="w-6 h-6 rounded object-cover" />
                    : <FileText className="w-4 h-4 opacity-60" />}
                  <span className="max-w-[120px] truncate">{a.fileName}</span>
                  <button onClick={() => removeAtt(i)} title="Remove" className="opacity-60 hover:opacity-100"><X className="w-3 h-3" /></button>
                </div>
              ))}
            </div>
          )}
          <div className="relative flex items-end gap-2 rounded-2xl border border-[var(--kendo-color-border)] bg-[var(--kendo-color-base)]/50 ag-focus-glow ag-elevate transition-all px-2 py-1.5">
            <input ref={fileInputRef} type="file" multiple hidden
              accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,audio/*,video/*"
              onChange={(e) => { addFiles(e.target.files); e.currentTarget.value = ''; }} />
            <button onClick={() => fileInputRef.current?.click()} title="Attach file" disabled={isThinking}
              className="flex-none mb-0.5 w-8 h-8 flex items-center justify-center rounded-xl opacity-60 hover:opacity-100 hover:bg-[var(--kendo-color-base)] transition-all disabled:opacity-30">
              <Paperclip className="w-4 h-4" />
            </button>
            <textarea
              ref={textareaRef}
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
              placeholder="Message the agent…"
              style={{ maxHeight: '200px' }}
              className="flex-1 min-w-0 bg-transparent resize-none outline-none text-[13.5px] leading-relaxed px-2 py-1.5 placeholder:opacity-40 overflow-y-auto custom-scrollbar"
            />
            <button onClick={handleSend} disabled={(!input.trim() && pendingAtts.length === 0) || isThinking} title="Send"
              className="flex-none mb-0.5 w-8 h-8 flex items-center justify-center rounded-xl ag-gradient-primary text-white shadow-sm hover:shadow-md hover:brightness-110 active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none">
              {isThinking ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowUp className="w-4 h-4" />}
            </button>
          </div>
          <p className="text-center text-[10px] opacity-35 mt-1.5">
            {branding.orgName ? `${branding.orgName} · ` : ''}Enter to send · Shift+Enter for newline
          </p>
        </div>
      </div>
    </div>
  );
}

export default App
