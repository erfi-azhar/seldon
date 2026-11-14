import Anthropic from '@anthropic-ai/sdk';
import type { ModelConfig } from '../../store.ts';
import { ProviderError, type Provider, type ProviderRequest, type ProviderResponse, type Turn } from '../types.ts';


export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';
const API = 'https://api.anthropic.com';
const MAX_TOKENS = 32_000;
/** Lets the API re-run a request another model would accept when a safety classifier declines it. */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

function client(cfg: ModelConfig, apiBase: string = API): Anthropic {
  // The base URL always comes from settings so the app talks to exactly the host the
  // person chose, whatever the process environment says.
  return new Anthropic({ apiKey: cfg.apiKey, baseURL: cfg.baseUrl || apiBase });
}

/** Tool-call ids from other providers are replayed here; Anthropic only accepts [A-Za-z0-9_-]. */
const safeId = (id: string): string => id.replace(/[^a-zA-Z0-9_-]/g, '_');

const isThinking = (block: { type: string }): boolean => block.type === 'thinking' || block.type === 'redacted_thinking';

function nativeBlocks(turn: Extract<Turn, { role: 'assistant' }>): Anthropic.Beta.BetaContentBlockParam[] | null {
  if (turn.native?.provider !== 'anthropic' || !Array.isArray(turn.native.content)) return null;
  return turn.native.content as Anthropic.Beta.BetaContentBlockParam[];
}

function toMessages(turns: Turn[], stripThinking: boolean): Anthropic.Beta.BetaMessageParam[] {
  const out: Anthropic.Beta.BetaMessageParam[] = [];
  for (const turn of turns) {
    if (turn.role === 'user') {
      if (turn.images?.length) {
        out.push({
          role: 'user',
          content: [
            ...turn.images.map(
              (img): Anthropic.Beta.BetaImageBlockParam => ({
                type: 'image',
                source: { type: 'base64', media_type: img.mediaType as 'image/png', data: img.data },
              }),
            ),
            { type: 'text', text: turn.text },
          ],
        });
      } else {
        out.push({ role: 'user', content: turn.text });
      }
    } else if (turn.role === 'assistant') {
      // Replay what Anthropic sent, untouched: thinking blocks are bound to the exact
      // history that produced them. Turns from another provider are rebuilt from text.
      let content = nativeBlocks(turn);
      if (content && stripThinking) content = content.filter((b) => !isThinking(b));
      if (!content || content.length === 0) {
        content = [];
        if (turn.text) content.push({ type: 'text', text: turn.text });
        for (const call of turn.toolCalls) {
          content.push({ type: 'tool_use', id: safeId(call.id), name: call.name, input: call.input ?? {} });
        }
      }
      if (content.length === 0) content.push({ type: 'text', text: '(no reply)' });
      out.push({ role: 'assistant', content });
    } else {
      // Every result for one assistant turn goes back in a single user message.
      out.push({
        role: 'user',
        content: turn.results.map(
          (r): Anthropic.Beta.BetaToolResultBlockParam => ({
            type: 'tool_result',
            tool_use_id: safeId(r.toolCallId),
            content: r.content,
            ...(r.isError ? { is_error: true } : {}),
          }),
        ),
      });
    }
  }
  return out;
}

function explain(err: InstanceType<typeof Anthropic.APIError>): ProviderError {
  if (err instanceof Anthropic.AuthenticationError) {
    return new ProviderError('Anthropic did not accept the API key. Check it in Settings → Model.', 401);
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return new ProviderError(`This API key is not allowed to do that: ${err.message}`, 403);
  }
  if (err instanceof Anthropic.NotFoundError) {
    return new ProviderError('Anthropic does not know that model. Pick another in Settings → Model.', 404);
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new ProviderError('Anthropic is rate-limiting this key. Give it a minute and try again.', 429);
  }
  if (err instanceof Anthropic.BadRequestError) {
    return new ProviderError(`Anthropic rejected the request: ${err.message}`, 400);
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new ProviderError('Could not reach Anthropic. Check the network connection.', null);
  }
  return new ProviderError(`Anthropic returned an error${err.status ? ` (${err.status})` : ''}: ${err.message}`, err.status ?? null);
}

