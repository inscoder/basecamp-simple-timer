const BASECAMP_AUTH_URL = 'https://launchpad.37signals.com/authorization/new';
const BASECAMP_TOKEN_URL = 'https://launchpad.37signals.com/authorization/token';
const BASECAMP_AUTHORIZATION_URL = 'https://launchpad.37signals.com/authorization.json';
const DEFAULT_SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const OAUTH_STATE_TTL_SECONDS = 10 * 60;
const TOKEN_REFRESH_SKEW_SECONDS = 60 * 60;

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  }
};

export async function handleRequest(request, env) {
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return corsResponse(null, request, env, { status: 204 });
  }

  try {
    if (url.pathname === '/health') {
      const readiness = configReadiness(env);
      return jsonResponse(readiness, request, env, { status: readiness.ok ? 200 : 503 });
    }

    if (url.pathname === '/' && request.method === 'GET') {
      return htmlResponse(statusPage(env), request, env);
    }

    if (url.pathname === '/auth/start' && request.method === 'GET') {
      return await startAuth(request, env);
    }

    if (url.pathname === '/auth/callback' && request.method === 'GET') {
      return await finishAuth(request, env);
    }

    if (url.pathname === '/api/me' && request.method === 'GET') {
      return await getMe(request, env);
    }

    if (url.pathname === '/api/log-time' && request.method === 'POST') {
      return await logTime(request, env);
    }

    if (url.pathname === '/api/logout' && request.method === 'POST') {
      return await logout(request, env);
    }

    if (url.pathname === '/admin/users' && request.method === 'GET') {
      return await adminListUsers(request, env);
    }

    if (url.pathname === '/admin/revoke-user-sessions' && request.method === 'POST') {
      return await adminRevokeUserSessions(request, env);
    }

    return jsonResponse({ error: 'Not found.' }, request, env, { status: 404 });
  } catch (error) {
    const status = error.status || 500;
    const message = status >= 500 ? 'Internal server error.' : error.message;
    return jsonResponse({ error: message }, request, env, { status });
  }
}

async function startAuth(request, env) {
  requireReadyConfig(env);
  await cleanupExpiredRows(env);

  const url = new URL(request.url);
  const extensionRedirectUri = url.searchParams.get('extension_redirect_uri');

  if (!isAllowedExtensionRedirect(extensionRedirectUri, env)) {
    throw httpError(400, 'Invalid extension redirect URI.');
  }

  const state = randomToken(32);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + OAUTH_STATE_TTL_SECONDS * 1000).toISOString();

  await env.DB.prepare(
    `INSERT INTO oauth_states (state, extension_redirect_uri, created_at, expires_at)
     VALUES (?, ?, ?, ?)`
  ).bind(state, extensionRedirectUri, now.toISOString(), expiresAt).run();

  const authUrl = new URL(BASECAMP_AUTH_URL);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', env.BASECAMP_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', callbackUrl(env));
  authUrl.searchParams.set('state', state);

  return Response.redirect(authUrl.toString(), 302);
}

async function finishAuth(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  if (!code || !state) {
    throw httpError(400, 'Missing OAuth code or state.');
  }

  const stateRow = await env.DB.prepare(
    `SELECT state, extension_redirect_uri, expires_at FROM oauth_states WHERE state = ?`
  ).bind(state).first();

  await env.DB.prepare(`DELETE FROM oauth_states WHERE state = ?`).bind(state).run();

  if (!stateRow || Date.parse(stateRow.expires_at) < Date.now()) {
    throw httpError(400, 'OAuth state expired. Start again from the extension.');
  }

  const tokenPayload = await exchangeAuthorizationCode(code, env);
  const authorization = await fetchAuthorization(tokenPayload.access_token, env);

  enforceTeamAccess(authorization.identity, env);
  enforceAllowedAccounts(authorization.accounts || [], env);

  const userId = await upsertUser(authorization, env);
  await storeBasecampTokens(userId, tokenPayload, env);
  const sessionToken = await createSession(userId, env);

  const redirectUrl = new URL(stateRow.extension_redirect_uri);
  redirectUrl.searchParams.set('session_token', sessionToken);

  return Response.redirect(redirectUrl.toString(), 302);
}

