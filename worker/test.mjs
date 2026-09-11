import assert from 'node:assert/strict';
import worker, { handleRequest } from './src/index.mjs';

class FakeD1 {
  constructor() {
    this.oauthStates = new Map();
    this.users = new Map();
    this.usersByIdentity = new Map();
    this.tokens = new Map();
    this.sessions = new Map();
    this.nextUserId = 1;
  }

  prepare(sql) {
    return new FakeStatement(this, sql);
  }
}

class FakeStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
  }

  bind(...args) {
    return {
      run: async () => this.run(args),
      first: async () => this.first(args),
      all: async () => this.all(args)
    };
  }

  async run(args) {
    const sql = compact(this.sql);

    if (sql.startsWith('INSERT INTO oauth_states')) {
      this.db.oauthStates.set(args[0], {
        state: args[0],
        extension_redirect_uri: args[1],
        created_at: args[2],
        expires_at: args[3]
      });
      return { success: true };
    }

    if (sql.startsWith('DELETE FROM oauth_states WHERE expires_at')) {
      for (const [state, row] of this.db.oauthStates.entries()) {
        if (row.expires_at < args[0]) this.db.oauthStates.delete(state);
      }
      return { success: true };
    }

    if (sql.startsWith('DELETE FROM oauth_states')) {
      this.db.oauthStates.delete(args[0]);
      return { success: true };
    }

    if (sql.startsWith('INSERT INTO users')) {
      const [identityId, name, email, accountsJson, createdAt, updatedAt] = args;
      let id = this.db.usersByIdentity.get(identityId);
      if (!id) {
        id = this.db.nextUserId++;
        this.db.usersByIdentity.set(identityId, id);
      }
      this.db.users.set(id, {
        id,
        basecamp_identity_id: identityId,
        name,
        email,
        accounts_json: accountsJson,
        created_at: createdAt,
        updated_at: updatedAt
      });
      return { success: true };
    }

    if (sql.startsWith('INSERT INTO oauth_tokens')) {
      this.db.tokens.set(args[0], {
        user_id: args[0],
        access_token_cipher: args[1],
        refresh_token_cipher: args[2],
        access_token_expires_at: args[3],
        updated_at: args[4]
      });
      return { success: true };
    }

    if (sql.startsWith('INSERT INTO sessions')) {
      this.db.sessions.set(args[0], {
        token_hash: args[0],
        user_id: args[1],
        created_at: args[2],
        expires_at: args[3]
      });
      return { success: true };
    }

    if (sql.startsWith('DELETE FROM sessions WHERE expires_at')) {
      for (const [tokenHash, row] of this.db.sessions.entries()) {
        if (row.expires_at < args[0]) this.db.sessions.delete(tokenHash);
      }
      return { success: true };
    }

    if (sql.startsWith('DELETE FROM sessions WHERE user_id')) {
      for (const [tokenHash, row] of this.db.sessions.entries()) {
        if (row.user_id === args[0]) this.db.sessions.delete(tokenHash);
      }
      return { success: true };
    }

    if (sql.startsWith('DELETE FROM sessions')) {
      this.db.sessions.delete(args[0]);
      return { success: true };
    }

    throw new Error(`Unhandled run SQL: ${this.sql}`);
  }

  async first(args) {
    const sql = compact(this.sql);

    if (sql.startsWith('SELECT state, extension_redirect_uri')) {
      return this.db.oauthStates.get(args[0]) || null;
    }

    if (sql.startsWith('SELECT id FROM users WHERE basecamp_identity_id')) {
      const id = this.db.usersByIdentity.get(args[0]);
      return id ? { id } : null;
    }

    if (sql.startsWith('SELECT id, email FROM users WHERE lower(email)')) {
      const email = args[0];
      return [...this.db.users.values()].find(user => user.email.toLowerCase() === email) || null;
    }

    if (sql.startsWith('SELECT token_hash, user_id, expires_at')) {
      return this.db.sessions.get(args[0]) || null;
    }

    if (sql.startsWith('SELECT id, basecamp_identity_id')) {
      return this.db.users.get(args[0]) || null;
    }

    if (sql.startsWith('SELECT access_token_cipher')) {
      return this.db.tokens.get(args[0]) || null;
    }

    if (sql.startsWith('SELECT accounts_json')) {
      const user = this.db.users.get(args[0]);
      return user ? { accounts_json: user.accounts_json } : null;
    }

    throw new Error(`Unhandled first SQL: ${this.sql}`);
  }

  async all(args) {
    const sql = compact(this.sql);

    if (sql.startsWith('SELECT users.id, users.basecamp_identity_id')) {
      const now = args[0];
      const results = [...this.db.users.values()]
        .sort((a, b) => a.email.localeCompare(b.email))
        .map(user => ({
          id: user.id,
          basecamp_identity_id: user.basecamp_identity_id,
          name: user.name,
          email: user.email,
          updated_at: user.updated_at,
          active_sessions: [...this.db.sessions.values()]
            .filter(session => session.user_id === user.id && session.expires_at >= now).length
        }));
      return { results };
    }

    throw new Error(`Unhandled all SQL: ${this.sql}`);
  }
}

