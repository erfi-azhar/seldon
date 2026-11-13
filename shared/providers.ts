// Model back-ends offered in Settings. "Local" presets keep everything on your machine.

import type { ProviderKind } from './types.ts';

export interface ProviderPreset {
  id: string;
  label: string;
  provider: ProviderKind;
  baseUrl: string;
  local: boolean;
  needsKey: boolean;
  blurb: string;
  /** Where to get a key, or how to get the server running. */
  help: string;
  defaultModel: string;
}

export const PRESETS: ProviderPreset[] = [
  {
    id: 'ollama',
    label: 'Ollama',
    provider: 'openai-compatible',
    baseUrl: 'http://localhost:11434/v1',
    local: true,
    needsKey: false,
    blurb: 'Open models on this machine. Nothing leaves it.',
    help: 'Install Ollama, then pull a model that supports tools, e.g. `ollama pull qwen3`.',
    defaultModel: '',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    provider: 'openai-compatible',
    baseUrl: 'http://localhost:1234/v1',
    local: true,
    needsKey: false,
    blurb: 'Local models with a desktop app.',
    help: 'Load a tool-capable model in LM Studio and start its local server.',
    defaultModel: '',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    provider: 'anthropic',
    baseUrl: '',
    local: false,
    needsKey: true,
    blurb: 'Claude, through your own API key.',
    help: 'Create a key at console.anthropic.com. Requests go straight from your server to Anthropic.',
    defaultModel: 'claude-opus-5-5',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    provider: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    local: false,
    needsKey: true,
    blurb: 'GPT models, through your own API key.',
    help: 'Create a key at platform.openai.com.',
    defaultModel: '',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    provider: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    local: false,
    needsKey: true,
    blurb: 'One key, many hosted models.',
    help: 'Create a key at openrouter.ai and choose any model that supports tool calling.',
    defaultModel: '',
  },
  {
    id: 'custom',
    label: 'Custom endpoint',
    provider: 'openai-compatible',
    baseUrl: '',
    local: false,
    needsKey: false,
    blurb: 'Any OpenAI-compatible server: llama.cpp, vLLM, a home GPU box.',
    help: 'Enter the base URL ending in /v1.',
    defaultModel: '',
  },
];

export const PRESET_BY_ID: Record<string, ProviderPreset> = Object.fromEntries(PRESETS.map((p) => [p.id, p]));
