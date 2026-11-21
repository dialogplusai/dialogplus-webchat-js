/**
 * DialogPlus web chat client: the public chat API for your own chat UI
 * (web, React Native, a kiosk...). The same API the hosted chat window
 * uses: start a chat, send messages, get replies live, upload files, and
 * answer forms and carts that journeys send.
 *
 *   const chat = createChat({ widgetKey: 'wk_...' });
 *   const started = await chat.start();
 *   const stop = chat.subscribe((event) => console.log(event));
 *   await chat.send({ text: 'Hi' });
 *
 * The chat's token is the visitor's key to this chat only: keep it where
 * the visitor's device keeps its own data (pass `storage` to persist it),
 * never on your servers' logs. Signed-in visitors: pass `identityToken`
 * (a JWT your server signs with the widget's secret).
 */

export type MessageKind = 'text' | 'buttons' | 'list' | 'media' | 'link' | 'location_request' | 'location' | 'cards'
  | 'form' | 'products' | 'system' | string;

export interface ChatMessage {
  id: number;
  direction: 'in' | 'out';
  sender: 'visitor' | 'bot' | 'agent' | 'system';
  agent?: string | null;
  kind: MessageKind;
  body: Record<string, unknown> & { kind: string; text?: string };
  created_at?: string;
}

export interface StartResult {
  token: string;
  session: { id: string; label: string; code: string; signed_in: boolean; name?: string | null; [key: string]: unknown };
  config: Record<string, unknown>;
  messages: ChatMessage[];
}

export type ChatEvent =
  | { type: 'message'; message: ChatMessage }
  | { type: 'typing'; on: boolean; agent?: boolean }
  | { type: 'closed'; reason?: string }
  | { type: 'connected' }
  | { type: 'disconnected'; error?: unknown };

export class ChatError extends Error {
  constructor(message: string, readonly code: string, readonly status: number, readonly errors: unknown[] = []) {
    super(message);
    this.name = 'ChatError';
  }
}

/** Where the client keeps the chat token between visits (localStorage fits a browser). */
export interface TokenStorage {
  get(key: string): string | null | Promise<string | null>;
  set(key: string, value: string | null): void | Promise<void>;
}

export interface ChatOptions {
  widgetKey: string;
  /** The API base, ending in /api. */
  apiUrl?: string;
  identityToken?: string | null;
  storage?: TokenStorage;
  /** Values your site knows about the visitor ({{web.plan}} in journeys). */
  attributes?: Record<string, string>;
  pageUrl?: string;
  fetch?: typeof fetch;
}

const DEFAULT_API = 'https://api.dialogplus.ai/api';
const BOUNDARY = /\r\n\r\n|\n\n|\r\r/;

