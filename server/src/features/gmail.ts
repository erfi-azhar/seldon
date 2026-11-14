// Gmail: watch for mail that matters, surface it as signals with suggested follow-ups,
// and save replies as drafts in your Gmail. Reads over IMAP with an app password.
//
// Mail is untrusted input. Triage runs on the background brain with no tools, so a
// message can shape a summary but cannot make Terminus do anything; follow-ups are
// only suggestions until you act on them, and replies are saved as drafts, never sent.

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { z } from 'zod';
import { NoBrain, think, wrapUntrusted } from '../agent/think.ts';
import { read } from '../http.ts';
import { Invalid, localDate, type Store } from '../store.ts';
import type { SignalAction } from '../../../shared/types.ts';
import { getIntegration, integrationStatus, removeIntegration, updateIntegration } from './integrations.ts';
import type { MailMessage, MailVerdict } from './mail-types.ts';
import { features, registerFeature } from './registry.ts';
import { addSignal, hasSignal } from './signals.ts';

const ID = 'gmail';
const BATCH = 8;
const MAX_PER_RUN = 40;

// ── Where mail comes from ───────────────────────────────────────────────────

export interface MailSource {
  /** Check the credentials work. */
  verify(): Promise<void>;
  /** Inbox messages after `sinceUid`, or from the last `lookbackDays` on a first run. Newest last. */
  fetchNew(sinceUid: number | null, lookbackDays: number, limit: number): Promise<{ messages: MailMessage[]; uidValidity: string; maxUid: number }>;
  /** Store an RFC 822 message in the Drafts folder. */
  saveDraft(raw: string): Promise<void>;
}

function imapSource(email: string, password: string): MailSource {
  const open = async (): Promise<ImapFlow> => {
    const client = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user: email, pass: password }, logger: false });
    try {
      await client.connect();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/auth|credential|login/i.test(msg)) throw new Invalid('Gmail did not accept that address and app password.');
      throw new Error(`Could not reach Gmail: ${msg}`);
    }
    return client;
  };
  return {
    async verify() {
      const client = await open();
      await client.logout();
    },
    async fetchNew(sinceUid, lookbackDays, limit) {
      const client = await open();
      try {
        const box = await client.mailboxOpen('INBOX', { readOnly: true });
        const uidValidity = String(box.uidValidity);
        const uids =
          ((sinceUid !== null
            ? await client.search({ uid: `${sinceUid + 1}:*` }, { uid: true })
            : await client.search({ since: new Date(Date.now() - lookbackDays * 86_400_000) }, { uid: true })) || []) as number[];
        const wanted = uids.filter((u) => sinceUid === null || u > sinceUid).sort((a, b) => a - b);
        const maxUid = wanted.length ? wanted[wanted.length - 1]! : (sinceUid ?? 0);
        const take = wanted.slice(-limit);
        const messages: MailMessage[] = [];
        if (take.length) {
          for await (const m of client.fetch(take.join(','), { uid: true, envelope: true, labels: true, internalDate: true, source: { maxLength: 200_000 } }, { uid: true })) {
            const parsed = m.source ? await simpleParser(m.source) : null;
            const from = m.envelope?.from?.[0];
            const labels = [...(m.labels ?? [])].map(String);
            messages.push({
              uid: m.uid,
              messageId: m.envelope?.messageId ?? `<uid-${m.uid}@${uidValidity}>`,
              from: { name: from?.name ?? '', address: from?.address ?? '' },
              to: (m.envelope?.to ?? []).map((t) => t.address).filter(Boolean).join(', '),
              subject: m.envelope?.subject ?? '(no subject)',
              date: new Date(m.internalDate ?? m.envelope?.date ?? Date.now()).toISOString(),
              important: labels.includes('\\Important'),
              labels,
              text: (parsed?.text ?? '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 6000),
            });
          }
        }
        return { messages, uidValidity, maxUid };
      } finally {
        await client.logout().catch(() => undefined);
      }
    },
    async saveDraft(raw) {
      const client = await open();
      try {
        // The Drafts folder is named per language; find it by its special-use flag.
        const drafts = (await client.list()).find((b) => b.specialUse === '\\Drafts')?.path ?? '[Gmail]/Drafts';
        await client.append(drafts, raw, ['\\Draft', '\\Seen']);
      } finally {
        await client.logout().catch(() => undefined);
      }
    },
  };
}

let sourceFor: (email: string, password: string) => MailSource = imapSource;
/** Tests stand in a fake mailbox. */
export function setMailSource(factory: (email: string, password: string) => MailSource): void {
  sourceFor = factory;
}

// ── Triage ──────────────────────────────────────────────────────────────────

