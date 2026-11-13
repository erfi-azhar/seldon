// Client-side state for the conversation with the agent. Lives above the panel so a
// conversation keeps going while the panel is closed.

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';
import type { AgentEvent, ChatMessage, ChatPart } from '../../shared/types.ts';
import { ApiError, fetchConversation, streamChat, write } from './api.ts';
import { todayStr } from './lib.ts';

export interface ChatState {
  conversationId: string | undefined;
  messages: ChatMessage[];
  streaming: boolean;
  error: string | null;
  /** The server has no model to talk to yet. */
  needsModel: boolean;
  /** Activity ids the person has undone from this conversation. */
  undone: number[];
}

const EMPTY: ChatState = { conversationId: undefined, messages: [], streaming: false, error: null, needsModel: false, undone: [] };

export interface AgentChat extends ChatState {
  send: (text: string) => void;
  stop: () => void;
  reset: () => void;
  load: (conversationId: string) => Promise<void>;
  undo: (activityId: number) => Promise<void>;
}

function applyToReply(messages: ChatMessage[], change: (parts: ChatPart[]) => ChatPart[]): ChatMessage[] {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'assistant') return messages;
  return [...messages.slice(0, -1), { ...last, parts: change(last.parts) }];
}

export function useAgentChat(viewing: () => string): AgentChat {
  const qc = useQueryClient();
  const [state, setState] = useState<ChatState>(EMPTY);
  const current = useRef(state);
  current.current = state;
  const abort = useRef<AbortController | null>(null);

  const onEvent = useCallback(
    (event: AgentEvent) => {
      switch (event.type) {
        case 'meta':
          setState((s) => ({ ...s, conversationId: event.conversationId }));
          break;
        case 'text':
          setState((s) => ({
            ...s,
            messages: applyToReply(s.messages, (parts) => {
              const tail = parts[parts.length - 1];
              if (tail?.type === 'text') return [...parts.slice(0, -1), { type: 'text', text: tail.text + event.delta }];
              return [...parts, { type: 'text', text: event.delta.replace(/^\n+/, '') }];
            }),
          }));
          break;
        case 'tool_start':
          setState((s) => ({
            ...s,
            messages: applyToReply(s.messages, (parts) => [...parts, { type: 'tool', call: { id: event.id, name: event.name, input: event.input } }]),
          }));
          break;
        case 'tool_end':
          setState((s) => ({
            ...s,
            messages: applyToReply(s.messages, (parts) =>
              parts.map((p) =>
                p.type === 'tool' && p.call.id === event.id
                  ? { type: 'tool', call: { ...p.call, ok: event.ok, summary: event.summary, activityId: event.activityId, undoable: event.undoable } }
                  : p,
              ),
            ),
          }));
          // The agent just changed something: let every open view catch up.
          void qc.invalidateQueries();
          break;
        case 'error':
          setState((s) => ({ ...s, error: event.message }));
          break;
        case 'done':
          break;
      }
    },
    [qc],
  );

  const send = useCallback(
    (raw: string) => {
      const text = raw.trim();
      if (!text || current.current.streaming) return;
      const now = new Date();
      const controller = new AbortController();
      abort.current = controller;
      setState((s) => ({
        ...s,
        streaming: true,
        error: null,
        needsModel: false,
        messages: [...s.messages, { role: 'user', parts: [{ type: 'text', text }] }, { role: 'assistant', parts: [] }],
      }));

      streamChat(
        {
          conversationId: current.current.conversationId,
          message: text,
          context: {
            date: todayStr(now),
            time: now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'local',
            viewing: viewing(),
          },
        },
        onEvent,
        controller.signal,
      )
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          if (err instanceof ApiError && err.code === 'no_model') {
            // Nothing was sent: take the question back out and offer to connect a model.
            setState((s) => ({ ...s, needsModel: true, messages: s.messages.slice(0, -2) }));
          } else {
            setState((s) => ({ ...s, error: err instanceof Error ? err.message : 'Something went wrong.' }));
          }
        })
        .finally(() => {
          setState((s) => {
            // Drop a reply that never got a single word or action.
            const last = s.messages[s.messages.length - 1];
            const messages = last?.role === 'assistant' && last.parts.length === 0 ? s.messages.slice(0, -1) : s.messages;
            return { ...s, streaming: false, messages };
          });
          void qc.invalidateQueries();
        });
    },
    [onEvent, qc, viewing],
  );

  const stop = useCallback(() => abort.current?.abort(), []);

  const reset = useCallback(() => {
    abort.current?.abort();
    setState(EMPTY);
  }, []);

  const load = useCallback(async (conversationId: string) => {
    abort.current?.abort();
    const conversation = await fetchConversation(conversationId);
    setState({ ...EMPTY, conversationId, messages: conversation.messages });
  }, []);

  const undo = useCallback(
    async (activityId: number) => {
      await write.post(`/activity/${activityId}/undo`);
      setState((s) => ({ ...s, undone: [...s.undone, activityId] }));
      void qc.invalidateQueries();
    },
    [qc],
  );

  return { ...state, send, stop, reset, load, undo };
}