function compact(sql) {
  return sql.replace(/\s+/g, ' ').trim();
}

function testEnv() {
  return {
    DB: new FakeD1(),
    BACKEND_BASE_URL: 'https://timer.example.com',
    BASECAMP_CLIENT_ID: 'client-id',
    BASECAMP_CLIENT_SECRET: 'client-secret',
    TOKEN_ENCRYPTION_KEY: 'local-test-encryption-secret-32-chars',
    APP_USER_AGENT: 'Basecamp Simple Timer Test (test@example.com)',
    TEAM_EMAIL_DOMAIN: 'example.com',
    ALLOWED_BASECAMP_ACCOUNT_IDS: '999',
    ALLOWED_EXTENSION_REDIRECT_ORIGIN: 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org',
    ADMIN_TOKEN: 'admin-token'
  };
}

function installFetchMock() {
  const calls = [];
  let refreshCount = 0;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });

    if (String(url) === 'https://launchpad.37signals.com/authorization/token') {
      const params = new URLSearchParams(init.body);
      if (params.get('grant_type') === 'refresh_token') {
        refreshCount += 1;
        assert.equal(params.get('refresh_token'), 'basecamp-refresh-token');
        return Response.json({
          access_token: refreshCount === 1 ? 'refreshed-access-token' : 'refreshed-access-token-again',
          token_type: 'Bearer',
          expires_in: 1209600
        });
      }

      return Response.json({
        access_token: 'basecamp-access-token',
        refresh_token: 'basecamp-refresh-token',
        token_type: 'Bearer',
        expires_in: 1209600
      });
    }

    if (String(url) === 'https://launchpad.37signals.com/authorization.json') {
      return Response.json({
        expires_at: '2099-01-01T00:00:00Z',
        identity: {
          id: 123,
          first_name: 'Ada',
          last_name: 'Lovelace',
          email_address: 'ada@example.com'
        },
        accounts: [
          {
            product: 'bc3',
            id: 999,
            name: 'Example Co',
            href: 'https://3.basecampapi.com/999',
            app_href: 'https://3.basecamp.com/999'
          }
        ]
      });
    }

    if (String(url) === 'https://3.basecampapi.com/999/recordings/456/timesheet/entries.json') {
      assert.equal(init.method, 'POST');
      assert.equal(init.headers.Authorization, 'Bearer basecamp-access-token');
      assert.equal(init.headers['User-Agent'], 'Basecamp Simple Timer Test (test@example.com)');
      assert.deepEqual(JSON.parse(init.body), {
        date: '2026-05-29',
        hours: '1.25',
        description: 'Write docs'
      });
      return Response.json({ id: 111, hours: '1.25' }, { status: 201 });
    }

    if (String(url) === 'https://3.basecampapi.com/999/recordings/1010/timesheet/entries.json') {
      assert.equal(init.method, 'POST');
      assert.deepEqual(JSON.parse(init.body), {
        date: '2026-05-29',
        hours: '0.25',
        description: ''
      });
      return Response.json({ id: 444, hours: '0.25' }, { status: 201 });
    }

    if (String(url) === 'https://3.basecampapi.com/999/projects/777/timesheet.json') {
      return Response.json([
        {
          parent: {
            id: 888,
            type: 'Timesheet'
          }
        }
      ]);
    }

    if (String(url) === 'https://3.basecampapi.com/999/recordings/888/timesheet/entries.json') {
      assert.equal(init.method, 'POST');
      assert.deepEqual(JSON.parse(init.body), {
        date: '2026-05-29',
        hours: '2.00',
        description: 'Project planning'
      });
      return Response.json({ id: 222, hours: '2.00' }, { status: 201 });
    }

    if (String(url) === 'https://3.basecampapi.com/999/recordings/999/timesheet/entries.json') {
      assert.equal(init.method, 'POST');
      assert.equal(init.headers.Authorization, 'Bearer refreshed-access-token');
      assert.deepEqual(JSON.parse(init.body), {
        date: '2026-05-29',
        hours: '0.50',
        description: 'After token expiry'
      });
      return Response.json({ id: 333, hours: '0.50' }, { status: 201 });
    }

    if (String(url) === 'https://3.basecampapi.com/999/recordings/1000/timesheet/entries.json') {
      assert.equal(init.method, 'POST');
      assert.equal(init.headers.Authorization, 'Bearer refreshed-access-token-again');
      assert.deepEqual(JSON.parse(init.body), {
        date: '2026-05-29',
        hours: '0.75',
        description: 'After second token expiry'
      });
      return Response.json({ id: 555, hours: '0.75' }, { status: 201 });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };
  return calls;
}

