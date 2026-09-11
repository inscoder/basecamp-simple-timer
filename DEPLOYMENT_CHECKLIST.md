# Deployment Checklist

Use this checklist to verify the [self-hosting setup](docs/SETUP.md). For redeploys, reuse existing configuration, database, and secrets; repeat the checks relevant to your change.

## Prerequisites

- [ ] Follow the configuration guide in [setup guide](docs/SETUP.md#before-you-start).
- [ ] Install Node.js and npm, then run `npx wrangler login` from the repository root.
- [ ] Run `npm run check`.
- [ ] For first setup, copy `worker/wrangler.example.jsonc` to ignored `worker/wrangler.production.jsonc` and `extension/config.example.js` to ignored `extension/config.js`.
- [ ] Load the extension early if restricting its redirect origin; copy its ID from `chrome://extensions`.

## Basecamp OAuth

- [ ] Create the integration at `https://launchpad.37signals.com/integrations`.
- [ ] Set redirect URI to `https://YOUR_WORKER_DOMAIN/auth/callback`.
- [ ] Copy the Basecamp client ID into local `worker/wrangler.production.jsonc`.

## Cloudflare Worker

- [ ] Create the D1 database with `npx wrangler d1 create basecamp_simple_timer`.
- [ ] Copy `worker/wrangler.example.jsonc` to ignored local `worker/wrangler.production.jsonc` if it does not already exist.
- [ ] Copy the D1 database ID into local `worker/wrangler.production.jsonc`.
- [ ] Set `BACKEND_BASE_URL` in local `worker/wrangler.production.jsonc` to the deployed Worker URL.
- [ ] Set `APP_USER_AGENT` to a contactable team email.
- [ ] Replace `ALLOWED_EXTENSION_REDIRECT_ORIGIN` with the actual extension origin, or clear it to `""`; do not leave the placeholder.
- [ ] Optionally set `TEAM_EMAIL_DOMAIN`.
- [ ] Optionally set `ALLOWED_BASECAMP_ACCOUNT_IDS`.
- [ ] Deploy once to create/update the production Worker with `npm run worker:prod:deploy`.
- [ ] Confirm `BACKEND_BASE_URL` and `extension/config.js` use the printed Worker origin, and the Basecamp callback is that origin plus `/auth/callback`.
- [ ] Store the Basecamp client secret with `npm run worker:prod:secret:basecamp`.
- [ ] Generate a long `TOKEN_ENCRYPTION_KEY` with `openssl rand -base64 48`, then store it with `npm run worker:prod:secret:encryption`.
- [ ] Optionally generate an `ADMIN_TOKEN` with `openssl rand -base64 48`, then store it with `npm run worker:prod:secret:admin`.
- [ ] Apply D1 schema with `npm run worker:prod:d1:apply`.
- [ ] Deploy again with `npm run worker:prod:deploy`.

## Backend Verification

- [ ] Open `https://YOUR_WORKER_DOMAIN/` and confirm the status page renders.
- [ ] Open `https://YOUR_WORKER_DOMAIN/health` and confirm it returns `"ok": true`.
- [ ] Run `npm run worker:prod:dry-run` before any future deploys.

## Chrome Extension

- [ ] Copy `extension/config.example.js` to ignored local `extension/config.js`.
- [ ] Load the `extension/` folder as an unpacked extension from `chrome://extensions`.
- [ ] Set the deployed Worker URL in local `extension/config.js`.
- [ ] Reload the unpacked extension.
- [ ] Click `Connect Basecamp`.
- [ ] Complete the Basecamp OAuth flow.
- [ ] Confirm the popup shows the connected Basecamp user.

## Timesheet Smoke Test

- [ ] Open a Basecamp to-do or card in the allowed account.
- [ ] Start a timer.
- [ ] Let it reach at least `0.01` hours.
- [ ] Click `Log`.
- [ ] Confirm the local timer disappears after success.
- [ ] Confirm the Timesheet entry appears in Basecamp with the expected date, hours, and description.
- [ ] Delete the test Timesheet entry from Basecamp if it should not remain.

## Admin Smoke Test

See the [admin API reference](docs/API.md#admin-api) for endpoint authentication.

- [ ] If `ADMIN_TOKEN` is configured, call `GET /admin/users` with `Authorization: Bearer ADMIN_TOKEN`.
- [ ] Confirm the connected user appears.
- [ ] Test `POST /admin/revoke-user-sessions` for a test user if safe.
- [ ] Confirm that revoked user must reconnect from the extension.
