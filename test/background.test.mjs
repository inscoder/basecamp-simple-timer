import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function createChromeMock({ backendUrl = 'https://timer.example.com', expectedPermission = 'https://timer.example.com/*' } = {}) {
  const storage = {};
  let messageListener = null;
  let installedListener = null;
  let activeTab = {
    id: 10,
    url: 'https://3.basecamp.com/999/buckets/222/todos/456',
    title: 'Write docs on Basecamp'
  };

  const chrome = {
    runtime: {
      lastError: null,
      onInstalled: {
        addListener(listener) {
          installedListener = listener;
        }
      },
      onMessage: {
        addListener(listener) {
          messageListener = listener;
        }
      }
    },
    storage: {
      local: {
        async get(key) {
          return { [key]: storage[key] };
        },
        async set(values) {
          Object.assign(storage, values);
        }
      }
    },
    tabs: {
      async query() {
        return [activeTab];
      },
      reload() {},
      update() {},
      create() {}
    },
    identity: {
      getRedirectURL(path) {
        return `https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/${path}`;
      },
      launchWebAuthFlow(details, callback) {
        assert.equal(details.interactive, true);
        assert.ok(details.url.startsWith(`${backendUrl}/auth/start?`));
        callback('https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/basecamp?session_token=session-123');
      }
    },
    permissions: {
      contains(details, callback) {
        assert.equal(details.origins[0], expectedPermission);
        callback(false);
      },
      request(details, callback) {
        assert.equal(details.origins[0], expectedPermission);
        callback(true);
      }
    },
    action: {
      setBadgeText() {},
      setBadgeBackgroundColor() {}
    }
  };

  return {
    chrome,
    storage,
    get messageListener() {
      return messageListener;
    },
    get installedListener() {
      return installedListener;
    },
    setActiveTab(tab) {
      activeTab = tab;
    }
  };
}

function sendMessage(listener, request) {
  return new Promise(resolve => {
    listener(request, {}, resolve);
  });
}

async function run() {
  await testBackendFlow({
    backendUrl: 'https://timer.example.com',
    expectedPermission: 'https://timer.example.com/*'
  });
  await testBackendFlow({
    backendUrl: 'http://localhost:8787',
    expectedPermission: 'http://localhost/*'
  });
  await testUnsupportedPageRejections();
  await testAppBasecampHostSupport();
  await testLegacyTimerRepair();
  await testTinyTimerRejection();

  console.log('background tests passed');
}

