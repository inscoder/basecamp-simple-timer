const STORAGE_KEY = 'basecamp_timer_v1_1';
try {
  importScripts('config.js');
} catch (error) {
  // Tests run this file outside Chrome's service worker loader.
}

const DEFAULT_DATA = {
  activeTaskId: null,
  tasks: {},
  settings: {
    backendUrl: '',
    sessionToken: '',
    user: null
  }
};

// --- Initialization ---
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get([STORAGE_KEY], (result) => {
    if (!result[STORAGE_KEY]) {
      chrome.storage.local.set({ [STORAGE_KEY]: DEFAULT_DATA });
    }
  });
});

// --- Message Router ---
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  switch (request.action) {
    case 'GET_DATA':
      getData().then(sendResponse);
      break;
    case 'ADD_TASK':
      handleAddTask(sendResponse);
      break;
    case 'TOGGLE_TASK':
      handleToggleTask(request.taskId).then(sendResponse);
      break;
    case 'DELETE_TASK':
      handleDeleteTask(request.taskId).then(sendResponse);
      break;
    case 'SAVE_SETTINGS':
      handleSaveSettings(request.settings).then(sendResponse);
      break;
    case 'CONNECT_BACKEND':
      handleConnectBackend().then(sendResponse);
      break;
    case 'DISCONNECT_BACKEND':
      handleDisconnectBackend().then(sendResponse);
      break;
    case 'LOG_TASK':
      handleLogTask(request.taskId, request.note).then(sendResponse);
      break;
    case 'OPEN_LINK':
      handleOpenLink(request.url);
      break;
  }
  return true; // Required for async response
});

// --- Core Functions ---

async function getData() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return normalizeData(result[STORAGE_KEY]);
}

async function saveData(data) {
  await chrome.storage.local.set({ [STORAGE_KEY]: data });
  updateBadge(data.activeTaskId ? 'ON' : '');
}

function normalizeData(data) {
  const settings = {
    ...DEFAULT_DATA.settings,
    ...((data && data.settings) || {})
  };

  return {
    ...DEFAULT_DATA,
    ...(data || {}),
    tasks: (data && data.tasks) || {},
    settings: {
      ...settings,
      backendUrl: getConfiguredBackendUrl() || normalizeBackendUrl(settings.backendUrl)
    }
  };
}

function getConfiguredBackendUrl() {
  return normalizeBackendUrl(globalThis.BASECAMP_TIMER_CONFIG && globalThis.BASECAMP_TIMER_CONFIG.backendUrl);
}

function makeTaskKey(context) {
  return `${context.accountId}:${context.type}:${context.recordingId}`;
}

const ALLOWED_BASECAMP_HOSTS = ['3.basecamp.com', 'app.basecamp.com'];
const SUPPORTED_RECORDING_TYPES = ['messages', 'cards', 'todos', 'documents', 'schedule_entries'];

function isBasecampUrl(url) {
  try {
    return ALLOWED_BASECAMP_HOSTS.includes(new URL(url).hostname);
  } catch (error) {
    return false;
  }
}

// THE PARSER: Strict path segment matching for allowed recording types only
function getBasecampContext(url) {
    try {
        const urlObj = new URL(url);
        if (!ALLOWED_BASECAMP_HOSTS.includes(urlObj.hostname)) return null;

        const parts = urlObj.pathname.split('/').filter(Boolean);
        const accountId = parts[0];

        // Supported Patterns:
        // /123/buckets/456/messages/789
        // /123/buckets/456/card_tables/cards/789
        // /123/buckets/456/todos/789
        // /123/buckets/456/documents/789
        // /123/buckets/456/schedule_entries/789
        const recordingTypeIndex = parts.findIndex((part, index) => (
          SUPPORTED_RECORDING_TYPES.includes(part) && /^\d+$/.test(parts[index + 1] || '')
        ));
        const bucketIndex = parts.indexOf('buckets');

        if (/^\d+$/.test(accountId) && recordingTypeIndex !== -1) {
            const type = parts[recordingTypeIndex];
            const id = parts[recordingTypeIndex + 1];
            const context = {
              accountId,
              bucketId: bucketIndex !== -1 && /^\d+$/.test(parts[bucketIndex + 1] || '') ? parts[bucketIndex + 1] : null,
              type,
              recordingId: id,
              projectLevel: false
            };
            context.taskKey = makeTaskKey(context);
            return context;
        }
        return null;

    } catch (e) {
        console.error("Parsing error", e);
        return null;
    }
}

// LINK HANDLER
async function handleOpenLink(url) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (tab) {
        const current = tab.url.replace(/\/$/, '');
        const target = url.replace(/\/$/, '');

        // If strict match, reload to avoid history trap. Otherwise update.
        if (current === target) {
            chrome.tabs.reload(tab.id);
        } else {
            chrome.tabs.update(tab.id, { url: url });
        }
    } else {
        chrome.tabs.create({ url: url });
    }
}