/** `apiBase` exists so tests can stand in for api.anthropic.com; the app never passes it. */
export function anthropicProvider(cfg: ModelConfig, apiBase: string = API): Provider {
  const anthropic = client(cfg, apiBase);
  const model = cfg.model || DEFAULT_ANTHROPIC_MODEL;
  // A custom base URL means a proxy or gateway that may reject newer fields.
  const firstParty = !cfg.baseUrl;

  return {
    id: 'anthropic',
    model,

    async complete(req: ProviderRequest): Promise<ProviderResponse> {
      const tools: Anthropic.Beta.BetaTool[] = req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.schema as Anthropic.Beta.BetaTool.InputSchema,
        // Stream tool input as it is generated. The API then no longer validates it, so
        // the agent loop validates every input against the tool's schema before running it.
        ...(firstParty ? { eager_input_streaming: true } : {}),
      }));
      const hasThinking = req.turns.some((t) => t.role === 'assistant' && (nativeBlocks(t) ?? []).some(isThinking));

      let stripThinking = false;
      let jsonRetries = 0;
      let streamed = false;

      for (;;) {
        const stream = anthropic.beta.messages.stream(
          {
            model,
            max_tokens: MAX_TOKENS,
            // Frozen for the life of the conversation, so it caches; the breakpoint on the
            // request caches the growing message history behind it.
            system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
            cache_control: { type: 'ephemeral' },
            ...(tools.length ? { tools } : {}),
            messages: toMessages(req.turns, stripThinking),
            ...(cfg.effort !== 'auto' ? { output_config: { effort: cfg.effort } } : {}),
            ...(firstParty ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {}),
          },
          { signal: req.signal },
        );
        stream.on('text', (delta) => {
          if (!streamed && jsonRetries > 0) req.onText('\n\n');
          streamed = true;
          req.onText(delta);
        });

        let message: Anthropic.Beta.BetaMessage;
        try {
          message = await stream.finalMessage();
        } catch (err) {
          if (err instanceof Anthropic.APIUserAbortError) throw err;
          if (err instanceof Anthropic.BadRequestError && hasThinking && !stripThinking) {
            // Earlier reasoning is only accepted while the system prompt, tools and history
            // before it are byte-identical. If they are not (the tool list changed in an
            // upgrade, say), drop all of it — which is always allowed — and ask again.
            stripThinking = true;
            continue;
          }
          if (err instanceof Anthropic.APIError) throw explain(err);
          // Not an API error: a tool input that could not be parsed as JSON at all.
          if (jsonRetries++ < 2) {
            streamed = false;
            continue;
          }
          throw new ProviderError('The model kept producing tool input that could not be read. Try again.');
        }

        if (message.stop_reason === 'refusal') {
          const why = message.stop_details?.explanation;
          return {
            text: '',
            toolCalls: [],
            stopped: { reason: 'refusal', message: `The model declined to respond to this${why ? `: ${why}` : '.'}` },
          };
        }

        const text = message.content
          .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('');
        const toolCalls = message.content
          .filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use')
          .map((b) => ({ id: b.id, name: b.name, input: b.input }));

        if (message.stop_reason === 'max_tokens' && toolCalls.length > 0) {
          // A tool input cut off mid-way usually still parses; never run it.
          return {
            text,
            toolCalls: [],
            stopped: { reason: 'max_tokens', message: 'The reply was cut off before it finished, so nothing was changed.' },
          };
        }

        return { text, toolCalls, native: { provider: 'anthropic', content: message.content } };
      }
    },
  };
}

export async function listAnthropicModels(cfg: ModelConfig): Promise<{ id: string; name: string }[]> {
  const out: { id: string; name: string }[] = [];
  try {
    for await (const m of client(cfg).models.list()) out.push({ id: m.id, name: m.display_name });
  } catch (err) {
    if (err instanceof Anthropic.APIError) throw explain(err);
    throw err;
  }
  return out;
}