async function testBackendFlow({ backendUrl, expectedPermission }) {
  const mock = createChromeMock({ backendUrl, expectedPermission });
  const fetchCalls = [];

  const context = vm.createContext({
    chrome: mock.chrome,
    console,
    URL,
    Date,
    fetch: async (url, init = {}) => {
      fetchCalls.push({ url: String(url), init });

      if (String(url) === `${backendUrl}/api/me`) {
        assert.equal(init.headers.Authorization, 'Bearer session-123');
        return Response.json({
          id: 1,
          name: 'Ada Lovelace',
          email: 'ada@example.com',
          accounts: [{ id: 999, product: 'bc3' }]
        });
      }

      if (String(url) === `${backendUrl}/api/log-time`) {
        assert.equal(init.method, 'POST');
        assert.equal(init.headers.Authorization, 'Bearer session-123');
        assert.deepEqual(JSON.parse(init.body), {
          accountId: '999',
          recordingId: '456',
          projectLevel: false,
          date: localDate(),
          hours: '1.50',
          description: 'Reviewed QA notes'
        });
        return Response.json({ ok: true, entry: { id: 111 } });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    }
  });

  vm.runInContext(fs.readFileSync('extension/background.js', 'utf8'), context);
  assert.equal(typeof mock.installedListener, 'function');
  assert.equal(typeof mock.messageListener, 'function');

  mock.installedListener();
  await new Promise(resolve => setTimeout(resolve, 0));

  let response = await sendMessage(mock.messageListener, {
    action: 'SAVE_SETTINGS',
    settings: { backendUrl }
  });
  assert.equal(response.success, true);

  response = await sendMessage(mock.messageListener, { action: 'CONNECT_BACKEND' });
  assert.equal(response.success, true);
  assert.equal(response.user.email, 'ada@example.com');

  response = await sendMessage(mock.messageListener, { action: 'ADD_TASK' });
  assert.equal(response.success, true);

  const data = Object.values(mock.storage)[0];
  const task = data.tasks['999:todos:456'];
  assert.equal(task.accountId, '999');
  assert.equal(task.recordingId, '456');
  assert.equal(task.projectLevel, false);

  task.status = 'paused';
  task.lastStartTime = null;
  task.accumulatedTime = 90 * 60 * 1000;
  await mock.chrome.storage.local.set({ basecamp_timer_v1_1: data });

  response = await sendMessage(mock.messageListener, { action: 'LOG_TASK', taskId: '999:todos:456', note: 'Reviewed QA notes' });
  assert.equal(response.success, true);
  assert.equal(fetchCalls.length, 2);

  const loggedData = Object.values(mock.storage)[0];
  assert.equal(loggedData.tasks['999:todos:456'], undefined);
}

async function testLegacyTimerRepair() {
  const backendUrl = 'https://timer.example.com';
  const mock = createChromeMock({ backendUrl, expectedPermission: 'https://timer.example.com/*' });
  const fetchCalls = [];

  const context = vm.createContext({
    chrome: mock.chrome,
    console,
    URL,
    Date,
    fetch: async (url, init = {}) => {
      fetchCalls.push({ url: String(url), init });

      if (String(url) === `${backendUrl}/api/log-time`) {
        assert.equal(init.method, 'POST');
        assert.equal(init.headers.Authorization, 'Bearer session-123');
        assert.deepEqual(JSON.parse(init.body), {
          accountId: '999',
          recordingId: '456',
          projectLevel: false,
          date: localDate(),
          hours: '1.50',
          description: ''
        });
        return Response.json({ ok: true, entry: { id: 111 } });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    }
  });

  vm.runInContext(fs.readFileSync('extension/background.js', 'utf8'), context);
  assert.equal(typeof mock.messageListener, 'function');

  await mock.chrome.storage.local.set({
    basecamp_timer_v1_1: {
      activeTaskId: null,
      settings: {
        backendUrl,
        sessionToken: 'session-123',
        user: { email: 'ada@example.com' }
      },
      tasks: {
        456: {
          id: '456',
          title: 'Legacy timer',
          url: 'https://3.basecamp.com/999/buckets/222/todos/456',
          status: 'paused',
          accumulatedTime: 90 * 60 * 1000,
          lastStartTime: null
        }
      }
    }
  });

  const response = await sendMessage(mock.messageListener, { action: 'LOG_TASK', taskId: '456' });
  assert.equal(response.success, true);
  assert.equal(fetchCalls.length, 1);

  const loggedData = Object.values(mock.storage)[0];
  assert.equal(loggedData.tasks['456'], undefined);
}

async function testUnsupportedPageRejections() {
  const pages = [
    'https://3.basecamp.com/999/projects/222',
    'https://3.basecamp.com/123456/projects/789012',
    'https://3.basecamp.com/999/',
    'https://3.basecamp.com/123456/',
    'https://3.basecamp.com/999/buckets/222/todolists/456',
    'https://3.basecamp.com/999/buckets/222/todosets/456'
  ];

  for (const url of pages) {
    const mock = createChromeMock();
    mock.setActiveTab({
      id: 10,
      url,
      title: 'Unsupported page on Basecamp'
    });

    const context = vm.createContext({
      chrome: mock.chrome,
      console,
      URL,
      Date,
      fetch: async (fetchUrl) => {
        throw new Error(`Unexpected fetch: ${fetchUrl}`);
      }
    });

    vm.runInContext(fs.readFileSync('extension/background.js', 'utf8'), context);

    const response = await sendMessage(mock.messageListener, { action: 'ADD_TASK' });
    assert.equal(response.success, false);
    assert.match(response.error, /not supported on this page type/);
  }
}

async function testAppBasecampHostSupport() {
  const mock = createChromeMock();
  mock.setActiveTab({
    id: 10,
    url: 'https://app.basecamp.com/999/buckets/222/todos/456',
    title: 'App host task on Basecamp'
  });

  const context = vm.createContext({
    chrome: mock.chrome,
    console,
    URL,
    Date,
    fetch: async (fetchUrl) => {
      throw new Error(`Unexpected fetch: ${fetchUrl}`);
    }
  });

  vm.runInContext(fs.readFileSync('extension/background.js', 'utf8'), context);

  const response = await sendMessage(mock.messageListener, { action: 'ADD_TASK' });
  assert.equal(response.success, true);

  const data = Object.values(mock.storage)[0];
  const task = data.tasks['999:todos:456'];
  assert.equal(task.accountId, '999');
  assert.equal(task.recordingId, '456');
  assert.equal(task.url, 'https://app.basecamp.com/999/buckets/222/todos/456');
}

async function testTinyTimerRejection() {
  const backendUrl = 'https://timer.example.com';
  const mock = createChromeMock({ backendUrl, expectedPermission: 'https://timer.example.com/*' });
  const fetchCalls = [];

  const context = vm.createContext({
    chrome: mock.chrome,
    console,
    URL,
    Date,
    fetch: async (url, init = {}) => {
      fetchCalls.push({ url: String(url), init });
      throw new Error(`Unexpected fetch: ${url}`);
    }
  });

  vm.runInContext(fs.readFileSync('extension/background.js', 'utf8'), context);
  await mock.chrome.storage.local.set({
    basecamp_timer_v1_1: {
      activeTaskId: null,
      settings: {
        backendUrl,
        sessionToken: 'session-123',
        user: { email: 'ada@example.com' }
      },
      tasks: {
        tiny: {
          id: 'tiny',
          title: 'Tiny timer',
          url: 'https://3.basecamp.com/999/buckets/222/todos/456',
          accountId: '999',
          recordingId: '456',
          projectLevel: false,
          status: 'paused',
          accumulatedTime: 10 * 1000,
          lastStartTime: null
        }
      }
    }
  });

  const response = await sendMessage(mock.messageListener, { action: 'LOG_TASK', taskId: 'tiny' });
  assert.equal(response.success, false);
  assert.match(response.error, /not accumulated enough time/);
  assert.equal(fetchCalls.length, 0);
}

function localDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