async function getMe(request, env) {
  const session = await requireSession(request, env);
  const user = await env.DB.prepare(
    `SELECT id, basecamp_identity_id, name, email, accounts_json FROM users WHERE id = ?`
  ).bind(session.user_id).first();

  if (!user) {
    throw httpError(401, 'Session user not found.');
  }

  return jsonResponse({
    id: user.id,
    basecampIdentityId: user.basecamp_identity_id,
    name: user.name,
    email: user.email,
    accounts: JSON.parse(user.accounts_json || '[]')
  }, request, env);
}

async function logTime(request, env) {
  const session = await requireSession(request, env);
  const payload = await readJson(request);
  const task = validateLogTimePayload(payload);
  logLocalDevPayload(request, task);
  const token = await getFreshAccessToken(session.user_id, env);
  const accounts = await getUserAccounts(session.user_id, env);

  if (!accounts.some(account => String(account.id) === task.accountId && account.product === 'bc3')) {
    throw httpError(403, 'This Basecamp account is not available to the authenticated user.');
  }
  if (!isAllowedBasecampAccount(task.accountId, env)) {
    throw httpError(403, 'This Basecamp account is not allowed for this team timer.');
  }

  const recordingId = task.projectLevel
    ? await resolveProjectTimesheetRecordingId(task, token, env)
    : task.recordingId;

  const entry = await basecampFetch(
    token,
    task.accountId,
    `/recordings/${recordingId}/timesheet/entries.json`,
    env,
    {
      method: 'POST',
      body: {
        date: task.date,
        hours: task.hours,
        description: task.description
      }
    }
  );

  return jsonResponse({ ok: true, entry }, request, env);
}

function logLocalDevPayload(request, task) {
  const hostname = new URL(request.url).hostname;
  if (hostname !== 'localhost' && hostname !== '127.0.0.1') return;

  console.log('log-time payload', {
    accountId: task.accountId,
    recordingId: task.recordingId,
    hours: task.hours,
    date: task.date,
    description: task.description
  });
}

async function logout(request, env) {
  const token = getBearerToken(request);
  if (token) {
    await env.DB.prepare(`DELETE FROM sessions WHERE token_hash = ?`).bind(await sha256Hex(token)).run();
  }
  return jsonResponse({ ok: true }, request, env);
}

async function adminListUsers(request, env) {
  requireAdmin(request, env);
  await cleanupExpiredSessions(env);

  const result = await env.DB.prepare(
    `SELECT users.id, users.basecamp_identity_id, users.name, users.email, users.updated_at,
            COUNT(sessions.token_hash) AS active_sessions
     FROM users
     LEFT JOIN sessions ON sessions.user_id = users.id AND sessions.expires_at >= ?
     GROUP BY users.id
     ORDER BY users.email`
  ).bind(new Date().toISOString()).all();

  return jsonResponse({
    users: (result.results || []).map(user => ({
      id: user.id,
      basecampIdentityId: user.basecamp_identity_id,
      name: user.name,
      email: user.email,
      updatedAt: user.updated_at,
      activeSessions: Number(user.active_sessions || 0)
    }))
  }, request, env);
}

async function adminRevokeUserSessions(request, env) {
  requireAdmin(request, env);
  const payload = await readJson(request);
  const email = String(payload.email || '').trim().toLowerCase();

  if (!email) {
    throw httpError(400, 'Email is required.');
  }

  const user = await env.DB.prepare(`SELECT id, email FROM users WHERE lower(email) = ?`).bind(email).first();
  if (!user) {
    throw httpError(404, 'User not found.');
  }

  await env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(user.id).run();
  return jsonResponse({ ok: true, userId: user.id, email: user.email }, request, env);
}