async function handleAddTask(sendResponse) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab || !isBasecampUrl(tab.url)) {
    sendResponse({ success: false, error: "This is not a Basecamp page." });
    return;
  }

  const context = getBasecampContext(tab.url);

  if (!context) {
    // Specific error message for unsupported pages
    sendResponse({ success: false, error: "Time tracking is not supported on this page type.\n\nSupported: Todos, Cards, Docs, Messages, Schedules." });
    return;
  }

  const data = await getData();
  const now = Date.now();

  // 1. AUTO-PAUSE
  if (data.activeTaskId && data.activeTaskId !== context.taskKey) {
      const active = data.tasks[data.activeTaskId];
      if (active) {
          active.accumulatedTime += (now - active.lastStartTime);
          active.lastStartTime = null;
          active.status = 'paused';
      }
  }

  // 2. PREPARE TARGET
  if (data.tasks[context.taskKey]) {
      // Resume existing
      const task = data.tasks[context.taskKey];
      if (task.status !== 'running') {
          task.status = 'running';
          task.lastStartTime = now;
      }
      task.title = tab.title.replace(/ on Basecamp$/, '').trim();
      task.url = cleanBasecampUrl(tab.url);
      task.accountId = context.accountId;
      task.bucketId = context.bucketId;
      task.recordingId = context.recordingId;
      task.projectLevel = context.projectLevel;
  } else {
      // Create new
      const cleanTitle = tab.title.replace(/ on Basecamp$/, '').trim();

      data.tasks[context.taskKey] = {
        id: context.taskKey,
        accountId: context.accountId,
        bucketId: context.bucketId,
        recordingId: context.recordingId,
        projectLevel: context.projectLevel,
        title: cleanTitle,
        url: cleanBasecampUrl(tab.url),
        status: 'running',
        accumulatedTime: 0,
        lastStartTime: now
      };
  }

  // 3. SET ACTIVE
  data.activeTaskId = context.taskKey;

  await saveData(data);
  sendResponse({ success: true });
}

async function handleToggleTask(taskId) {
  const data = await getData();
  const now = Date.now();
  const targetTask = data.tasks[taskId];

  if (!targetTask) return { success: false };

  if (targetTask.status === 'running') {
    // PAUSE
    targetTask.accumulatedTime += (now - targetTask.lastStartTime);
    targetTask.lastStartTime = null;
    targetTask.status = 'paused';
    data.activeTaskId = null;
  } else {
    // START
    if (data.activeTaskId && data.activeTaskId !== taskId) {
        const active = data.tasks[data.activeTaskId];
        if (active) {
            active.accumulatedTime += (now - active.lastStartTime);
            active.lastStartTime = null;
            active.status = 'paused';
        }
    }

    targetTask.status = 'running';
    targetTask.lastStartTime = now;
    data.activeTaskId = taskId;
  }

  await saveData(data);
  return { success: true };
}

async function handleSaveSettings(settings) {
  const data = await getData();
  const rawBackendUrl = settings && settings.backendUrl ? settings.backendUrl.trim() : '';
  const backendUrl = normalizeBackendUrl(rawBackendUrl);
  const previousBackendUrl = data.settings.backendUrl;

  if (rawBackendUrl && !backendUrl) {
    return { success: false, error: 'Backend URL must be an HTTPS URL.' };
  }

  data.settings = {
    ...data.settings,
    backendUrl
  };

  if (!backendUrl || backendUrl !== previousBackendUrl) {
    data.settings.sessionToken = '';
    data.settings.user = null;
  }

  await saveData(data);
  return { success: true };
}

async function handleConnectBackend() {
  try {
    const data = await getData();
    const backendUrl = normalizeBackendUrl(data.settings.backendUrl);

    if (!backendUrl) {
      return { success: false, error: 'Add your Cloudflare backend URL first.' };
    }

    const hasPermission = await ensureBackendPermission(backendUrl);
    if (!hasPermission) {
      return { success: false, error: 'Chrome permission for this backend URL was not granted.' };
    }

    const extensionRedirectUri = chrome.identity.getRedirectURL('basecamp');
    const authUrl = `${backendUrl}/auth/start?extension_redirect_uri=${encodeURIComponent(extensionRedirectUri)}`;
    const responseUrl = await launchWebAuthFlow(authUrl);
    const response = new URL(responseUrl);
    const sessionToken = response.searchParams.get('session_token');

    if (!sessionToken) {
      return { success: false, error: 'Backend did not return a session token.' };
    }

    data.settings.backendUrl = backendUrl;
    data.settings.sessionToken = sessionToken;
    data.settings.user = await apiFetch(data, '/api/me');
    await saveData(data);

    return { success: true, user: data.settings.user };
  } catch (error) {
    return { success: false, error: error.message || 'Failed to connect to Basecamp.' };
  }
}