async function run() {
  assert.equal(typeof worker.fetch, 'function');

  const env = testEnv();
  const calls = installFetchMock();
  const extensionRedirect = 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/basecamp';
  env.DB.oauthStates.set('expired-state', {
    state: 'expired-state',
    extension_redirect_uri: extensionRedirect,
    created_at: '2000-01-01T00:00:00.000Z',
    expires_at: '2000-01-01T00:10:00.000Z'
  });
  env.DB.sessions.set('expired-session-hash', {
    token_hash: 'expired-session-hash',
    user_id: 99,
    created_at: '2000-01-01T00:00:00.000Z',
    expires_at: '2000-01-01T00:10:00.000Z'
  });

  const healthResponse = await handleRequest(new Request('https://timer.example.com/health'), env);
  assert.equal(healthResponse.status, 200);
  assert.equal((await healthResponse.json()).ok, true);

  const statusResponse = await handleRequest(new Request('https://timer.example.com/'), env);
  assert.equal(statusResponse.status, 200);
  assert.match(await statusResponse.text(), /This Worker is running/);
  assert.match(await (await handleRequest(new Request('https://timer.example.com/'), env)).text(), /Configuration status: <code>ready<\/code>/);

  const unconfiguredEnv = {
    ...env,
    BASECAMP_CLIENT_ID: 'replace-with-basecamp-client-id',
    BACKEND_BASE_URL: 'https://basecamp-simple-timer-api.YOUR_SUBDOMAIN.workers.dev',
    ALLOWED_EXTENSION_REDIRECT_ORIGIN: 'not-a-valid-origin',
    TOKEN_ENCRYPTION_KEY: 'short'
  };
  const unconfiguredHealthResponse = await handleRequest(new Request('https://timer.example.com/health'), unconfiguredEnv);
  assert.equal(unconfiguredHealthResponse.status, 503);
  const unconfiguredHealth = await unconfiguredHealthResponse.json();
  assert.equal(unconfiguredHealth.ok, false);
  assert.ok(unconfiguredHealth.errors.includes('BASECAMP_CLIENT_ID is not configured'));
  assert.ok(unconfiguredHealth.errors.includes('BACKEND_BASE_URL must be an HTTPS URL'));
  assert.ok(unconfiguredHealth.errors.includes('ALLOWED_EXTENSION_REDIRECT_ORIGIN must be your extension chromiumapp.org origin'));
  assert.ok(unconfiguredHealth.errors.includes('TOKEN_ENCRYPTION_KEY must be at least 32 characters'));

  const startResponse = await handleRequest(
    new Request(`https://timer.example.com/auth/start?extension_redirect_uri=${encodeURIComponent(extensionRedirect)}`),
    env
  );
  assert.equal(startResponse.status, 302);

  const location = startResponse.headers.get('Location');
  assert.ok(location.startsWith('https://launchpad.37signals.com/authorization/new?'));

  const authUrl = new URL(location);
  const state = authUrl.searchParams.get('state');
  assert.ok(state);
  assert.equal(authUrl.searchParams.get('client_id'), 'client-id');
  assert.equal(authUrl.searchParams.get('redirect_uri'), 'https://timer.example.com/auth/callback');
  assert.equal(env.DB.oauthStates.has('expired-state'), false);
  assert.equal(env.DB.sessions.has('expired-session-hash'), false);

  const callbackResponse = await handleRequest(
    new Request(`https://timer.example.com/auth/callback?code=abc123&state=${state}`),
    env
  );
  assert.equal(callbackResponse.status, 302);

  const callbackLocation = new URL(callbackResponse.headers.get('Location'));
  assert.equal(callbackLocation.origin + callbackLocation.pathname, extensionRedirect);
  const sessionToken = callbackLocation.searchParams.get('session_token');
  assert.ok(sessionToken);

  const meResponse = await handleRequest(
    new Request('https://timer.example.com/api/me', {
      headers: { Authorization: `Bearer ${sessionToken}` }
    }),
    env
  );
  assert.equal(meResponse.status, 200);
  const me = await meResponse.json();
  assert.equal(me.email, 'ada@example.com');
  assert.equal(me.accounts[0].id, 999);

  const logResponse = await handleRequest(
    new Request('https://timer.example.com/api/log-time', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${sessionToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        accountId: '999',
        recordingId: '456',
        projectLevel: false,
        date: '2026-05-29',
        hours: '1.25',
        description: 'Write docs'
      })
    }),
    env
  );
  assert.equal(logResponse.status, 200);
  assert.equal((await logResponse.json()).entry.id, 111);

  const emptyDescriptionLogResponse = await handleRequest(
    new Request('https://timer.example.com/api/log-time', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${sessionToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        accountId: '999',
        recordingId: '1010',
        projectLevel: false,
        date: '2026-05-29',
        hours: '0.25',
        description: ''
      })
    }),
    env
  );
  assert.equal(emptyDescriptionLogResponse.status, 200);
  assert.equal((await emptyDescriptionLogResponse.json()).entry.id, 444);

  const projectLogResponse = await handleRequest(
    new Request('https://timer.example.com/api/log-time', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${sessionToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        accountId: '999',
        recordingId: '777',
        projectLevel: true,
        date: '2026-05-29',
        hours: '2.00',
        description: 'Project planning'
      })
    }),
    env
  );
  assert.equal(projectLogResponse.status, 200);
  assert.equal((await projectLogResponse.json()).entry.id, 222);

  env.DB.tokens.get(1).access_token_expires_at = '2000-01-01T00:00:00.000Z';

  const refreshLogResponse = await handleRequest(
    new Request('https://timer.example.com/api/log-time', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${sessionToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        accountId: '999',
        recordingId: '999',
        projectLevel: false,
        date: '2026-05-29',
        hours: '0.50',
        description: 'After token expiry'
      })
    }),
    env
  );
  assert.equal(refreshLogResponse.status, 200);
  assert.equal((await refreshLogResponse.json()).entry.id, 333);

  env.DB.tokens.get(1).access_token_expires_at = '2000-01-01T00:00:00.000Z';

  const secondRefreshLogResponse = await handleRequest(
    new Request('https://timer.example.com/api/log-time', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${sessionToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        accountId: '999',
        recordingId: '1000',
        projectLevel: false,
        date: '2026-05-29',
        hours: '0.75',
        description: 'After second token expiry'
      })
    }),
    env
  );
  assert.equal(secondRefreshLogResponse.status, 200);
  assert.equal((await secondRefreshLogResponse.json()).entry.id, 555);

  const deniedAccountResponse = await handleRequest(
    new Request('https://timer.example.com/api/log-time', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${sessionToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        accountId: '123456',
        recordingId: '456',
        projectLevel: false,
        date: '2026-05-29',
        hours: '1.00',
        description: 'Wrong account'
      })
    }),
    env
  );
  assert.equal(deniedAccountResponse.status, 403);

  const unauthorizedAdminResponse = await handleRequest(new Request('https://timer.example.com/admin/users'), env);
  assert.equal(unauthorizedAdminResponse.status, 401);

  const adminUsersResponse = await handleRequest(
    new Request('https://timer.example.com/admin/users', {
      headers: { Authorization: 'Bearer admin-token' }
    }),
    env
  );
  assert.equal(adminUsersResponse.status, 200);
  const adminUsers = await adminUsersResponse.json();
  assert.equal(adminUsers.users.length, 1);
  assert.equal(adminUsers.users[0].email, 'ada@example.com');
  assert.equal(adminUsers.users[0].activeSessions, 1);

  const revokeResponse = await handleRequest(
    new Request('https://timer.example.com/admin/revoke-user-sessions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer admin-token',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ email: 'ada@example.com' })
    }),
    env
  );
  assert.equal(revokeResponse.status, 200);

  const expiredSessionResponse = await handleRequest(
    new Request('https://timer.example.com/api/me', {
      headers: { Authorization: `Bearer ${sessionToken}` }
    }),
    env
  );
  assert.equal(expiredSessionResponse.status, 401);
  assert.equal(calls.length, 10);

  console.log('worker tests passed');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
