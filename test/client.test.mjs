// The web chat client (src/client.ts) against a fake API: starting and
// keeping the chat token, sending, catching up after a reconnect, and the
// stream parser's line endings. Runs on Node's test runner; TypeScript is
// borrowed from the app's frontend install (this package has no build step
// of its own in the repo).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { test } from 'node:test';

// TypeScript from this package's own devDependencies (the public repository),
// else from the app's frontend install (inside the DialogPlus repository).
function loadTypeScript() {
  for (const base of ['../package.json', '../../../frontend/package.json']) {
    try { return createRequire(new URL(base, import.meta.url))('typescript'); } catch { /* try the next */ }
  }
  throw new Error('TypeScript is needed to run these tests: npm install');
}
const ts = loadTypeScript();
const source = await readFile(new URL('../src/client.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const mod = { exports: {} };
new Function('require', 'module', 'exports', compiled)(() => ({}), mod, mod.exports);
const { createChat, takeEvents, ChatError } = mod.exports;

function fakeApi(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const path = url.replace('https://api.example.test/api', '');
    calls.push({ path, method: init.method || 'GET', headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : undefined });
    const handler = routes[`${init.method || 'GET'} ${path.split('?')[0]}`];
    if (!handler) return new Response(JSON.stringify({ detail: { code: 'nope', message: 'Not here' } }), { status: 404 });
    const [status, body] = handler(calls[calls.length - 1]);
    return new Response(JSON.stringify(body), { status });
  };
  return { fetch, calls };
}

test('the stream parser reads every line ending', () => {
  const { events, rest } = takeEvents('event: ready\r\ndata: {}\r\n\r\n: ping\n\nevent: message\ndata: {"id":3}\n\nevent: typ');
  assert.deepEqual(events, [{ event: 'ready', data: '{}' }, { event: 'message', data: '{"id":3}' }]);
  assert.equal(rest, 'event: typ');
});

test('a chat starts with the kept token, sends with it, and remembers the new one', async () => {
  const store = new Map([['dp_webchat_wk_test', 'old-token']]);
  const api = fakeApi({
    'POST /v1/webchat/wk_test/sessions': () => [200, { token: 'wst_new', session: { id: 's1' }, config: {},
      messages: [{ id: 4, direction: 'out', sender: 'bot', kind: 'text', body: { kind: 'text', text: 'Hi' } }] }],
    'POST /v1/webchat/messages': (call) => [200, { message: { id: 5, direction: 'in', sender: 'visitor', kind: 'text',
      body: { kind: 'text', text: call.body.text } } }],
    'GET /v1/webchat/messages': () => [200, { messages: [{ id: 6, direction: 'out', sender: 'bot', kind: 'text', body: { kind: 'text', text: 'Yes' } }] }],
  });
  const chat = createChat({ widgetKey: 'wk_test', apiUrl: 'https://api.example.test/api/', fetch: api.fetch,
    attributes: { plan: 'gold' },
    storage: { get: (k) => store.get(k) ?? null, set: (k, v) => { store.set(k, v); } } });
  const started = await chat.start();
  assert.equal(started.session.id, 's1');
  assert.equal(api.calls[0].body.token, 'old-token');
  assert.deepEqual(api.calls[0].body.attributes, { plan: 'gold' });
  assert.equal(store.get('dp_webchat_wk_test'), 'wst_new');
  const sent = await chat.send({ text: 'Do you ship?' });
  assert.equal(sent.body.text, 'Do you ship?');
  assert.equal(api.calls[1].headers.Authorization, 'Bearer wst_new');
  assert.ok(api.calls[1].body.client_id.startsWith('sdk-'));
  const missed = await chat.messages();
  assert.equal(api.calls[2].path, '/v1/webchat/messages?after=5');            // after the newest seen
  assert.equal(missed[0].body.text, 'Yes');
});

test('errors carry the API code, and ending forgets the chat', async () => {
  const store = new Map();
  const api = fakeApi({
    'POST /v1/webchat/wk_test/sessions': () => [200, { token: 'wst_1', session: { id: 's1' }, config: {}, messages: [] }],
    'POST /v1/webchat/messages': () => [428, { detail: { code: 'human_check', message: 'Please confirm you’re a person.' } }],
    'DELETE /v1/webchat/sessions': () => [200, { ok: true }],
  });
  const chat = createChat({ widgetKey: 'wk_test', apiUrl: 'https://api.example.test/api', fetch: api.fetch,
    storage: { get: (k) => store.get(k) ?? null, set: (k, v) => { store.set(k, v); } } });
  await chat.start();
  await assert.rejects(chat.send({ text: 'x' }), (err) => err instanceof ChatError && err.code === 'human_check' && err.status === 428);
  await chat.end();
  assert.equal(chat.token, null);
  assert.equal(store.get('dp_webchat_wk_test'), null);
});
