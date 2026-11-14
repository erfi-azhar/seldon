// Provider-neutral conversation model. The agent loop speaks this; each provider adapter
// translates it to and from its own wire format.

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResult {
  toolCallId: string;
  name: string;
  /** What the model reads. */
  content: string;
  isError: boolean;
  /** What the person reads, e.g. "Logged 72.4 kg to Weight". */
  summary: string;
  activityId: number | null;
}

export type Turn =
  | {
      role: 'user';
      /** Exactly what was sent to the model, context block included. Never rewritten. */
      text: string;
      /** What the person typed. */
      display: string;
      /** Pictures sent with the message (base64), for models that can see. */
      images?: { mediaType: string; data: string }[];
    }
  | {
      role: 'assistant';
      text: string;
      toolCalls: ToolCall[];
      /**
       * The provider's own content for this turn, replayed byte-for-byte to the same
       * provider. Anthropic thinking blocks are only valid while the history before
       * them is unchanged, so the history is append-only and this is never edited.
       */
      native?: { provider: string; content: unknown };
    }
  | { role: 'tool'; results: ToolResult[] };

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the input object. */
  schema: Record<string, unknown>;
}

export interface ProviderRequest {
  system: string;
  turns: Turn[];
  tools: ToolSpec[];
  signal?: AbortSignal;
  onText: (delta: string) => void;
}

export interface ProviderResponse {
  text: string;
  toolCalls: ToolCall[];
  native?: { provider: string; content: unknown };
  /** Set when the model stopped for a reason the loop must not continue from. */
  stopped?: { reason: 'refusal' | 'max_tokens'; message: string };
}

export interface Provider {
  readonly id: string;
  readonly model: string;
  complete(req: ProviderRequest): Promise<ProviderResponse>;
}

/** A failure worth showing to the person as-is (bad key, model not found, server down). */
export class ProviderError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
  }
}