async function exchangeAuthorizationCode(code, env) {
  const body = new URLSearchParams();
  body.set('grant_type', 'authorization_code');
  body.set('client_id', env.BASECAMP_CLIENT_ID);
  body.set('client_secret', env.BASECAMP_CLIENT_SECRET);
  body.set('redirect_uri', callbackUrl(env));
  body.set('code', code);

  const response = await fetch(BASECAMP_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': userAgent(env)
    },
    body
  });

  if (!response.ok) {
    throw httpError(502, `Basecamp token exchange failed: ${await response.text()}`);
  }

  return response.json();
}

async function refreshAccessToken(refreshToken, env) {
  const body = new URLSearchParams();
  body.set('grant_type', 'refresh_token');
  body.set('refresh_token', refreshToken);
  body.set('client_id', env.BASECAMP_CLIENT_ID);
  body.set('client_secret', env.BASECAMP_CLIENT_SECRET);

  const response = await fetch(BASECAMP_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': userAgent(env)
    },
    body
  });

  if (!response.ok) {
    throw httpError(502, `Basecamp token refresh failed: ${await response.text()}`);
  }

  return response.json();
}

async function fetchAuthorization(accessToken, env) {
  const response = await fetch(BASECAMP_AUTHORIZATION_URL, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'User-Agent': userAgent(env)
    }
  });

  if (!response.ok) {
    throw httpError(502, `Basecamp authorization lookup failed: ${await response.text()}`);
  }

  return response.json();
}

