# Coding Agent Instructions

## Architecture

- `extension/background.js` owns persistent timer state, page parsing, and backend calls. `extension/popup.js` owns popup presentation and interactions.
- `worker/src/index.mjs` owns OAuth, encrypted token storage, sessions, access restrictions, and Basecamp Timesheet requests. D1 schema is in `worker/schema.sql`.
- Read [CONTRIBUTING.md](CONTRIBUTING.md) for development commands and [docs/SETUP.md](docs/SETUP.md) for configuration. Keep user-facing instructions in those documents.

## Behavior to Preserve

- Calculate elapsed time from persisted timestamps; keep only one task running at a time.
- Keep stopwatch and copy-to-clipboard features usable without a backend connection.
- Preserve supported Basecamp host/page validation.
- Remove a timer after logging only when the backend reports success. Preserve it on failure.
- Keep Basecamp access and refresh tokens in the backend, encrypted in D1. The extension receives only an app session token.
- Preserve session validation, OAuth redirect validation, and configured email/account restrictions.

## Validation

- Run `npm run check` after code changes. It uses local syntax checks and mocked external services; report it as such.
- For Worker bundling changes, run the appropriate Wrangler dry-run if the required local config is available. Do not invent credentials to make it pass.
- For documentation-only changes, verify relative links and referenced commands/config paths.
- Deployment, secret-setting, and both npm D1 schema-apply scripts modify remote resources. Do not use them as routine checks; run them only within an explicitly requested deployment or administration task.

## Configuration and Documentation

- Use fictional values in tests and committed examples. Never commit secrets, private runtime config, `.wrangler` state, or packages containing private configuration.
- The extension loads `extension/config.js`; named variants are not selected automatically.
- Preserve existing private configuration and user changes when editing.
- Update example templates, setup instructions, and the deployment checklist together when configuration changes.
- Keep the README focused on installation, usage, privacy, and limitations. Put detailed setup in `docs/SETUP.md`, API details in `docs/API.md`, and development instructions in `CONTRIBUTING.md`.
