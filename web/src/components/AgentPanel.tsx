import DOMPurify from 'dompurify';
import { ArrowUp, ArrowUpRight, Check, CircleAlert, History, SquarePen, Square, Trash2, X } from 'lucide-react';
import { marked } from 'marked';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'wouter';
import { PRESET_BY_ID } from '../../../shared/providers.ts';
import type { ChatMessage, Settings, ToolCallView } from '../../../shared/types.ts';
import type { AgentChat } from '../agent.ts';
import { useConversations, useWrite, write } from '../api.ts';
import { cx, timeAgo } from '../lib.ts';
import { AgentOrb } from './Orb.tsx';
import { AutoTextarea, Spinner, useDialogFocus } from './ui.tsx';

// Model output is untrusted text: render Markdown, then strip anything active.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});
const renderMarkdown = (text: string): string =>
  DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true, breaks: true }), { FORBID_TAGS: ['img', 'style', 'form', 'input'] });

const STARTERS: { label: string; prompt: string }[] = [
  { label: 'Plan my day', prompt: 'Help me plan today. Look at what is due, my habits and how each sphere has been going, then suggest a realistic plan.' },
  { label: 'What am I neglecting?', prompt: 'Which spheres or goals have I been neglecting lately? Be specific, and suggest one small step for each.' },
  { label: 'Run a weekly review', prompt: 'Walk me through a weekly review: what moved, what stalled, and what I should focus on next week.' },
  { label: 'Help me set a goal', prompt: 'I want to set a new goal. Help me think it through, one question at a time.' },
];

function Prose({ text, streaming }: { text: string; streaming: boolean }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div className={cx('prose', streaming && 'caret')} dangerouslySetInnerHTML={{ __html: html }} />;
}

function ToolChip({ call, undone, onUndo }: { call: ToolCallView; undone: boolean; onUndo: (activityId: number) => void }) {
  const running = call.ok === undefined;
  return (
    <div className={cx('tool', call.ok === true && 'ok', call.ok === false && 'failed', undone && 'undone')}>
      {running ? <Spinner /> : call.ok ? <Check size={14} strokeWidth={2.6} /> : <CircleAlert size={14} />}
      <span>{call.summary ?? `${call.name.replaceAll('_', ' ')}…`}</span>
      {call.ok && call.undoable && call.activityId != null && !undone && (
        <button type="button" onClick={() => onUndo(call.activityId!)}>
          Undo
        </button>
      )}
    </div>
  );
}