async function upsertUser(authorization, env) {
  const identity = authorization.identity;
  const accountsJson = JSON.stringify(authorization.accounts || []);
  const name = [identity.first_name, identity.last_name].filter(Boolean).join(' ').trim();
  const now = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO users (basecamp_identity_id, name, email, accounts_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(basecamp_identity_id) DO UPDATE SET
       name = excluded.name,
       email = excluded.email,
       accounts_json = excluded.accounts_json,
       updated_at = excluded.updated_at`
  ).bind(String(identity.id), name, identity.email_address, accountsJson, now, now).run();

  const user = await env.DB.prepare(
    `SELECT id FROM users WHERE basecamp_identity_id = ?`
  ).bind(String(identity.id)).first();

  return user.id;
}

async function storeBasecampTokens(userId, tokenPayload, env) {
  if (!tokenPayload.access_token) {
    throw httpError(502, 'Basecamp token response did not include an access token.');
  }
  if (!tokenPayload.refresh_token) {
    throw httpError(502, 'Basecamp token response did not include a refresh token.');
  }

  const now = new Date().toISOString();
  const expiresIn = Number(tokenPayload.expires_in || 1209600);
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

  await env.DB.prepare(
    `INSERT INTO oauth_tokens (user_id, access_token_cipher, refresh_token_cipher, access_token_expires_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       access_token_cipher = excluded.access_token_cipher,
       refresh_token_cipher = excluded.refresh_token_cipher,
       access_token_expires_at = excluded.access_token_expires_at,
       updated_at = excluded.updated_at`
  ).bind(
    userId,
    await encryptText(tokenPayload.access_token, env.TOKEN_ENCRYPTION_KEY),
    await encryptText(tokenPayload.refresh_token, env.TOKEN_ENCRYPTION_KEY),
    expiresAt,
    now
  ).run();
}

async function createSession(userId, env) {
  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + sessionTtlSeconds(env) * 1000).toISOString();

  await env.DB.prepare(
    `INSERT INTO sessions (token_hash, user_id, created_at, expires_at)
     VALUES (?, ?, ?, ?)`
  ).bind(tokenHash, userId, now.toISOString(), expiresAt).run();

  return token;
}

async function requireSession(request, env) {
  await cleanupExpiredSessions(env);

  const token = getBearerToken(request);
  if (!token) {
    throw httpError(401, 'Missing session token.');
  }

  const tokenHash = await sha256Hex(token);
  const session = await env.DB.prepare(
    `SELECT token_hash, user_id, expires_at FROM sessions WHERE token_hash = ?`
  ).bind(tokenHash).first();

  if (!session || Date.parse(session.expires_at) < Date.now()) {
    throw httpError(401, 'Session expired. Connect to Basecamp again.');
  }

  return session;
}

async function getFreshAccessToken(userId, env) {
  const tokenRow = await env.DB.prepare(
    `SELECT access_token_cipher, refresh_token_cipher, access_token_expires_at FROM oauth_tokens WHERE user_id = ?`
  ).bind(userId).first();

  if (!tokenRow) {
    throw httpError(401, 'Basecamp token not found. Connect to Basecamp again.');
  }

  const expiresAt = Date.parse(tokenRow.access_token_expires_at);
  if (expiresAt - Date.now() > TOKEN_REFRESH_SKEW_SECONDS * 1000) {
    return decryptText(tokenRow.access_token_cipher, env.TOKEN_ENCRYPTION_KEY);
  }

  const refreshToken = await decryptText(tokenRow.refresh_token_cipher, env.TOKEN_ENCRYPTION_KEY);
  const refreshed = await refreshAccessToken(refreshToken, env);
  await storeBasecampTokens(userId, {
    ...refreshed,
    refresh_token: refreshed.refresh_token || refreshToken
  }, env);
  return refreshed.access_token;
}

async function getUserAccounts(userId, env) {
  const user = await env.DB.prepare(`SELECT accounts_json FROM users WHERE id = ?`).bind(userId).first();
  return user ? JSON.parse(user.accounts_json || '[]') : [];
}

async function cleanupExpiredRows(env) {
  await env.DB.prepare(`DELETE FROM oauth_states WHERE expires_at < ?`).bind(new Date().toISOString()).run();
  await cleanupExpiredSessions(env);
}

async function cleanupExpiredSessions(env) {
  await env.DB.prepare(`DELETE FROM sessions WHERE expires_at < ?`).bind(new Date().toISOString()).run();
}

async function resolveProjectTimesheetRecordingId(task, token, env) {
  const entries = await basecampFetch(token, task.accountId, `/projects/${task.recordingId}/timesheet.json`, env);

  if (!Array.isArray(entries)) {
    throw httpError(502, 'Basecamp returned an unexpected project timesheet response.');
  }

  const entry = entries.find(item => item.parent && item.parent.type === 'Timesheet');
  if (!entry || !entry.parent || !entry.parent.id) {
    throw httpError(400, 'Basecamp did not return the project Timesheet recording ID. Log from a to-do, card, message, document, or schedule entry instead.');
  }

  return String(entry.parent.id);
}

async function basecampFetch(token, accountId, path, env, options = {}) {
  const response = await fetch(`https://3.basecampapi.com/${accountId}${path}`, {
    method: options.method || 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': userAgent(env)
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  if (!response.ok) {
    throw httpError(response.status >= 500 ? 502 : response.status, await basecampError(response));
  }

  if (response.status === 204) return null;
  return response.json();
}

function validateLogTimePayload(payload) {
  const accountId = String(payload.accountId || '');
  const recordingId = String(payload.recordingId || '');
  const hours = String(payload.hours || '');
  const date = String(payload.date || '');
  const description = String(payload.description ?? '').slice(0, 1000);

  if (!/^\d+$/.test(accountId)) throw httpError(400, 'Invalid account ID.');
  if (!/^\d+$/.test(recordingId)) throw httpError(400, 'Invalid recording ID.');
  if (!/^\d+(\.\d{1,2})?$/.test(hours) || Number(hours) <= 0) throw httpError(400, 'Invalid hours value.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw httpError(400, 'Invalid date.');

  return {
    accountId,
    recordingId,
    hours,
    date,
    description,
    projectLevel: Boolean(payload.projectLevel)
  };
}

async function readJson(request) {
  try {
    return await request.json();
  } catch (error) {
    throw httpError(400, 'Request body must be JSON.');
  }
}

function enforceTeamAccess(identity, env) {
  const domain = env.TEAM_EMAIL_DOMAIN;
  if (!domain) return;

  const email = String(identity.email_address || '').toLowerCase();
  if (!email.endsWith(`@${domain.toLowerCase()}`)) {
    throw httpError(403, 'This Basecamp account is not allowed for this team timer.');
  }
}

function enforceAllowedAccounts(accounts, env) {
  const allowedIds = allowedBasecampAccountIds(env);
  if (!allowedIds.length) return;

  const hasAllowedAccount = accounts.some(account => account.product === 'bc3' && allowedIds.includes(String(account.id)));
  if (!hasAllowedAccount) {
    throw httpError(403, 'This user does not have access to an allowed Basecamp account.');
  }
}

function isAllowedBasecampAccount(accountId, env) {
  const allowedIds = allowedBasecampAccountIds(env);
  return !allowedIds.length || allowedIds.includes(String(accountId));
}

function allowedBasecampAccountIds(env) {
  return String(env.ALLOWED_BASECAMP_ACCOUNT_IDS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
}

function isAllowedExtensionRedirect(value, env) {
  if (!value) return false;
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    return false;
  }

  if (env.ALLOWED_EXTENSION_REDIRECT_ORIGIN && url.origin !== env.ALLOWED_EXTENSION_REDIRECT_ORIGIN) {
    return false;
  }

  return url.protocol === 'https:' && url.hostname.endsWith('.chromiumapp.org');
}

function callbackUrl(env) {
  return `${env.BACKEND_BASE_URL.replace(/\/$/, '')}/auth/callback`;
}

function userAgent(env) {
  return env.APP_USER_AGENT || 'Basecamp Simple Timer (internal)';
}

function sessionTtlSeconds(env) {
  return Number(env.SESSION_TTL_SECONDS || DEFAULT_SESSION_TTL_SECONDS);
}

function getBearerToken(request) {
  const header = request.headers.get('Authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function requireAdmin(request, env) {
  if (!env.ADMIN_TOKEN) {
    throw httpError(404, 'Not found.');
  }

  const token = getBearerToken(request);
  if (token !== env.ADMIN_TOKEN) {
    throw httpError(401, 'Invalid admin token.');
  }
}

async function basecampError(response) {
  try {
    const payload = await response.clone().json();
    return payload.message || payload.error || JSON.stringify(payload);
  } catch (error) {
    return await response.text();
  }
}

function requireEnv(env, names) {
  const missing = names.filter(name => !env[name]);
  if (missing.length) {
    throw httpError(500, `Missing required environment binding: ${missing.join(', ')}`);
  }
}

function requireReadyConfig(env) {
  const readiness = configReadiness(env);
  if (!readiness.ok) {
    throw httpError(500, `Worker configuration is not ready: ${readiness.errors.join(', ')}`);
  }
}

function configReadiness(env) {
  const errors = [];

  if (!env.DB) errors.push('DB binding is missing');
  if (!env.BASECAMP_CLIENT_SECRET) errors.push('BASECAMP_CLIENT_SECRET is missing');
  if (!env.TOKEN_ENCRYPTION_KEY) errors.push('TOKEN_ENCRYPTION_KEY is missing');
  if (!looksConfigured(env.BASECAMP_CLIENT_ID)) errors.push('BASECAMP_CLIENT_ID is not configured');
  if (!looksConfigured(env.BACKEND_BASE_URL) || !isHttpsUrl(env.BACKEND_BASE_URL)) errors.push('BACKEND_BASE_URL must be an HTTPS URL');
  if (env.ALLOWED_EXTENSION_REDIRECT_ORIGIN && !isChromiumAppOrigin(env.ALLOWED_EXTENSION_REDIRECT_ORIGIN)) errors.push('ALLOWED_EXTENSION_REDIRECT_ORIGIN must be your extension chromiumapp.org origin');
  if (env.TOKEN_ENCRYPTION_KEY && env.TOKEN_ENCRYPTION_KEY.length < 32) errors.push('TOKEN_ENCRYPTION_KEY must be at least 32 characters');

  return {
    ok: errors.length === 0,
    errors,
    checks: {
      db: Boolean(env.DB),
      basecampClientId: looksConfigured(env.BASECAMP_CLIENT_ID),
      basecampClientSecret: Boolean(env.BASECAMP_CLIENT_SECRET),
      backendBaseUrl: looksConfigured(env.BACKEND_BASE_URL) && isHttpsUrl(env.BACKEND_BASE_URL),
      allowedExtensionRedirectOrigin: !env.ALLOWED_EXTENSION_REDIRECT_ORIGIN || isChromiumAppOrigin(env.ALLOWED_EXTENSION_REDIRECT_ORIGIN),
      tokenEncryptionKey: Boolean(env.TOKEN_ENCRYPTION_KEY) && env.TOKEN_ENCRYPTION_KEY.length >= 32
    }
  };
}

function looksConfigured(value) {
  return Boolean(value) && !String(value).includes('replace-with') && !String(value).includes('YOUR_');
}

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === 'https:';
  } catch (error) {
    return false;
  }
}

function isChromiumAppOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      url.hostname.endsWith('.chromiumapp.org') &&
      url.origin === String(value).replace(/\/$/, '');
  } catch (error) {
    return false;
  }
}