const Verdicts = z.object({
  messages: z.array(
    z.object({
      uid: z.number(),
      important: z.boolean(),
      priority: z.number().int().min(0).max(3),
      category: z.enum(['action', 'reply', 'deadline', 'travel', 'finance', 'health', 'family', 'work', 'fyi', 'newsletter', 'promotion', 'other']),
      summary: z.string().max(300),
      sphere: z.string().nullable(),
      follow_up: z.object({
        kind: z.enum(['none', 'reply', 'task']),
        title: z.string().max(200).nullable().optional(),
        due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
        reply: z.string().max(3000).nullable().optional(),
      }),
    }),
  ),
});
type Verdict = z.infer<typeof Verdicts>['messages'][number];

function describe(m: MailMessage): string {
  return [
    `uid: ${m.uid}`,
    `from: ${m.from.name ? `${m.from.name} <${m.from.address}>` : m.from.address}`,
    `date: ${m.date}`,
    `subject: ${m.subject}`,
    `gmail_marked_important: ${m.important}`,
    `labels: ${m.labels.filter((l) => !l.startsWith('\\')).join(', ') || 'none'}`,
    '',
    m.text.slice(0, 1800),
  ].join('\n');
}

async function triage(store: Store, messages: MailMessage[]): Promise<Map<number, Verdict>> {
  const profile = store.getProfile();
  const spheres = store.listSpheres().map((s) => s.name);
  const out = new Map<number, Verdict>();
  for (let i = 0; i < messages.length; i += BATCH) {
    const batch = messages.slice(i, i + BATCH);
    const result = await think({
      store,
      task: `Triage these emails for ${profile.userName || 'the user'}. Today is ${localDate()}.
Important means it needs their attention or action, is time-sensitive, or is from a real person or organisation that matters to them (bills, bookings, appointments, work, family, official mail). Newsletters, promotions, receipts with nothing to do, and automated notifications are not important unless they contain a deadline or a problem. Gmail's own importance flag is a weak hint.
For each email return: uid; important; priority 0-3 (3 = urgent today); category; a one-sentence summary written for them (who wants what, by when); sphere: the best match from [${spheres.join(', ')}] or null; follow_up: kind "reply" when they should answer (put a short, polite draft in their voice in "reply" and a title like "Reply to Dana about the offsite"), "task" when they need to do something (title starting with a verb, and due_date when the email gives a deadline), else "none".
Reply as {"messages": [ ... one object per email ... ]}.`,
      input: batch.map((m) => wrapUntrusted('email', describe(m), 2600)).join('\n\n'),
      schema: Verdicts,
    });
    for (const v of result.messages) if (batch.some((m) => m.uid === v.uid)) out.set(v.uid, v);
  }
  return out;
}

/** With no background brain, fall back to Gmail's own Important label. */
function gmailOnly(m: MailMessage): Verdict {
  const promo = m.labels.some((l) => /promotion|social|updates|forums/i.test(l));
  return {
    uid: m.uid,
    important: m.important && !promo,
    priority: 1,
    category: 'other',
    summary: m.text.replace(/\s+/g, ' ').slice(0, 200),
    sphere: null,
    follow_up: { kind: 'task', title: `Follow up: ${m.subject}`.slice(0, 200) },
  };
}

// ── Running ─────────────────────────────────────────────────────────────────

function gmailLink(email: string, messageId: string): string {
  return `https://mail.google.com/mail/u/${encodeURIComponent(email)}/#search/rfc822msgid%3A${encodeURIComponent(messageId.replace(/^<|>$/g, ''))}`;
}

