// Any server that speaks the OpenAI chat-completions dialect: Ollama, LM Studio,
// llama.cpp, vLLM, OpenRouter, OpenAI itself. Plain fetch, no SDK — the dialect is the
// contract, and local servers implement slightly different subsets of it.

import { randomBytes } from 'node:crypto';
import type { ModelConfig } from '../../store.ts';
import { ProviderError, type Provider, type ProviderRequest, type ProviderResponse, type ToolCall, type Turn } from '../types.ts';

export const DEFAULT_OPENAI_BASE = 'http://localhost:11434/v1';

type WirePart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | WirePart[] | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

function toMessages(system: string, turns: Turn[]): WireMessage[] {
  const out: WireMessage[] = [{ role: 'system', content: system }];
  for (const turn of turns) {
    if (turn.role === 'user') {
      out.push({
        role: 'user',
        content: turn.images?.length
          ? [...turn.images.map((img): WirePart => ({ type: 'image_url', image_url: { url: `data:${img.mediaType};base64,${img.data}` } })), { type: 'text', text: turn.text }]
          : turn.text,
      });
    } else if (turn.role === 'assistant') {
      const msg: WireMessage = { role: 'assistant', content: turn.text || null };
      if (turn.toolCalls.length > 0) {
        msg.tool_calls = turn.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
        }));
      } else if (!turn.text) {
        msg.content = '(no reply)';
      }
      out.push(msg);
    } else {
      for (const r of turn.results) out.push({ role: 'tool', tool_call_id: r.toolCallId, content: r.content });
    }
  }
  return out;
}

function headers(cfg: ModelConfig): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
  };
}

const base = (cfg: ModelConfig): string => (cfg.baseUrl || DEFAULT_OPENAI_BASE).replace(/\/+$/, '');

async function request(cfg: ModelConfig, path: string, init: RequestInit): Promise<Response> {
  const url = `${base(cfg)}${path}`;
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    throw new ProviderError(`Could not reach ${base(cfg)}. Is the model server running?`);
  }
  if (res.ok) return res;

  const body = await res.text().catch(() => '');
  let detail = body.slice(0, 300);
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string };
    detail = (typeof parsed.error === 'string' ? parsed.error : parsed.error?.message) ?? detail;
  } catch {
    // Not JSON; keep the raw text.
  }
  if (res.status === 401 || res.status === 403) {
    throw new ProviderError(`${base(cfg)} did not accept the API key. Check it in Settings → Model.`, res.status);
  }
  if (res.status === 404) {
    throw new ProviderError(`${base(cfg)} could not find that model or endpoint${detail ? `: ${detail}` : '.'}`, 404);
  }
  if (res.status === 429) throw new ProviderError('The model server is rate-limiting requests. Try again shortly.', 429);
  throw new ProviderError(`The model server returned ${res.status}${detail ? `: ${detail}` : ''}`, res.status);
}

