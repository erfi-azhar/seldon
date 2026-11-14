// The agent loop: one user message in, any number of model/tool rounds, events out.

import type { ModelConfig, Store } from '../store.ts';
import type { AgentEvent, ChatContext } from '../../../shared/types.ts';
import { buildSystemPrompt, firstUserText, laterUserText } from './prompt.ts';
import { anthropicProvider, listAnthropicModels } from './providers/anthropic.ts';
import { listOpenAiModels, openAiProvider } from './providers/openai.ts';
import { runTool, TOOL_SPECS } from './tools.ts';
import { ProviderError, type Provider, type ToolResult, type Turn } from './types.ts';

/** Model/tool rounds allowed for one message before the agent has to stop and report. */
const MAX_ROUNDS = 12;

export function providerFor(cfg: ModelConfig): Provider {
  return cfg.provider === 'anthropic' ? anthropicProvider(cfg) : openAiProvider(cfg);
}

export function listModels(cfg: ModelConfig): Promise<{ id: string; name: string }[]> {
  return cfg.provider === 'anthropic' ? listAnthropicModels(cfg) : listOpenAiModels(cfg);
}

export interface ChatRequest {
  store: Store;
  provider: Provider;
  /** Recorded on a new conversation so it keeps talking to the same brain. */
  connectionId?: string | null;
  conversationId?: string;
  message: string;
  context: ChatContext;
  emit: (event: AgentEvent) => void;
  signal?: AbortSignal;
}

/** Runs one exchange. Resolves with the conversation id; reports problems as events. */
export async function chat(req: ChatRequest): Promise<string> {
  const { store, provider, context, emit } = req;
  const agent = store.as('agent');
  const message = req.message.trim();

  let conversationId = req.conversationId;
  let system: string;
  let turns: Turn[];
  let userTurn: Turn;

  if (conversationId) {
    system = store.getConversationSystem(conversationId);
    turns = store.getTurns(conversationId);
    userTurn = { role: 'user', text: laterUserText(context, message), display: message };
  } else {
    system = buildSystemPrompt(store.getProfile());
    turns = [];
    userTurn = { role: 'user', text: firstUserText(store, context, message), display: message };
    conversationId = store.createConversation(message.replace(/\s+/g, ' ').slice(0, 70), system, req.connectionId ?? null);
  }
  turns.push(userTurn);
  store.appendTurn(conversationId, userTurn);
  emit({ type: 'meta', conversationId });

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const res = await provider.complete({
        system,
        turns,
        tools: TOOL_SPECS,
        signal: req.signal,
        onText: (delta) => emit({ type: 'text', delta }),
      });

      if (res.stopped) {
        const text = [res.text.trim(), res.stopped.message].filter(Boolean).join('\n\n');
        const turn: Turn = { role: 'assistant', text, toolCalls: [] };
        store.appendTurn(conversationId, turn);
        emit({ type: 'text', delta: `${res.text.trim() ? '\n\n' : ''}${res.stopped.message}` });
        break;
      }

      const assistant: Turn = { role: 'assistant', text: res.text, toolCalls: res.toolCalls, native: res.native };
      turns.push(assistant);

      if (res.toolCalls.length === 0) {
        store.appendTurn(conversationId, assistant);
        break;
      }

      // Tools are synchronous database work, so the assistant turn and its results are
      // stored together: the history never holds a tool call without its result.
      const results: ToolResult[] = [];
      for (const call of res.toolCalls) {
        emit({ type: 'tool_start', id: call.id, name: call.name, input: call.input });
        const before = agent.trail.length;
        const run = runTool(call.name, call.input, { store: agent, today: context.date });
        const activityId = agent.trail.length > before ? agent.trail[agent.trail.length - 1]! : null;
        results.push({ toolCallId: call.id, name: call.name, content: run.content, isError: run.isError, summary: run.summary, activityId });
        emit({
          type: 'tool_end',
          id: call.id,
          ok: !run.isError,
          summary: run.summary,
          activityId,
          undoable: activityId !== null && (store.getActivity(activityId)?.undoable ?? false),
        });
      }
      const toolTurn: Turn = { role: 'tool', results };
      turns.push(toolTurn);
      store.tx(() => {
        store.appendTurn(conversationId, assistant);
        store.appendTurn(conversationId, toolTurn);
      });

      if (round === MAX_ROUNDS - 1) {
        const note = `I've taken ${MAX_ROUNDS} steps on this and stopped here so I don't run away with it. Say "keep going" if you want me to continue.`;
        store.appendTurn(conversationId, { role: 'assistant', text: note, toolCalls: [] });
        emit({ type: 'text', delta: `\n\n${note}` });
      }
    }
  } catch (err) {
    if (req.signal?.aborted) return conversationId;
    const problem =
      err instanceof ProviderError
        ? err.message
        : `Something went wrong talking to the model: ${err instanceof Error ? err.message : String(err)}`;
    emit({ type: 'error', message: problem });
    return conversationId;
  }

  emit({ type: 'done' });
  return conversationId;
}