async function handleDisconnectBackend() {
  const data = await getData();

  try {
    if (data.settings.backendUrl && data.settings.sessionToken) {
      await apiFetch(data, '/api/logout', { method: 'POST' });
    }
  } catch (error) {
    console.warn('Backend logout failed', error);
  }

  data.settings.sessionToken = '';
  data.settings.user = null;
  await saveData(data);
  return { success: true };
}

function launchWebAuthFlow(url) {
  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url, interactive: true }, (responseUrl) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(responseUrl);
    });
  });
}

function ensureBackendPermission(backendUrl) {
  const originPattern = makeHostPermissionPattern(backendUrl);

  return new Promise((resolve) => {
    chrome.permissions.contains({ origins: [originPattern] }, (hasPermission) => {
      if (hasPermission) {
        resolve(true);
        return;
      }

      chrome.permissions.request({ origins: [originPattern] }, resolve);
    });
  });
}

function makeHostPermissionPattern(url) {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.hostname}/*`;
}

async function handleLogTask(taskId, note = '') {
  try {
    const data = await getData();
    const task = data.tasks[taskId];

    if (!task) return { success: false, error: 'Timer not found.' };
    if (!data.settings.backendUrl || !data.settings.sessionToken) {
      return { success: false, error: 'Connect to your Cloudflare backend before logging time.' };
    }
    const taskContext = ensureTaskContext(task);
    if (!taskContext) {
      return { success: false, error: 'This timer is missing Basecamp context. Open its Basecamp page and start the timer again.' };
    }
    if (taskContext.projectLevel) {
      return { success: false, error: 'Project-level timers cannot be logged reliably through the Basecamp API. Start the timer from a to-do, card, message, document, or schedule entry instead.' };
    }

    const now = Date.now();
    const totalMs = calculateTime(task, now);
    const hours = formatHoursForBasecamp(totalMs);
    const description = formatLogDescription(task, note);

    if (!hours) {
      return { success: false, error: 'Timer has not accumulated enough time to log.' };
    }

    const entry = await apiFetch(data, '/api/log-time', {
      method: 'POST',
      body: {
        accountId: taskContext.accountId,
        recordingId: taskContext.recordingId,
        projectLevel: taskContext.projectLevel,
        date: getLocalDate(),
        hours,
        description
      }
    });

    if (data.activeTaskId === taskId) {
      data.activeTaskId = null;
    }
    delete data.tasks[taskId];
    await saveData(data);

    return { success: true, entry };
  } catch (error) {
    return { success: false, error: error.message || 'Failed to log time to Basecamp.' };
  }
}

function formatLogDescription(task, note) {
  return String(note ?? '').slice(0, 1000);
}

async function handleDeleteTask(taskId) {
  const data = await getData();
  if (data.activeTaskId === taskId) {
    data.activeTaskId = null;
    updateBadge('');
  }
  delete data.tasks[taskId];
  await saveData(data);
  return { success: true };
}

function cleanBasecampUrl(url) {
  const urlObj = new URL(url);
  return urlObj.origin + urlObj.pathname;
}

function calculateTime(task, now = Date.now()) {
  let total = task.accumulatedTime || 0;
  if (task.status === 'running' && task.lastStartTime) {
    total += now - task.lastStartTime;
  }
  return total;
}

function formatHoursForBasecamp(ms) {
  const rounded = (ms / (1000 * 60 * 60)).toFixed(2);
  return Number(rounded) >= 0.01 ? rounded : null;
}

function ensureTaskContext(task) {
  if (task.accountId && task.recordingId) {
    return task;
  }

  const context = task.url ? getBasecampContext(task.url) : null;
  if (!context) return null;

  task.id = context.taskKey;
  task.accountId = context.accountId;
  task.bucketId = context.bucketId;
  task.recordingId = context.recordingId;
  task.projectLevel = context.projectLevel;

  return task;
}

function getLocalDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function normalizeBackendUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' && url.hostname !== 'localhost') return '';
    return url.origin;
  } catch (error) {
    return '';
  }
}

async function apiFetch(data, path, options = {}) {
  const backendUrl = normalizeBackendUrl(data.settings.backendUrl);
  const response = await fetch(`${backendUrl}${path}`, {
    method: options.method || 'GET',
    headers: {
      'Authorization': `Bearer ${data.settings.sessionToken}`,
      'Content-Type': 'application/json'
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  if (!response.ok) {
    throw new Error(await apiError(response));
  }

  if (response.status === 204) return null;
  return response.json();
}

async function apiError(response) {
  const fallback = `Backend request failed with ${response.status}.`;
  try {
    const payload = await response.clone().json();
    return payload.error || payload.message || fallback;
  } catch (e) {
    const text = await response.text();
    return text || fallback;
  }
}

function updateBadge(text) {
  chrome.action.setBadgeText({ text: text });
  chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });
}
