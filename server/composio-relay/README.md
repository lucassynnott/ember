# Composio relay

A Cloudflare Worker that lets Meeting Notes connect Linear, Notion and Google Drive through your
Composio project, so users don't need their own Composio account.

- The Composio **project API key** is a Worker secret. It is never shipped in the app.
- Each app install sends a random 64-hex secret; its Composio user id is `mn_` + a hash of it, so
  installs can't see or use each other's connections.
- Only the tools listed in `TOOLKITS` in `worker.mjs` can run, and the Composio sign-in configs it
  creates are restricted to the same tools.
- A best-effort limit of 60 requests a minute per install.

## Deploy

1. In the Composio dashboard, create a project for Meeting Notes and copy its API key.
2. `cd server/composio-relay && npx wrangler login`
3. `npx wrangler secret put COMPOSIO_API_KEY`
4. `npx wrangler deploy`, then put the Worker's URL in `src/composio-apps.js` (`HOSTED_RELAY_URL`).

The first time someone connects an app, the relay creates a Composio-managed sign-in config for it
("Meeting Notes · linear" and so on). Usage counts against your Composio plan; the free Hobby plan
stops at its limit rather than charging.