function randomToken(bytes) {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return base64Url(data);
}

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function encryptionKey(secret) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function encryptText(text, secret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await encryptionKey(secret);
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text));
  return `${base64Url(iv)}.${base64Url(new Uint8Array(cipher))}`;
}

async function decryptText(value, secret) {
  const [ivPart, cipherPart] = value.split('.');
  const key = await encryptionKey(secret);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64UrlToBytes(ivPart) },
    key,
    base64UrlToBytes(cipherPart)
  );
  return new TextDecoder().decode(plain);
}

function base64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function jsonResponse(payload, request, env, init = {}) {
  return corsResponse(JSON.stringify(payload), request, env, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers || {})
    }
  });
}

function htmlResponse(body, request, env, init = {}) {
  return corsResponse(body, request, env, {
    ...init,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      ...(init.headers || {})
    }
  });
}

function corsResponse(body, request, env, init = {}) {
  const headers = new Headers(init.headers || {});
  const origin = request.headers.get('Origin');
  const allowedOrigin = corsOrigin(origin, env);

  headers.set('Access-Control-Allow-Origin', allowedOrigin);
  headers.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Authorization,Content-Type');
  headers.set('Vary', 'Origin');

  return new Response(body, { ...init, headers });
}

function corsOrigin(origin, env) {
  if (env.ALLOWED_EXTENSION_ORIGIN) return env.ALLOWED_EXTENSION_ORIGIN;
  if (origin && origin.startsWith('chrome-extension://')) return origin;
  return '*';
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function statusPage(env) {
  const configuredBaseUrl = env.BACKEND_BASE_URL ? escapeHtml(env.BACKEND_BASE_URL) : 'not configured';
  const readiness = configReadiness(env);
  const readinessText = readiness.ok ? 'ready' : `not ready: ${readiness.errors.map(escapeHtml).join(', ')}`;
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Basecamp Simple Timer API</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 40px; line-height: 1.5; color: #1f2933; }
    code { background: #f2f4f7; border-radius: 4px; padding: 2px 5px; }
  </style>
</head>
<body>
  <h1>Basecamp Simple Timer API</h1>
  <p>This Worker is running.</p>
  <p>Configuration status: <code>${readinessText}</code></p>
  <p>Configured backend URL: <code>${configuredBaseUrl}</code></p>
  <p>Use the Chrome extension to connect Basecamp and log time.</p>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
