# Development Guide

This tool is built for our team's internal use. Development priorities follow our team's workflow and needs.

## Project Structure

```text
basecamp-simple-timer/
├── extension/
│   ├── background.js       # Timer state, URL parsing, backend requests
│   ├── popup.js            # Popup rendering and interactions
│   ├── popup.html
│   ├── popup.css
│   ├── manifest.json       # Chrome permissions and extension metadata
│   ├── config.example.js   # Template for ignored config.js
│   └── icons/
├── worker/
│   ├── src/index.mjs       # OAuth, sessions, encryption, Timesheet API
│   ├── schema.sql          # D1 tables and indexes
│   ├── test.mjs            # Mocked Worker tests
│   ├── wrangler.example.jsonc
│   └── .dev.vars.example
├── test/                   # Extension checks
└── docs/                   # Setup and API reference
```

The extension is loaded directly from `extension/`; it has no build step. The Worker is bundled and deployed with Wrangler. See the [setup guide](docs/SETUP.md) for prerequisites and a complete hosted installation.

## Checks

```bash
npm run check
```

This runs JavaScript syntax checks, manifest/popup checks, mocked Worker OAuth and logging tests, and mocked extension background tests. These checks do not require credentials and do not contact Basecamp or Cloudflare. They do not replace the [live deployment checks](DEPLOYMENT_CHECKLIST.md).

## Local Worker Development

For local Worker development, create separate local configuration and initialize the local D1 schema:

```bash
cp worker/wrangler.example.jsonc worker/wrangler.jsonc
cp worker/.dev.vars.example worker/.dev.vars
# Fill in both local files before starting the Worker.
npx wrangler d1 execute basecamp_simple_timer --local --file worker/schema.sql --config worker/wrangler.jsonc
npm run worker:dev
```

Local `.dev.vars` values do not configure production secrets. Local D1 is separate from production; see [Cloudflare local development](https://developers.cloudflare.com/d1/best-practices/local-development/). The current OAuth readiness check requires an HTTPS `BACKEND_BASE_URL`, so plain `http://localhost:8787` is insufficient for an end-to-end OAuth connection. Use the deployed HTTPS Worker for the first complete setup.

## Configuration and Deployment Commands

| Command | Configuration / effect |
| --- | --- |
| `npm run worker:dev` | Uses ignored `worker/wrangler.jsonc` for local development. |
| `npm run worker:dry-run` | Validates a bundle using `worker/wrangler.jsonc` without deploying. |
| `npm run worker:prod:dry-run` | Validates a bundle using `worker/wrangler.production.jsonc` without deploying. |
| `npm run worker:deploy` / `worker:prod:deploy` | Deploys the Worker selected by the respective config. |
| `npm run worker:d1:apply` / `worker:prod:d1:apply` | Applies the schema to a **remote** database; both scripts use `--remote`. |
| `npm run worker:prod:secret:*` | Sets secrets on the production Worker. |

For a differently named local config, invoke Wrangler explicitly, for example:

```bash
npx wrangler deploy --dry-run --config worker/wrangler.dev.jsonc
```

The extension reads only `extension/config.js`. Copy any selected config variant there and reload the extension when switching backends.

## Preparing Changes

Keep changes focused and run the checks relevant to changed behavior. Update the setup guide, example templates, and deployment checklist when configuration changes. Use fictional data in tests and examples.

Do not commit credentials, private configuration, local database state, or extension packages containing deployment configuration. Inspect the staged diff before publishing.