/** Complete server-sent events at the start of `buffer`, and the rest to keep. */
export function takeEvents(buffer: string): { events: { event: string; data: string }[]; rest: string } {
  const events: { event: string; data: string }[] = [];
  let rest = buffer;
  let match = BOUNDARY.exec(rest);
  while (match) {
    const block = rest.slice(0, match.index);
    rest = rest.slice(match.index + match[0].length);
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split(/\r\n|\r|\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim() || 'message';
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (data.length) events.push({ event, data: data.join('\n') });
    match = BOUNDARY.exec(rest);
  }
  return { events, rest };
}

function clientId(): string {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  return `sdk-${random}`.slice(0, 64);
}

export function createChat(options: ChatOptions) {
  const base = (options.apiUrl || DEFAULT_API).replace(/\/$/, '');
  const doFetch = options.fetch || fetch.bind(globalThis);
  const storeKey = `dp_webchat_${options.widgetKey}`;
  let token: string | null = null;
  let lastId = 0;

  async function call<T>(path: string, init: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await doFetch(`${base}${path}`, {
      method: init.method || 'GET', headers, credentials: 'omit',
      body: init.form || (init.body === undefined ? undefined : JSON.stringify(init.body)),
    });
    if (!response.ok) {
      let detail: { code?: string; message?: string; errors?: unknown[] } = {};
      try { detail = (await response.json())?.detail || {}; } catch { /* not JSON */ }
      throw new ChatError(detail.message || `Request failed (${response.status})`, detail.code || 'error', response.status, detail.errors || []);
    }
    return response.json() as Promise<T>;
  }

  function track(messages: ChatMessage[]) {
    for (const m of messages) lastId = Math.max(lastId, m.id || 0);
    return messages;
  }

  const api = {
    get token() { return token; },

    /** Start or continue the visitor's chat. */
    async start(extra: { resume?: string; humanToken?: string } = {}): Promise<StartResult> {
      const kept = options.storage ? await options.storage.get(storeKey) : null;
      const result = await call<StartResult>(`/v1/webchat/${encodeURIComponent(options.widgetKey)}/sessions`, {
        method: 'POST',
        body: {
          token: kept || null, identity_token: options.identityToken || null, page_url: options.pageUrl || null,
          attributes: options.attributes || {}, resume: extra.resume || null, human_token: extra.humanToken || null,
        },
      });
      token = result.token;
      if (options.storage) await options.storage.set(storeKey, token);
      track(result.messages);
      return result;
    },

    /** A typed message, a tapped button (id + title), or a shared location. */
    async send(message: { text?: string; buttonId?: string; buttonTitle?: string;
      location?: { latitude: number; longitude: number; name?: string }; humanToken?: string }): Promise<ChatMessage> {
      const result = await call<{ message: ChatMessage }>('/v1/webchat/messages', {
        method: 'POST',
        body: { text: message.text, button_id: message.buttonId, button_title: message.buttonTitle,
                location: message.location, client_id: clientId(), human_token: message.humanToken },
      });
      return track([result.message])[0];
    },

    /** Messages after `after` (default: the newest this client has seen). */
    async messages(after = lastId): Promise<ChatMessage[]> {
      return track((await call<{ messages: ChatMessage[] }>(`/v1/webchat/messages?after=${after}`)).messages);
    },

    /** Replies live. Reconnects with back-off and fetches what was missed. Returns stop(). */
    subscribe(onEvent: (event: ChatEvent) => void): () => void {
      let stopped = false;
      let controller: AbortController | null = null;
      const run = async () => {
        let wait = 1000;
        while (!stopped) {
          controller = new AbortController();
          try {
            const response = await doFetch(`${base}/v1/webchat/stream`, {
              headers: { Accept: 'text/event-stream', Authorization: `Bearer ${token}` },
              credentials: 'omit', signal: controller.signal,
            });
            if (!response.ok || !response.body) throw new ChatError('Live updates are unavailable.', 'stream', response.status);
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const { events, rest } = takeEvents(buffer);
              buffer = rest;
              for (const item of events) {
                let data: Record<string, unknown> = {};
                try { data = JSON.parse(item.data); } catch { continue; }
                if (item.event === 'ready') {
                  onEvent({ type: 'connected' });
                  wait = 1000;
                  for (const missed of await api.messages()) onEvent({ type: 'message', message: missed });
                } else if (item.event === 'message') {
                  const message = data as unknown as ChatMessage;
                  if (message.id > lastId) { track([message]); onEvent({ type: 'message', message }); }
                } else if (item.event === 'typing') {
                  onEvent({ type: 'typing', on: Boolean(data.on), agent: Boolean(data.agent) });
                } else if (item.event === 'closed') {
                  onEvent({ type: 'closed', reason: data.reason as string | undefined });
                  stopped = true;
                }
              }
            }
          } catch (error) {
            if (stopped) return;
            onEvent({ type: 'disconnected', error });
            if (error instanceof ChatError && (error.status === 401 || error.status === 403)) return;
          }
          if (!stopped) {
            await new Promise((resolve) => setTimeout(resolve, wait));
            wait = Math.min(wait * 2, 30000);
          }
        }
      };
      void run();
      return () => { stopped = true; controller?.abort(); };
    },

    /** A photo (JPG, PNG, WebP) or PDF, up to 10 MB; scanned before anyone opens it. */
    async upload(file: Blob, filename: string, caption?: string): Promise<ChatMessage> {
      const form = new FormData();
      form.append('file', file, filename);
      form.append('client_id', clientId());
      if (caption) form.append('caption', caption);
      return track([(await call<{ message: ChatMessage }>('/v1/webchat/uploads', { method: 'POST', form })).message])[0];
    },

    /** Answers to a form (a WhatsApp Flow the chat draws): screen id -> name -> value. */
    async submitForm(messageId: number, answers: Record<string, Record<string, unknown>>): Promise<ChatMessage> {
      const result = await call<{ message: ChatMessage }>(`/v1/webchat/forms/${messageId}`, {
        method: 'POST', body: { answers, client_id: clientId() } });
      return track([result.message])[0];
    },

    /** A cart from a products message; the server prices it from the catalog. */
    async sendCart(messageId: number, items: { id: string; quantity: number }[], note?: string): Promise<ChatMessage> {
      const result = await call<{ message: ChatMessage }>('/v1/webchat/cart', {
        method: 'POST', body: { message_id: messageId, items, note, client_id: clientId() } });
      return track([result.message])[0];
    },

    async setAttributes(values: Record<string, string>) {
      return call<{ attributes: Record<string, string> }>('/v1/webchat/attributes', { method: 'POST', body: { attributes: values } });
    },
    async identify(identityToken: string) {
      return call('/v1/webchat/identify', { method: 'POST', body: { identity_token: identityToken } });
    },
    async typing() { return call('/v1/webchat/typing', { method: 'POST', body: {} }); },
    async read(lastSeenId: number) { return call('/v1/webchat/read', { method: 'POST', body: { last_id: lastSeenId } }); },

    /** Forget the chat on this device (a sign-out). */
    async end() {
      try { await call('/v1/webchat/sessions', { method: 'DELETE' }); } finally {
        token = null;
        lastId = 0;
        if (options.storage) await options.storage.set(storeKey, null);
      }
    },
  };
  return api;
}

export type Chat = ReturnType<typeof createChat>;
