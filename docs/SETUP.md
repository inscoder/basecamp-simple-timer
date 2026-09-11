# Self-hosting Setup

This repo has two deployable pieces: a Cloudflare Worker backend and the unpacked Chrome extension.

For live rollout, use the [deployment checklist](../DEPLOYMENT_CHECKLIST.md) to verify Basecamp OAuth, Cloudflare, Chrome, and one real Timesheet smoke test.

## Before You Start

For the stopwatch alone, follow the [quick start](../README.md#quick-start). This guide adds direct Basecamp Timesheet logging through your own backend.

For direct Timesheet logging, you also need:

* Node.js and npm compatible with [Cloudflare Wrangler](https://developers.cloudflare.com/workers/get-started/guide/).
* Your own Cloudflare account with Workers and D1 access.
* Your own Basecamp OAuth integration and a Basecamp user who can create Timesheet entries.

Download or clone this repository, open a terminal in its root folder (the folder containing `package.json`), and sign in to Cloudflare:

```bash
npx wrangler login
npm run check
```

The commands below use a Bash-compatible shell, such as macOS Terminal. This repository does not include a shared backend or credentials; each deployment owner supplies their own.

## Local Configuration

This is an open source repo, so real deployment config is intentionally not committed. Start by copying the templates:

```bash
cp worker/wrangler.example.jsonc worker/wrangler.production.jsonc
cp extension/config.example.js extension/config.js
```

Fill in the production config using the guide below. The copied files are ignored by Git. Production secrets are entered through Wrangler prompts in the Backend steps, not into these files.

| Setting | Where to get it / what to enter |
| --- | --- |
| `name` | Your Worker name; the example uses `basecamp-simple-timer-api`. |
| `BACKEND_BASE_URL` | Your deployed HTTPS Worker origin, without `/auth/callback`. With the default name, this is `https://basecamp-simple-timer-api.YOUR_SUBDOMAIN.workers.dev`; replace `YOUR_SUBDOMAIN` with your Cloudflare Workers subdomain. |
| `BASECAMP_CLIENT_ID` | The client ID from your Basecamp OAuth integration. The client secret is stored separately. |
| `APP_USER_AGENT` | App name and your contact email, e.g. `Basecamp Simple Timer (maintainer@example.com)`. |
| `database_id` | The ID returned by `npx wrangler d1 create basecamp_simple_timer`. Keep the `DB` binding name unchanged. |
| `TEAM_EMAIL_DOMAIN` | Optional email restriction, e.g. `example.com` without `@`; empty means no email-domain restriction. |
| `ALLOWED_BASECAMP_ACCOUNT_IDS` | Optional comma-separated account IDs. In `https://3.basecamp.com/1234567/buckets/...`, the account ID is `1234567`. Empty means no configured account allowlist. |
| `ALLOWED_EXTENSION_REDIRECT_ORIGIN` | Load the extension first, copy its ID from `chrome://extensions`, and enter `https://YOUR_ACTUAL_EXTENSION_ID.chromiumapp.org`. Replace the template value, or set it to `""` to allow any valid Chromium extension redirect origin. |

Cloudflare explains how to find/configure your [Workers subdomain](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/). No custom domain is needed. Confirm the actual URL printed by the first deploy matches your config and Basecamp callback URL.

The Basecamp OAuth callback is your **Worker URL plus `/auth/callback`**. The Chromium redirect origin above is a separate setting used when the Worker returns control to the extension.

For example, `extension/config.js` should contain the following, with the URL replaced by your actual deployment URL:

```js
globalThis.BASECAMP_TIMER_CONFIG = {
  backendUrl: 'https://basecamp-simple-timer-api.YOUR_SUBDOMAIN.workers.dev'
};
```

The extension reads only `extension/config.js`. If you maintain variants such as `config.production.js`, copy the selected variant to `config.js` before loading or reloading the extension. Do not put OAuth secrets in extension files.

For separate dev and production deployments, keep private files such as `worker/wrangler.dev.jsonc`, `worker/wrangler.production.jsonc`, `extension/config.dev.js`, and `extension/config.production.js`. Production npm scripts use `worker/wrangler.production.jsonc`.

## Backend

1. Register a Basecamp OAuth integration at `https://launchpad.37signals.com/integrations`.

2. Set the OAuth redirect URI to:

   ```
   https://YOUR_WORKER_DOMAIN/auth/callback
   ```

3. Create a D1 database:

   ```bash
   npx wrangler d1 create basecamp_simple_timer
   ```

4. Update your local `worker/wrangler.production.jsonc` with your Worker URL, Basecamp client ID, D1 database ID, user agent, optional extension redirect origin, optional `TEAM_EMAIL_DOMAIN`, and optional `ALLOWED_BASECAMP_ACCOUNT_IDS`.

5. Deploy once to create or update the production Worker:

   ```bash
   npm run worker:prod:deploy
   ```

6. Add production secrets:

   ```bash
   npm run worker:prod:secret:basecamp
   npm run worker:prod:secret:encryption
   ```

   Each command prompts for its secret value. Use the client secret from your Basecamp integration for the first command. Generate an encryption key with `openssl rand -base64 48` and paste it into the encryption-secret prompt. If enabling the admin API, generate a separate random value and store it with `npm run worker:prod:secret:admin`.

   Keep the encryption key stable: existing stored OAuth tokens depend on it for decryption.
   `ADMIN_TOKEN` is optional but recommended; it enables the [admin endpoints](API.md#admin-api).

7. Apply the D1 schema, validate the bundle, and deploy again:

   ```bash
   npm run worker:prod:d1:apply
   npm run worker:prod:dry-run
   npm run worker:prod:deploy
   ```

8. Open these URLs after deploy:

   * `https://YOUR_WORKER_DOMAIN/` should show a simple status page.
   * `https://YOUR_WORKER_DOMAIN/health` should return JSON with `"ok": true`.

   If `/health` returns `503`, fix the reported configuration checks before connecting the Chrome extension.

## Extension

1. Open Google Chrome and navigate to `chrome://extensions`.

2. Enable Developer mode using the toggle switch in the top-right corner.

3. Click the Load unpacked button in the top-left corner.

4. Select the `extension/` folder containing `manifest.json`.

5. Set your Worker URL in local `extension/config.js`, reload the unpacked extension, then click `Connect Basecamp`.

## Setup Troubleshooting

| Symptom | Check |
| --- | --- |
| Production config file not found | Run the copy command for `worker/wrangler.production.jsonc` above. |
| `/health` returns `503` | Read its `errors` list. Replace placeholders, set both required secrets, and replace or clear the extension redirect origin. |
| OAuth redirect rejected | Match the Basecamp integration callback exactly to `BACKEND_BASE_URL` plus `/auth/callback`. Check the extension ID separately. |
| Extension cannot connect | Make `extension/config.js` point at the same Worker, reload the extension, and grant the backend host permission when prompted. |
| Database table missing | Run `npm run worker:prod:d1:apply` for the production database. |
| User/account rejected | Check `TEAM_EMAIL_DOMAIN`, `ALLOWED_BASECAMP_ACCOUNT_IDS`, and the connected user's access. |
| Timer works but logging fails | Verify the user can log time in Basecamp and test on a supported to-do or card. |


After connecting, complete the [Timesheet smoke test](../DEPLOYMENT_CHECKLIST.md#timesheet-smoke-test). For local development, see [CONTRIBUTING.md](../CONTRIBUTING.md).
