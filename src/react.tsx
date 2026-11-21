/**
 * React bindings for DialogPlus web chat.
 *
 * <DialogPlusWidget>   the ready-made chat (the same loader as the snippet in
 *                      the widget's Install tab): a launcher, or inline in a
 *                      box on the page. Sign-in, attributes and per-page
 *                      settings follow your props.
 * useDialogPlusChat()  your own chat UI on the public chat API: messages,
 *                      typing and send/upload, kept live.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createChat, type Chat, type ChatMessage, type ChatOptions } from './client.js';

type Command = 'open' | 'close' | 'toggle' | 'identify' | 'reset' | 'consent' | 'config' | 'setAttributes' | 'send' | 'on';
type DialogPlusFn = ((command: Command, value?: unknown) => void) & { q?: unknown[][] };

declare global {
  interface Window { DialogPlus?: DialogPlusFn }
}

const DEFAULT_LOADER = 'https://api.dialogplus.ai/public/chat-widget/widget.js';

/** Calls made before the loader arrives wait in a queue it replays. */
function dialogPlus(): DialogPlusFn {
  if (!window.DialogPlus) {
    const queued: DialogPlusFn = (command, value) => { (queued.q = queued.q || []).push([command, value]); };
    window.DialogPlus = queued;
  }
  return window.DialogPlus;
}

export interface DialogPlusWidgetProps {
  widgetKey: string;
  /** "launcher" (the chat button) or "inline" (fills this component's box). */
  mode?: 'launcher' | 'inline';
  /** A JWT your server signs with the widget's secret: the visitor is signed in. */
  identityToken?: string | null;
  /** Values your site knows ({{web.plan}} in journeys). */
  attributes?: Record<string, string>;
  /** Per-page settings, as DialogPlus('config', …). */
  config?: Record<string, unknown>;
  /** Your visitor accepted cookies (when the widget waits for consent). */
  consent?: boolean;
  loaderUrl?: string;
  className?: string;
  style?: CSSProperties;
}

let loaded: string | null = null;

export function DialogPlusWidget({ widgetKey, mode = 'launcher', identityToken, attributes, config, consent, loaderUrl, className, style }: DialogPlusWidgetProps) {
  const box = useRef<HTMLDivElement>(null);
  const id = useMemo(() => `dp-chat-${widgetKey.replace(/[^A-Za-z0-9_-]/g, '')}`, [widgetKey]);

  useEffect(() => {
    if (loaded) {
      if (loaded !== widgetKey) console.warn('[DialogPlus] One widget per page: keep the first one.');
      return;
    }
    loaded = widgetKey;
    dialogPlus();
    const script = document.createElement('script');
    script.src = `${loaderUrl || DEFAULT_LOADER}?key=${encodeURIComponent(widgetKey)}`;
    script.async = true;
    if (mode === 'inline') {
      script.setAttribute('data-mode', 'inline');
      script.setAttribute('data-target', `#${id}`);
    }
    document.body.appendChild(script);
  }, [id, loaderUrl, mode, widgetKey]);

  useEffect(() => {
    if (identityToken) dialogPlus()('identify', { token: identityToken });
  }, [identityToken]);
  const attributesKey = JSON.stringify(attributes || {});
  useEffect(() => {
    if (attributes && Object.keys(attributes).length) dialogPlus()('setAttributes', attributes);
  }, [attributesKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const configKey = JSON.stringify(config || {});
  useEffect(() => {
    if (config) dialogPlus()('config', config);
  }, [configKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (consent !== undefined) dialogPlus()('consent', consent);
  }, [consent]);

  return mode === 'inline' ? <div id={id} ref={box} className={className} style={{ minHeight: 480, ...style }} /> : null;
}

/** Open, close or sign out the ready-made chat from anywhere in your app. */
export const dialogPlusCommands = {
  open: () => dialogPlus()('open'),
  close: () => dialogPlus()('close'),
  /** Someone signed out: their chat leaves this device. */
  reset: () => dialogPlus()('reset'),
  send: (text: string) => dialogPlus()('send', text),
};

export interface ChatState {
  ready: boolean;
  messages: ChatMessage[];
  /** The team or a journey is writing. */
  typing: boolean;
  error: unknown;
  chat: Chat | null;
}

/** Your own chat UI: start the chat, keep messages live, send and upload. */
export function useDialogPlusChat(options: ChatOptions | null): ChatState & {
  send: Chat['send']; upload: Chat['upload'];
} {
  const [state, setState] = useState<ChatState>({ ready: false, messages: [], typing: false, error: null, chat: null });
  const key = options ? `${options.widgetKey}|${options.identityToken || ''}|${options.apiUrl || ''}` : '';

  useEffect(() => {
    if (!options) return undefined;
    const chat = createChat(options);
    let stop: (() => void) | null = null;
    let cancelled = false;
    const add = (incoming: ChatMessage[]) => setState((s) => {
      const seen = new Set(s.messages.map((m) => m.id));
      const fresh = incoming.filter((m) => !seen.has(m.id));
      return fresh.length ? { ...s, messages: [...s.messages, ...fresh].sort((a, b) => a.id - b.id) } : s;
    });
    chat.start().then((result) => {
      if (cancelled) return;
      setState((s) => ({ ...s, ready: true, chat, error: null }));
      add(result.messages);
      stop = chat.subscribe((event) => {
        if (event.type === 'message') add([event.message]);
        else if (event.type === 'typing') setState((s) => ({ ...s, typing: event.on }));
        else if (event.type === 'closed') setState((s) => ({ ...s, ready: false }));
      });
    }).catch((error) => { if (!cancelled) setState((s) => ({ ...s, error })); });
    return () => { cancelled = true; stop?.(); };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const missing = () => Promise.reject(new Error('The chat has not started yet.'));
  return {
    ...state,
    send: (message) => (state.chat ? state.chat.send(message).then((m) => {
      setState((s) => (s.messages.some((x) => x.id === m.id) ? s : { ...s, messages: [...s.messages, m] }));
      return m;
    }) : missing()),
    upload: (file, filename, caption) => (state.chat ? state.chat.upload(file, filename, caption) : missing()),
  };
}

export { createChat } from './client.js';
export type { Chat, ChatEvent, ChatMessage, ChatOptions, StartResult, TokenStorage } from './client.js';
