// Stand-in model servers that speak the real wire formats (OpenAI chat-completions SSE
// and Anthropic Messages SSE), shared by the test suites.

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after } from 'node:test';

// ── A scriptable fake model server ──────────────────────────────────────────

export interface Seen {
  path: string;
  headers: IncomingMessage['headers'];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}
export type Reply = { status?: number; sse?: string; json?: unknown };

const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));

export async function fakeModel(replies: Reply[]): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen.push({ path: req.url ?? '', headers: req.headers, body: raw ? JSON.parse(raw) : null });
      const reply = replies.shift();
      if (!reply) {
        res.writeHead(500).end('no scripted reply left');
      } else if (reply.sse !== undefined) {
        res.writeHead(reply.status ?? 200, { 'content-type': 'text/event-stream' });
        // Split mid-stream to prove the client reassembles chunks.
        const cut = Math.floor(reply.sse.length / 2);
        res.write(reply.sse.slice(0, cut));
        setTimeout(() => res.end(reply.sse!.slice(cut)), 5);
      } else {
        res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' }).end(JSON.stringify(reply.json));
      }
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

// OpenAI dialect
export const oaChunk = (delta: unknown, finish: string | null = null): string =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
export const oaText = (...parts: string[]): string =>
  parts.map((p) => oaChunk({ content: p })).join('') + oaChunk({}, 'stop') + 'data: [DONE]\n\n';
export function oaToolCall(id: string, name: string, args: unknown): string {
  const json = JSON.stringify(args);
  const half = Math.ceil(json.length / 2);
  return (
    oaChunk({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: '' } }] }) +
    oaChunk({ tool_calls: [{ index: 0, function: { arguments: json.slice(0, half) } }] }) +
    oaChunk({ tool_calls: [{ index: 0, function: { arguments: json.slice(half) } }] }) +
    oaChunk({}, 'tool_calls') +
    'data: [DONE]\n\n'
  );
}

// Anthropic dialect
export const ev = (type: string, data: Record<string, unknown>): string => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
export function anthropicMessage(blocks: Record<string, unknown>[], stop: string, extra: Record<string, unknown> = {}): string {
  let out = ev('message_start', {
    message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } },
  });
  blocks.forEach((b, index) => {
    if (b.type === 'text') {
      out += ev('content_block_start', { index, content_block: { type: 'text', text: '' } });
      out += ev('content_block_delta', { index, delta: { type: 'text_delta', text: b.text } });
    } else if (b.type === 'thinking') {
      out += ev('content_block_start', { index, content_block: { type: 'thinking', thinking: '', signature: '' } });
      out += ev('content_block_delta', { index, delta: { type: 'signature_delta', signature: b.signature } });
    } else if (b.type === 'tool_use') {
      const json = typeof b.rawInput === 'string' ? b.rawInput : JSON.stringify(b.input);
      out += ev('content_block_start', { index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
      out += ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: json.slice(0, 7) } });
      out += ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: json.slice(7) } });
    }
    out += ev('content_block_stop', { index });
  });
  out += ev('message_delta', { delta: { stop_reason: stop, stop_sequence: null, ...extra }, usage: { output_tokens: 20 } });
  return out + ev('message_stop', {});
}

