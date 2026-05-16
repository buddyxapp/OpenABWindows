/**
 * ACP Protocol — JSON-RPC 2.0 types and notification classifier.
 * Synced with OpenAB v0.8.1: ConfigOption, config_option_update event.
 */

export interface JsonRpcMessage {
  id?: number;
  method?: string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
  params?: Record<string, unknown>;
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; media_type: string; data: string };

// --- ConfigOption (ACP session-level configuration) ---

export interface ConfigOptionValue {
  value: string;
  name: string;
  description?: string;
}

export interface ConfigOption {
  id: string;
  name: string;
  description?: string;
  category?: string;
  type: string;
  currentValue: string;
  options: ConfigOptionValue[];
}

/** Extract configOptions from a JSON-RPC result. Supports standard + kiro-cli fallback. */
export function parseConfigOptions(result: Record<string, unknown>): ConfigOption[] {
  // Standard configOptions
  const raw = result.configOptions as ConfigOption[] | undefined;
  if (raw?.length) return raw;

  const options: ConfigOption[] = [];

  // Kiro-cli fallback: models
  const models = result.models as Record<string, unknown> | undefined;
  if (models) {
    const current = (models.currentModelId as string) ?? '';
    const available = models.availableModels as Array<Record<string, unknown>> | undefined;
    if (available?.length) {
      options.push({
        id: 'model', name: 'Model', description: 'AI model selection',
        category: 'model', type: 'enum', currentValue: current,
        options: available.map(m => ({
          value: (m.modelId as string) ?? (m.id as string) ?? '',
          name: (m.name as string) ?? (m.modelId as string) ?? '',
          description: m.description as string | undefined,
        })).filter(v => v.value),
      });
    }
  }

  // Kiro-cli fallback: modes
  const modes = result.modes as Record<string, unknown> | undefined;
  if (modes) {
    const current = (modes.currentModeId as string) ?? '';
    const available = modes.availableModes as Array<Record<string, unknown>> | undefined;
    if (available?.length) {
      options.push({
        id: 'agent', name: 'Agent', description: 'Agent mode selection',
        category: 'agent', type: 'enum', currentValue: current,
        options: available.map(m => ({
          value: (m.id as string) ?? '',
          name: (m.name as string) ?? (m.id as string) ?? '',
          description: m.description as string | undefined,
        })).filter(v => v.value),
      });
    }
  }

  return options;
}

export type AcpEvent =
  | { type: 'text'; content: string }
  | { type: 'thinking' }
  | { type: 'tool_start'; id: string; title: string }
  | { type: 'tool_done'; id: string; title: string; status: 'completed' | 'failed' }
  | { type: 'status'; message: string }
  | { type: 'config_update'; options: ConfigOption[] }
  | { type: 'turn_end' };

export function classifyNotification(msg: JsonRpcMessage): AcpEvent | null {
  const update = msg.params?.update as Record<string, unknown> | undefined;
  if (!update) return null;

  const kind = update.sessionUpdate as string | undefined;
  if (!kind) return null;

  const toolId = (update.toolCallId as string) ?? '';

  switch (kind) {
    case 'agent_message_chunk': {
      const text = (update.content as Record<string, unknown>)?.text as string | undefined;
      return text ? { type: 'text', content: text } : null;
    }
    case 'agent_thought_chunk':
      return { type: 'thinking' };
    case 'tool_call':
      return { type: 'tool_start', id: toolId, title: (update.title as string) ?? '' };
    case 'tool_call_update': {
      const status = (update.status as string) ?? '';
      const title = (update.title as string) ?? '';
      if (status === 'completed' || status === 'failed')
        return { type: 'tool_done', id: toolId, title, status };
      return { type: 'tool_start', id: toolId, title };
    }
    case 'plan':
      return { type: 'status', message: 'planning' };
    case 'config_option_update':
      return { type: 'config_update', options: parseConfigOptions(update) };
    case 'turn_end':
      return { type: 'turn_end' };
    default:
      return null;
  }
}

export function buildPermissionResponse(params?: Record<string, unknown>): unknown {
  const options = params?.options as Array<Record<string, unknown>> | undefined;
  if (!options?.length) return { outcome: { outcome: 'selected', optionId: 'allow_always' } };
  for (const kind of ['allow_always', 'allow_once']) {
    const opt = options.find((o) => o.kind === kind);
    if (opt?.optionId) return { outcome: { outcome: 'selected', optionId: opt.optionId } };
  }
  const fallback = options.find((o) => o.kind !== 'reject_once' && o.kind !== 'reject_always');
  if (fallback?.optionId) return { outcome: { outcome: 'selected', optionId: fallback.optionId } };
  return { outcome: { outcome: 'cancelled' } };
}

export function makeRequest(id: number, method: string, params?: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined && { params }) });
}

export function makeResponse(id: number, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}
