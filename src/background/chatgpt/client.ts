import type { ConversationItem, ModelOption } from '../../shared/types';
import type { FetchLike } from './deviceAuth';
import { ChatgptAuthError, type ChatgptSession } from './session';

/**
 * ChatGPT's Codex backend: an OpenAI Responses API that bills to the signed-in ChatGPT plan instead of an API
 * key. Request shape follows openai/codex (codex-rs/codex-api): streaming only, nothing stored on OpenAI's side
 * (store: false), so every request carries the whole conversation, including the encrypted reasoning items.
 */

/** Identifies this extension to OpenAI, the way the Codex CLI sends "codex_cli_rs". */
const ORIGINATOR = 'inbox_pilot';

export class ChatgptError extends Error {
  constructor(
    message: string,
    /** True when reconnecting ChatGPT is the fix. */
    readonly auth = false,
    /** Set when the plan's usage limit was reached: when it resets (ms), or 0 when ChatGPT did not say. */
    readonly limitResetsAt: number | null = null,
  ) {
    super(message);
    this.name = 'ChatgptError';
  }
}

export interface ToolDefinition {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: boolean;
}

export interface ResponseRequest {
  model: string;
  effort: string;
  input: ConversationItem[];
  tools: ToolDefinition[];
  conversationId: string;
  signal: AbortSignal;
}

export interface StreamHandlers {
  onTextDelta: (text: string) => void;
  /** A finished output item (message, reasoning or function call) to append to the conversation. */
  onItem: (item: ConversationItem) => void;
}

export class ChatgptClient {
  constructor(
    private readonly deps: { fetch: FetchLike; base: string; clientVersion: string; session: ChatgptSession },
  ) {}

  /** The models this plan may use, best first (the backend's own order). */
  async models(): Promise<ModelOption[]> {
    const response = await this.send(`${this.deps.base}/models?client_version=${encodeURIComponent(this.deps.clientVersion)}`, { method: 'GET' });
    const body = (await response.json().catch(() => null)) as { models?: unknown } | null;
    if (!body || !Array.isArray(body.models)) throw new ChatgptError('ChatGPT returned an unexpected model list.');
    return (body.models as Record<string, unknown>[])
      .filter((m) => typeof m.slug === 'string' && m.visibility === 'list')
      .sort((a, b) => (Number(a.priority) || 0) - (Number(b.priority) || 0))
      .map((m) => ({
        slug: m.slug as string,
        name: typeof m.display_name === 'string' && m.display_name ? m.display_name : (m.slug as string),
        description: typeof m.description === 'string' ? m.description : '',
        efforts: Array.isArray(m.supported_reasoning_levels)
          ? (m.supported_reasoning_levels as Record<string, unknown>[]).map((r) => (typeof r.effort === 'string' ? r.effort : '')).filter(Boolean)
          : [],
      }));
  }

  /** Runs one model turn, streaming text as it arrives. Resolves when the response is complete. */
  async respond(request: ResponseRequest, handlers: StreamHandlers): Promise<void> {
    const body = {
      model: request.model,
      stream: true,
      input: request.input,
      tools: request.tools,
      tool_choice: 'auto',
      parallel_tool_calls: true,
      reasoning: { effort: request.effort, summary: 'auto' },
      store: false,
      include: ['reasoning.encrypted_content'],
      prompt_cache_key: request.conversationId,
    };
    const response = await this.send(`${this.deps.base}/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal: request.signal,
    });
    if (!response.body) throw new ChatgptError('ChatGPT sent an empty response.');
    let completed = false;
    for await (const event of readEvents(response.body)) {
      const type = typeof event.type === 'string' ? event.type : '';
      if (type === 'response.output_text.delta' && typeof event.delta === 'string') handlers.onTextDelta(event.delta);
      else if (type === 'response.output_item.done' && event.item && typeof event.item === 'object') handlers.onItem(event.item as ConversationItem);
      else if (type === 'response.completed') completed = true;
      else if (type === 'response.failed' || type === 'response.incomplete' || type === 'error') {
        const message = describeFailure(event);
        throw new ChatgptError(message, false, message.includes('usage limit') ? 0 : null);
      }
    }
    if (!completed && !request.signal.aborted) throw new ChatgptError('ChatGPT stopped answering partway through. Try again.');
  }

  /** Sends with fresh credentials; on a 401, renews the sign-in once and retries. */
  private async send(url: string, init: RequestInit, retried = false): Promise<Response> {
    let credentials;
    try {
      credentials = await this.deps.session.credentials(retried);
    } catch (error) {
      if (error instanceof ChatgptAuthError) throw new ChatgptError(error.message, true);
      throw error;
    }
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${credentials.accessToken}`);
    if (credentials.accountId) headers.set('ChatGPT-Account-ID', credentials.accountId);
    headers.set('originator', ORIGINATOR);
    let response: Response;
    try {
      response = await this.deps.fetch(url, { ...init, headers, credentials: 'omit', cache: 'no-store' });
    } catch (error) {
      if (init.signal?.aborted) throw error;
      throw new ChatgptError('ChatGPT could not be reached. Check your connection and try again.');
    }
    if (response.ok) return response;
    if (response.status === 401 && !retried) return this.send(url, init, true);
    const text = await response.text().catch(() => '');
    if (response.status === 401) {
      await this.deps.session.expire();
      throw new ChatgptError('ChatGPT no longer accepts this sign-in. Reconnect ChatGPT in Inbox Pilot settings.', true);
    }
    throw new ChatgptError(describeHttpError(response.status, text), false, usageLimitReset(response.status, text));
  }
}

