# API Reference

Routes are relative to your deployed Worker URL.

## Backend API


The Worker exposes these endpoints. `/api/me`, `/api/log-time`, and `/api/logout` use the extension session token in the `Authorization: Bearer <session-token>` header:

* `GET /` shows a minimal backend status page.
* `GET /health` verifies that required Worker bindings and configuration values are present.
* `GET /auth/start` starts Basecamp OAuth.
* `GET /auth/callback` exchanges the Basecamp code, stores encrypted tokens in D1, and returns an app session to the extension.
* `GET /api/me` returns the connected user and accessible Basecamp accounts.
* `POST /api/log-time` creates a Basecamp Timesheet entry.
* `POST /api/logout` removes the app session.

Basecamp access and refresh tokens are encrypted before being stored in D1. The extension never receives them.

## Admin API

If `ADMIN_TOKEN` is configured as a Worker secret, these endpoints are available with `Authorization: Bearer ADMIN_TOKEN`:

* `GET /admin/users` lists connected users and active extension session counts.
* `POST /admin/revoke-user-sessions` with `{"email":"person@example.com"}` deletes all extension sessions for that user.

If `ADMIN_TOKEN` is not configured, admin endpoints return `404`.