function Message({ message, live, chat }: { message: ChatMessage; live: boolean; chat: AgentChat }) {
  if (message.role === 'user') {
    return <div className="msg-user">{message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')}</div>;
  }
  const waiting = live && message.parts.length === 0;
  return (
    <div className="msg-agent">
      {waiting && (
        <div className="row faint">
          <AgentOrb size={18} thinking /> Thinking…
        </div>
      )}
      {message.parts.map((part, i) =>
        part.type === 'text' ? (
          <Prose key={i} text={part.text} streaming={live && i === message.parts.length - 1} />
        ) : (
          <ToolChip key={part.call.id} call={part.call} undone={part.call.activityId != null && chat.undone.includes(part.call.activityId)} onUndo={(id) => void chat.undo(id)} />
        ),
      )}
    </div>
  );
}

// Matches the stylesheet: below this the panel floats over the page instead of docking.
const FLOATING = '(max-width: 1180px)';

function useFloating(): boolean {
  const [floating, setFloating] = useState(() => window.matchMedia(FLOATING).matches);
  useEffect(() => {
    const query = window.matchMedia(FLOATING);
    const onChange = () => setFloating(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return floating;
}

export function AgentPanel({ chat, settings, onClose }: { chat: AgentChat; settings: Settings; onClose: () => void }) {
  const [draft, setDraft] = useState('');
  const panel = useRef<HTMLElement>(null);
  const floating = useFloating();
  // Docked, go straight to the composer. Floating over the page on a phone or tablet,
  // focus the panel itself: it is announced and Tab starts inside it, without the
  // on-screen keyboard jumping up over the conversation.
  useDialogFocus(panel, () => (floating ? null : panel.current?.querySelector<HTMLTextAreaElement>('.composer textarea:not(:disabled)')));
  const [showHistory, setShowHistory] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const { data: conversations = [] } = useConversations(showHistory);
  const removeConversation = useWrite((id: string) => write.del(`/conversations/${id}`));

  const { agentName, userName } = settings.profile;
  const { connections, brains } = settings;
  const activeId = chat.connectionId ?? brains.chat ?? undefined;
  const active = connections.find((c) => c.id === activeId);
  const preset = active?.preset ? PRESET_BY_ID[active.preset] : undefined;
  const connected = !!active && (active.provider !== 'anthropic' || active.hasApiKey);
  const modelLabel = connected ? `${active.label} · ${active.model || preset?.defaultModel || 'default model'}${preset?.local ? ' · on this machine' : ''}` : 'No model connected';

  // Follow the reply as it streams, unless the person has scrolled up to read.
  useEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [chat.messages, chat.error, chat.needsModel]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('.scrim') && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = () => {
    if (!draft.trim() || chat.streaming) return;
    pinned.current = true;
    chat.send(draft);
    setDraft('');
  };

  // From settings, not chat.needsModel: that is set by a failed send and would keep the
  // panel locked after a model is connected, with nothing left in it able to clear it.
  const needsModel = !connected;

  // A message the server turned away comes back to the composer.
  useEffect(() => {
    if (chat.unsent) setDraft((d) => d || chat.unsent!);
  }, [chat.unsent]);

  return (
    <>
      <div className="agent-scrim" onClick={onClose} />
      <aside
        className="agent"
        aria-label={`${agentName}, your agent`}
        ref={panel}
        tabIndex={-1}
        // Over the page it behaves as a dialog, and keeps Tab inside.
        role={floating ? 'dialog' : undefined}
        aria-modal={floating ? true : undefined}
      >
        <header className="agent-head">
          <AgentOrb size={30} thinking={chat.streaming} />
          <div className="grow">
            <div className="name">{agentName}</div>
            <div className="model">{modelLabel}</div>
          </div>
          {connections.length > 1 && (
            <select
              className="select agent-brain"
              aria-label="Brain for this conversation"
              title="Which brain answers in this conversation"
              value={activeId}
              onChange={(e) => chat.setBrain(e.target.value)}
              disabled={chat.streaming}
            >
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          )}
          <button className="icon-btn" aria-label="Past conversations" aria-pressed={showHistory} onClick={() => setShowHistory((v) => !v)}>
            <History size={17} />
          </button>
          <button className="icon-btn" aria-label="New conversation" onClick={() => { chat.reset(); setShowHistory(false); }}>
            <SquarePen size={17} />
          </button>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <div
          className="agent-scroll"
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget;
            pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
          }}
        >
          {showHistory ? (
            <div className="history">
              <span className="eyebrow" style={{ padding: '0 10px 6px' }}>
                Past conversations
              </span>
              {conversations.length === 0 && <p className="empty">Nothing here yet.</p>}
              {conversations.map((c) => (
                <div key={c.id} className="history-item">
                  <button type="button" className="title" style={{ textAlign: 'left' }} onClick={() => void chat.load(c.id).then(() => setShowHistory(false))}>
                    {c.title}
                  </button>
                  <span className="faint" style={{ fontSize: 12 }}>
                    {timeAgo(c.updatedAt)}
                  </span>
                  <button className="icon-btn icon-btn-sm" aria-label={`Delete conversation: ${c.title}`} onClick={() => {
                      // Deleting the open conversation: let go of it, or every later message would go to it.
                      if (c.id === chat.conversationId) chat.reset();
                      removeConversation.mutate(c.id);
                    }}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          ) : chat.messages.length === 0 ? (
            <div className="agent-welcome">
              <AgentOrb size={64} />
              {needsModel ? (
                <>
                  <h3>{agentName} needs a mind</h3>
                  <p>Connect a model — one running on this machine, or your own API key — and {agentName} can read your spheres and act on them.</p>
                  <Link href="/settings" className="btn btn-primary" onClick={onClose}>
                    Connect a model
                  </Link>
                </>
              ) : (
                <>
                  <h3>{userName ? `What's on your mind, ${userName}?` : "What's on your mind?"}</h3>
                  <p>Tell me what happened, what you need to do, or ask about anything in your spheres. I'll keep it all in order.</p>
                  <div className="starters">
                    {STARTERS.map((s) => (
                      <button key={s.label} type="button" className="starter" onClick={() => chat.send(s.prompt)}>
                        {s.label}
                        <ArrowUpRight size={15} />
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          ) : (
            <>
              {chat.messages.map((m, i) => (
                <Message key={i} message={m} live={chat.streaming && i === chat.messages.length - 1} chat={chat} />
              ))}
              {needsModel && (
                <div className="agent-error">
                  No model is connected. <Link href="/settings" className="link" onClick={onClose}>Connect one in Settings</Link>.
                </div>
              )}
            </>
          )}
          {chat.error && <div className="agent-error">{chat.error}</div>}
        </div>

        <div className="composer">
          <div className="composer-box">
            <AutoTextarea
              value={draft}
              onChange={setDraft}
              placeholder={needsModel ? 'Connect a model to start talking…' : `Tell ${agentName} anything…`}
              aria-label={`Message ${agentName}`}
              disabled={needsModel}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
            {chat.streaming ? (
              <button type="button" className="send" aria-label="Stop" onClick={chat.stop}>
                <Square size={13} fill="currentColor" />
              </button>
            ) : (
              <button type="button" className="send" aria-label="Send" disabled={!draft.trim() || needsModel} onClick={submit}>
                <ArrowUp size={17} strokeWidth={2.4} />
              </button>
            )}
          </div>
        </div>
      </aside>
    </>
  );
}