/** When a usage-limit error says the limit resets (ms since epoch), 0 if it does not say, null if not a limit error. */
export function usageLimitReset(status: number, text: string): number | null {
  let error: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (parsed.error && typeof parsed.error === 'object') error = parsed.error as Record<string, unknown>;
  } catch {
    error = {};
  }
  const code = [error.code, error.type].find((v): v is string => typeof v === 'string') ?? '';
  if (status !== 429 && !code.includes('usage_limit')) return null;
  return typeof error.resets_at === 'number' ? error.resets_at * 1000 : 0;
}

/** Plain words for the errors people actually hit: usage limits, plans without Codex access, outages. */
export function describeHttpError(status: number, text: string): string {
  let error: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(text) as { error?: unknown; detail?: unknown };
    if (parsed.error && typeof parsed.error === 'object') error = parsed.error as Record<string, unknown>;
    else if (typeof parsed.detail === 'string') error = { message: parsed.detail };
  } catch {
    error = {};
  }
  const code = [error.code, error.type].find((v): v is string => typeof v === 'string') ?? '';
  const message = typeof error.message === 'string' ? error.message : '';
  if (status === 429 || code.includes('usage_limit')) {
    const resetsAt = typeof error.resets_at === 'number' ? new Date(error.resets_at * 1000) : null;
    const when = resetsAt ? ` It resets ${resetsAt.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}.` : '';
    return `You have reached your ChatGPT plan's usage limit for now.${when}`;
  }
  if (status === 403) return `ChatGPT refused the request${message ? `: ${message}` : ''}. Your plan may not include Codex access.`;
  if (status === 400 && message) return `ChatGPT rejected the request: ${message}`;
  if (status >= 500) return 'ChatGPT is having trouble right now. Try again in a moment.';
  return `ChatGPT returned an error (HTTP ${status})${message ? `: ${message}` : ''}.`;
}

function describeFailure(event: Record<string, unknown>): string {
  const response = event.response as { error?: { message?: unknown; code?: unknown }; incomplete_details?: { reason?: unknown } } | undefined;
  const reason = response?.incomplete_details?.reason;
  if (reason === 'max_output_tokens') return 'The answer got too long and was cut off. Try a narrower question.';
  const message = response?.error?.message ?? (event.message) ?? (event.error as { message?: unknown } | undefined)?.message;
  if (typeof response?.error?.code === 'string' && response.error.code.includes('usage_limit')) return "You have reached your ChatGPT plan's usage limit for now.";
  return typeof message === 'string' && message ? `ChatGPT could not finish: ${message}` : 'ChatGPT could not finish the answer. Try again.';
}

/** Parses a server-sent event stream into the JSON objects of its `data:` lines. */
export async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let boundary: number;
      while ((boundary = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, '');
        const event = parseBlock(block);
        if (event) yield event;
      }
      if (done) {
        const event = parseBlock(buffer);
        if (event) yield event;
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseBlock(block: string): Record<string, unknown> | null {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''))
    .join('\n');
  if (!data || data === '[DONE]') return null;
  try {
    const parsed: unknown = JSON.parse(data);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