export async function checkMail(store: Store): Promise<{ checked: number; surfaced: number }> {
  const rec = getIntegration(store, ID);
  const email = String(rec.settings.email ?? '');
  const password = rec.secrets.appPassword;
  if (!email || !password) throw new Invalid('Gmail is not connected.');
  const lookback = Number(rec.settings.lookbackDays ?? 3);

  const sameBox = rec.state.uidValidity !== undefined;
  const since = sameBox ? Number(rec.state.lastUid ?? 0) : null;
  const src = sourceFor(email, password);
  const { messages, uidValidity, maxUid } = await src.fetchNew(since, lookback, MAX_PER_RUN);
  // If Gmail renumbered the inbox, start over from the lookback window next time.
  const reset = sameBox && rec.state.uidValidity !== uidValidity;

  const fresh = messages.filter((m) => !hasSignal(store, ID, m.messageId));
  let verdicts: Map<number, Verdict>;
  let usedBrain = true;
  try {
    verdicts = fresh.length ? await triage(store, fresh) : new Map();
  } catch (err) {
    if (!(err instanceof NoBrain)) throw err;
    usedBrain = false;
    verdicts = new Map(fresh.map((m) => [m.uid, gmailOnly(m)]));
  }

  const spheres = store.listSpheres();
  let surfaced = 0;
  for (const m of fresh) {
    const v = verdicts.get(m.uid) ?? gmailOnly(m);
    const verdict: MailVerdict = { important: v.important, priority: v.priority, category: v.category, summary: v.summary };
    for (const f of features()) await f.mail?.(store, m, verdict);
    if (!v.important) continue;

    const sphereId = spheres.find((s) => s.name.toLowerCase() === (v.sphere ?? '').toLowerCase())?.id ?? null;
    const actions: SignalAction[] = [];
    if (v.follow_up.kind === 'reply' && v.follow_up.reply) {
      actions.push({
        type: 'reply',
        label: 'Save reply as a Gmail draft',
        to: m.from.address,
        subject: /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`,
        body: v.follow_up.reply,
        inReplyTo: m.messageId,
      });
    }
    if (v.follow_up.kind !== 'none') {
      actions.push({
        type: 'task',
        label: 'Add as a task',
        title: v.follow_up.title || `Follow up: ${m.subject}`,
        dueDate: v.follow_up.due_date ?? null,
        sphereId,
        notes: `Email from ${m.from.name || m.from.address}: ${m.subject}`,
      });
    }
    actions.push({ type: 'link', label: 'Open in Gmail', url: gmailLink(email, m.messageId) });
    const added = addSignal(store, {
      source: ID,
      kind: v.category,
      externalId: m.messageId,
      title: `${m.from.name || m.from.address}: ${m.subject}`,
      body: v.summary,
      url: gmailLink(email, m.messageId),
      sphereId,
      priority: v.priority,
      actions,
      occurredAt: m.date,
      data: { from: m.from, subject: m.subject, triagedBy: usedBrain ? 'brain' : 'gmail' },
    });
    if (added) surfaced++;
  }

  updateIntegration(store, ID, (r) => {
    r.state.uidValidity = uidValidity;
    r.state.lastUid = reset ? undefined : maxUid;
    if (reset) delete r.state.uidValidity;
  });
  return { checked: fresh.length, surfaced };
}

/** RFC 2047 for headers that are not plain ASCII. */
function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

export function buildDraft(from: string, action: Extract<SignalAction, { type: 'reply' }>): string {
  const clean = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();
  const headers = [
    `From: ${clean(from)}`,
    `To: ${clean(action.to)}`,
    `Subject: ${encodeHeader(clean(action.subject))}`,
    `Date: ${new Date().toUTCString()}`,
    ...(action.inReplyTo ? [`In-Reply-To: ${clean(action.inReplyTo)}`, `References: ${clean(action.inReplyTo)}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ];
  const body = Buffer.from(action.body.replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n');
  return `${headers.join('\r\n')}\r\n\r\n${body}\r\n`;
}

registerFeature({
  id: ID,
  integration: { configured: (rec) => !!rec.settings.email && !!rec.secrets.appPassword },
  jobs: [{ id: ID, everyMs: 10 * 60_000, run: async (store) => void (await checkMail(store)) }],
  actions: {
    reply: async (store, action) => {
      if (action.type !== 'reply') throw new Invalid('Not a reply');
      const rec = getIntegration(store, ID);
      const email = String(rec.settings.email ?? '');
      if (!email || !rec.secrets.appPassword) throw new Invalid('Connect Gmail first.');
      await sourceFor(email, rec.secrets.appPassword).saveDraft(buildDraft(email, action));
      return `Draft saved in Gmail, to ${action.to}`;
    },
  },
  routes: (app, { store, scheduler }) => {
    app.get('/api/integrations/gmail', (c) =>
      c.json(integrationStatus(store, ID, scheduler.isRunning(ID), (r) => !!r.settings.email && !!r.secrets.appPassword)),
    );
    app.put('/api/integrations/gmail', async (c) => {
      const input = await read(
        c,
        z.object({
          email: z.string().email().max(200),
          appPassword: z.string().max(100).optional(),
          lookbackDays: z.number().int().min(1).max(30).optional(),
        }),
      );
      const current = getIntegration(store, ID);
      // App passwords are shown with spaces; Gmail wants them without.
      const password = input.appPassword?.replace(/\s+/g, '') || (current.settings.email === input.email ? current.secrets.appPassword : undefined);
      if (!password) throw new Invalid('Add the app password Google gave you.');
      try {
        await sourceFor(input.email, password).verify();
      } catch (err) {
        throw new Invalid(err instanceof Error ? err.message : String(err));
      }
      updateIntegration(store, ID, (r) => {
        if (r.settings.email !== input.email) r.state = {};
        r.enabled = true;
        r.settings = { ...r.settings, email: input.email, lookbackDays: input.lookbackDays ?? r.settings.lookbackDays ?? 3 };
        r.secrets = { appPassword: password };
        r.lastError = null;
      });
      // First look right away, in the background.
      void scheduler.runNow(ID).catch(() => undefined);
      return c.json(integrationStatus(store, ID, scheduler.isRunning(ID), () => true));
    });
    app.delete('/api/integrations/gmail', (c) => {
      removeIntegration(store, ID);
      return c.json({ ok: true });
    });
  },
});