interface StreamChunk {
  choices?: {
    delta?: {
      content?: string | null;
      tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
    finish_reason?: string | null;
  }[];
}

export function openAiProvider(cfg: ModelConfig): Provider {
  return {
    id: 'openai-compatible',
    model: cfg.model,

    async complete(req: ProviderRequest): Promise<ProviderResponse> {
      if (!cfg.model) throw new ProviderError('No model chosen yet. Pick one in Settings → Model.');
      const res = await request(cfg, '/chat/completions', {
        method: 'POST',
        headers: headers(cfg),
        signal: req.signal,
        body: JSON.stringify({
          model: cfg.model,
          stream: true,
          messages: toMessages(req.system, req.turns),
          // Some servers reject an empty tools array.
          ...(req.tools.length
            ? { tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } })) }
            : {}),
        }),
      });
      if (!res.body) throw new ProviderError('The model server sent an empty response.');

      let text = '';
      let finish: string | null = null;
      const partial = new Map<number, { id: string; name: string; args: string }>();
      let last = -1;

      const handle = (chunk: StreamChunk & { error?: { message?: string } | string }): void => {
        // Some servers report a failure mid-stream as an event rather than a status code.
        if (chunk.error) throw new ProviderError(`The model server reported an error: ${typeof chunk.error === 'string' ? chunk.error : (chunk.error.message ?? 'unknown')}`);
        const choice = chunk.choices?.[0];
        if (!choice) return;
        if (choice.finish_reason) finish = choice.finish_reason;
        const delta = choice.delta;
        if (!delta) return;
        if (delta.content) {
          text += delta.content;
          req.onText(delta.content);
        }
        for (const call of delta.tool_calls ?? []) {
          let index: number;
          if (call.index !== undefined) {
            index = call.index;
            // Some servers number every parallel call 0; a different id means a new call.
            const cur = partial.get(index);
            if (cur && call.id && cur.id && call.id !== cur.id) index = Math.max(...partial.keys(), index) + 1;
            else if (cur && call.id && call.id !== cur.id && [...partial.values()].some((p) => p.id === call.id)) index = [...partial.entries()].find(([, p]) => p.id === call.id)![0];
          } else if (!call.id && !call.function?.name && last >= 0) {
            // A continuation without an index belongs to the call being streamed.
            index = last;
          } else {
            // Servers that send a whole call in one chunk often omit `index`.
            index = partial.size ? Math.max(...partial.keys()) + 1 : 0;
          }
          const slot = partial.get(index) ?? { id: '', name: '', args: '' };
          if (call.id) slot.id = call.id;
          if (call.function?.name) slot.name = slot.name && !slot.args ? slot.name + call.function.name : slot.name || call.function.name;
          if (call.function?.arguments) slot.args += call.function.arguments;
          partial.set(index, slot);
          last = index;
        }
      };

      // Server-sent events: "data: {json}" lines, blank-line separated, ending with [DONE].
      const line = (raw: string): void => {
        const l = raw.trim();
        if (!l.startsWith('data:')) return;
        const data = l.slice(5).trim();
        if (!data || data === '[DONE]') return;
        let parsed: StreamChunk;
        try {
          parsed = JSON.parse(data) as StreamChunk;
        } catch {
          return; // a malformed keep-alive or comment line
        }
        handle(parsed);
      };
      const decoder = new TextDecoder();
      let buffer = '';
      for await (const bytes of res.body) {
        buffer += decoder.decode(bytes as Uint8Array, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          line(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
        }
      }
      // The last event may arrive without a trailing newline.
      buffer += decoder.decode();
      if (buffer.trim()) line(buffer);

      const toolCalls: ToolCall[] = [...partial.entries()]
        .sort(([a], [b]) => a - b)
        .filter(([, c]) => c.name)
        .map(([, c]) => {
          let input: unknown;
          try {
            input = c.args.trim() ? JSON.parse(c.args) : {};
          } catch {
            // Leave it to the loop's schema check, which reports the bad input to the model.
            input = { __unparseable_arguments: c.args };
          }
          return { id: c.id || `call_${randomBytes(6).toString('hex')}`, name: c.name, input };
        });

      if (finish === 'length' && toolCalls.length > 0) {
        return {
          text,
          toolCalls: [],
          stopped: { reason: 'max_tokens', message: 'The reply was cut off before it finished, so nothing was changed.' },
        };
      }
      if (!text && toolCalls.length === 0 && !finish) throw new ProviderError('The model server ended the reply without saying anything. Try again.');
      return { text, toolCalls };
    },
  };
}

export async function listOpenAiModels(cfg: ModelConfig): Promise<{ id: string; name: string }[]> {
  const res = await request(cfg, '/models', { headers: headers(cfg), signal: AbortSignal.timeout(8000) });
  const body = (await res.json()) as { data?: { id: string }[] };
  return (body.data ?? []).map((m) => ({ id: m.id, name: m.id })).sort((a, b) => a.id.localeCompare(b.id));
}
