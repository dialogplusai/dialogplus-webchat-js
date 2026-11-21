# DialogPlus AI web chat for developers

Put your DialogPlus AI journeys on your website or app: drop in the ready-made
chat, or build your own chat UI on the public chat API.

## Install

```sh
npm install @dialogplus/webchat
```

## The ready-made chat in React

```tsx
import { DialogPlusWidget, dialogPlusCommands } from '@dialogplus/webchat/react';

export function App({ user }) {
  return (
    <>
      {/* The chat button, bottom corner. One widget per page. */}
      <DialogPlusWidget
        widgetKey="wk_..."
        identityToken={user?.chatToken}          // signed in: their chat follows them across devices
        attributes={{ plan: user?.plan ?? 'free' }}  // {{web.plan}} in your journeys
      />
      <button onClick={dialogPlusCommands.open}>Chat with us</button>
    </>
  );
}
```

`mode="inline"` puts the chat inside the component's box instead of a
button. On sign-out, call `dialogPlusCommands.reset()` so the next person on
the device doesn't see the chat.

The widget's key is in DialogPlus AI under **Web chat -> your widget -> Install**.
Add your site to the widget's allowed domains (Security tab).

## Your own chat UI

```ts
import { createChat } from '@dialogplus/webchat';

const chat = createChat({
  widgetKey: 'wk_...',
  storage: { get: (k) => localStorage.getItem(k), set: (k, v) => v ? localStorage.setItem(k, v) : localStorage.removeItem(k) },
});

const { messages } = await chat.start();         // continues the visitor's chat if the token is kept
const stop = chat.subscribe((event) => {
  if (event.type === 'message') render(event.message);
  if (event.type === 'typing') showTyping(event.on);
});
await chat.send({ text: 'Do you deliver to Pune?' });
await chat.send({ buttonId: 'opt_2', buttonTitle: 'Track my order' });  // a tapped button
```

In React, `useDialogPlusChat({ widgetKey })` gives `messages`, `typing`,
`send` and `upload`, kept live.

### What messages look like

Every message has a `kind` and a `body`:

| kind | body |
| --- | --- |
| `text` | `text` |
| `buttons` | `text`, `buttons: [{ id, title }]` (send the id and title back) |
| `list` | `text`, `list: { button, sections: [{ title, rows: [{ id, title, description }] }] }` |
| `media` | `media: { type, url, filename }`, `text` (caption) |
| `link` | `text`, `link: { url, label }` |
| `location_request` | `text` (ask the browser, then `send({ location })`) |
| `cards` | `cards: [{ title, body, media, buttons }]` |
| `form` | `form: { cta, screens }` (answer with `submitForm`) |
| `products` | `products: { catalog_id, sections: [{ title, items }] }` (order with `sendCart`) |

Text is plain text: show it as text, never as HTML.

### Errors

Calls throw `ChatError` with the API's `code` and HTTP `status`. Worth
handling:

- `human_check` (428): show Cloudflare Turnstile and send its token as
  `humanToken` (asked only after unusual activity).
- `visitor_blocked` (403): the business blocked this visitor.
- `session_expired` (401): call `start()` again.

### Signed-in visitors

Your server signs a short-lived JWT (HS256) with the widget's secret: `sub`
(your user id) and `exp` (at most 24 hours ahead) are required; `name`, `email` and `phone` are
optional. Never put the secret in a page or an app.

### From your server

Your backend can open a signed user's chat with a workspace API key (a
service account with the Web chat permission is enough), then hand the
token to your app or use it itself:

```bash
curl -X POST "https://api.dialogplus.ai/api/webchat/widgets/<widget id>/sessions" \
  -H "Authorization: Bearer dpk_live_..." -H "Content-Type: application/json" \
  -d '{"user_id": "crm-777", "name": "Asha Rao", "attributes": {"plan": "gold"}}'
# -> {"token": "wst_...", "session_id": "...", "created": true}
```

Keep API keys on your server only.
