let currentData = { activeTaskId: null, tasks: {}, settings: { backendUrl: '', sessionToken: '', user: null } };
let currentTabId = null;
let pendingLogTaskId = null;
let pendingDeleteTaskId = null;
let selectedTaskId = null;
let isConnectionMenuOpen = false;

const ICONS = {
  save: '<path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"></path><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"></path><path d="M7 3v4a1 1 0 0 0 1 1h7"></path>',
  play: '<path d="M8 5v14l11-7Z"></path>',
  pause: '<path d="M14 4h4v16h-4Z"></path><path d="M6 4h4v16H6Z"></path>',
  trash: '<path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M19 6l-1 14H6L5 6"></path><path d="M10 11v5"></path><path d="M14 11v5"></path>',
  check: '<path d="M20 6 9 17l-5-5"></path>',
  x: '<path d="M18 6 6 18"></path><path d="m6 6 12 12"></path>'
};

function setIcon(button, iconName, label) {
  button.innerHTML = `<svg aria-hidden="true" viewBox="0 0 24 24">${ICONS[iconName]}</svg>`;
  button.setAttribute('aria-label', label);
}

document.addEventListener('DOMContentLoaded', () => {
  loadData();

  document.getElementById('addBtn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'ADD_TASK' }, async (res) => {
      if (res.success) {
        showError('');
        showSuccess('');
        await loadData();
      } else {
        showError(res.error || "Failed to start timer. Are you on a Basecamp page?");
      }
    });
  });

  document.getElementById('connectBtn').addEventListener('click', () => {
    const backendUrl = getConfiguredBackendUrl();
    if (!backendUrl) {
      showError('Backend URL is missing from extension/config.js.');
      return;
    }

    requestBackendPermission(backendUrl, (granted) => {
      if (!granted) {
        showError('Chrome permission for this backend URL was not granted.');
        return;
      }

      chrome.runtime.sendMessage({ action: 'SAVE_SETTINGS', settings: { backendUrl } }, (saveRes) => {
        if (!saveRes || !saveRes.success) {
          showError((saveRes && saveRes.error) || 'Failed to save backend URL.');
          return;
        }

        chrome.runtime.sendMessage({ action: 'CONNECT_BACKEND' }, (res) => {
          if (res && res.success) {
            showSuccess('Connected to Basecamp.');
            loadData();
          } else {
            showError((res && res.error) || 'Failed to connect to Basecamp.');
          }
        });
      });
    });
  });

  document.getElementById('connectionMenuBtn').addEventListener('click', () => {
    isConnectionMenuOpen = !isConnectionMenuOpen;
    updateConnectionMenu();
  });

  document.getElementById('disconnectBtn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'DISCONNECT_BACKEND' }, (res) => {
      if (res && res.success) {
        isConnectionMenuOpen = false;
        showSuccess('Disconnected.');
        loadData();
      } else {
        showError((res && res.error) || 'Failed to disconnect.');
      }
    });
  });

  document.addEventListener('keydown', handlePopupShortcut);

  setInterval(() => {
    if (currentData.activeTaskId) updateActiveTimerVisuals();
  }, 1000);
});

function getConfiguredBackendUrl() {
  return normalizeBackendUrl(globalThis.BASECAMP_TIMER_CONFIG && globalThis.BASECAMP_TIMER_CONFIG.backendUrl);
}

function normalizeBackendUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'https:') return '';
    url.pathname = url.pathname.replace(/\/+$/, '');
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch (error) {
    return '';
  }
}

function requestBackendPermission(backendUrl, callback) {
  const url = new URL(backendUrl);
  chrome.permissions.request({ origins: [`${url.protocol}//${url.hostname}/*`] }, (granted) => {
    callback(Boolean(granted));
  });
}

const ALLOWED_BASECAMP_HOSTS = ['3.basecamp.com', 'app.basecamp.com'];
const SUPPORTED_RECORDING_TYPES = ['messages', 'cards', 'todos', 'documents', 'schedule_entries'];

function isBasecampUrl(url) {
    try {
        return ALLOWED_BASECAMP_HOSTS.includes(new URL(url).hostname);
    } catch (e) {
        return false;
    }
}

function getContextFromUrl(url) {
    try {
        const urlObj = new URL(url);
        if (!ALLOWED_BASECAMP_HOSTS.includes(urlObj.hostname)) return null;

        const parts = urlObj.pathname.split('/').filter(Boolean);
        const accountId = parts[0];
        const recordingTypeIndex = parts.findIndex((part, index) => (
          SUPPORTED_RECORDING_TYPES.includes(part) && /^\d+$/.test(parts[index + 1] || '')
        ));
        if (!/^\d+$/.test(accountId) || recordingTypeIndex === -1) return null;
        const type = parts[recordingTypeIndex];
        const id = parts[recordingTypeIndex + 1];
        return `${accountId}:${type}:${id}`;
    } catch (e) {
        return null;
    }
}

async function loadData() {
  const dataPromise = new Promise(resolve => chrome.runtime.sendMessage({ action: 'GET_DATA' }, resolve));
  const tabPromise = chrome.tabs.query({ active: true, currentWindow: true });

  const [data, tabs] = await Promise.all([dataPromise, tabPromise]);

  currentData = data;
  updateAuthStatus();

  if (tabs && tabs[0] && isBasecampUrl(tabs[0].url)) {
      currentTabId = getContextFromUrl(tabs[0].url);
  } else {
      currentTabId = null;
  }

  updateStartButton(tabs && tabs[0] ? tabs[0].url : '');
  render();
}

function updateStartButton(activeUrl) {
  const addBtn = document.getElementById('addBtn');
  const isBasecamp = Boolean(activeUrl && isBasecampUrl(activeUrl));
  const canStartTimer = Boolean(currentTabId);

  addBtn.disabled = !canStartTimer;
  if (canStartTimer) {
    addBtn.title = 'Start a timer for this Basecamp item';
  } else if (isBasecamp) {
    addBtn.title = 'Open a to-do, card, message, document, or schedule entry to start a timer';
  } else {
    addBtn.title = 'Open a Basecamp item to start a timer';
  }
}

function updateAuthStatus() {
  const authStatus = document.getElementById('authStatus');
  const disconnectBtn = document.getElementById('disconnectBtn');
  const connectBtn = document.getElementById('connectBtn');
  const settings = document.querySelector('.settings');
  const user = currentData.settings && currentData.settings.user;
  const isConnected = Boolean(user);

  settings.classList.toggle('connected', isConnected);
  document.body.classList.toggle('connected', isConnected);
  if (!isConnected) isConnectionMenuOpen = false;

  if (user) {
    authStatus.textContent = `Connected as ${user.name || user.email}`;
    connectBtn.textContent = 'Reconnect';
    disconnectBtn.disabled = false;
  } else {
    authStatus.textContent = 'Not connected';
    connectBtn.textContent = 'Connect';
    disconnectBtn.disabled = true;
  }

  updateConnectionMenu();
}

function updateConnectionMenu() {
  const settings = document.querySelector('.settings');
  const menu = document.getElementById('connectionMenu');
  const menuBtn = document.getElementById('connectionMenuBtn');
  const isConnected = settings.classList.contains('connected');
  const isOpen = isConnected && isConnectionMenuOpen;

  settings.classList.toggle('menu-open', isOpen);
  menu.classList.toggle('hidden', !isOpen);
  menuBtn.setAttribute('aria-expanded', String(isOpen));
  menuBtn.setAttribute('aria-label', isOpen ? 'Hide connection actions' : 'Show connection actions');
}

function render() {
  const ul = document.getElementById('taskList');
  const emptyState = document.getElementById('emptyState');

  // 1. FLIP: Record Old Positions
  const prevPositions = {};
  ul.querySelectorAll('.task-row').forEach(row => {
    prevPositions[row.dataset.id] = row.getBoundingClientRect().top;
  });

  ul.innerHTML = '';

  // Sort Logic: Active first, then by previous start time (stable sortish)
  const ids = Object.keys(currentData.tasks).sort((a, b) => {
    if (a === currentData.activeTaskId) return -1;
    if (b === currentData.activeTaskId) return 1;
    return 0;
  });

  if (ids.length === 0) {
    emptyState.classList.remove('hidden');
    return;
  } else {
    emptyState.classList.add('hidden');
  }

  if (!ids.includes(selectedTaskId)) {
    selectedTaskId = getDefaultSelectedTaskId(ids);
  }

  ids.forEach(id => {
    const task = currentData.tasks[id];
    const isRunning = task.status === 'running';
    const isCurrentPage = (id === currentTabId);
    const totalMs = calculateTime(task);
    const decimalHours = formatDecimal(totalMs);
    const canLog = Number(decimalHours) >= 0.01;
    const isLogPending = pendingLogTaskId === id;
    const isDeletePending = pendingDeleteTaskId === id;
    const isKeyboardSelected = selectedTaskId === id;

    const li = document.createElement('li');
    li.className = `task-row ${isRunning ? 'running' : ''} ${isCurrentPage ? 'current-page-row' : ''} ${isLogPending ? 'log-pending' : ''} ${isDeletePending ? 'delete-pending' : ''} ${isKeyboardSelected ? 'keyboard-selected' : ''}`;
    li.dataset.id = id;
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    li.setAttribute('aria-label', `${task.title}, ${formatTime(totalMs)}, ${decimalHours} hours`);

    const taskInfo = document.createElement('div');
    taskInfo.className = 'task-info';

    const title = document.createElement('div');
    title.className = 'task-title';
    title.dataset.action = 'link';
    title.title = `Open in Basecamp: ${task.title}`;
    title.textContent = task.title;

    const timerContainer = document.createElement('div');
    timerContainer.className = 'timer-container';

    const timer = document.createElement('span');
    timer.className = 'timer';
    timer.textContent = formatTime(totalMs);

    const decimal = document.createElement('span');
    decimal.className = 'decimal';
    decimal.dataset.action = 'copy';
    decimal.title = 'Click to copy decimal hours';
    decimal.textContent = `(${decimalHours})`;

    timerContainer.append(timer, decimal);
    taskInfo.append(title, timerContainer);

    const btnGroup = document.createElement('div');
    btnGroup.className = 'btn-group';

    const logBtn = document.createElement('button');
    logBtn.className = 'log-btn';
    logBtn.dataset.action = 'log';
    logBtn.title = canLog ? 'Log this time to Basecamp Timesheet' : 'Timer must reach 0.01 hours before logging';
    setIcon(logBtn, 'save', 'Log time');
    logBtn.disabled = !canLog;
    logBtn.tabIndex = -1;

    const toggleBtn = document.createElement('button');
    toggleBtn.className = `icon-btn ${isRunning ? 'btn-pause' : 'btn-play'}`;
    toggleBtn.dataset.action = 'toggle';
    toggleBtn.title = isRunning ? 'Pause' : 'Start';
    setIcon(toggleBtn, isRunning ? 'pause' : 'play', isRunning ? 'Pause timer' : 'Start timer');
    toggleBtn.tabIndex = -1;

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'icon-btn btn-del';
    deleteBtn.dataset.action = 'delete';
    deleteBtn.title = 'Delete Timer';
    setIcon(deleteBtn, 'trash', 'Delete timer');
    deleteBtn.tabIndex = -1;

    btnGroup.append(logBtn, toggleBtn, deleteBtn);
    li.append(taskInfo, btnGroup);

    if (isLogPending) {
      suppressRowTabbing(li);
      li.appendChild(createLogPrompt(id));
    } else if (isDeletePending) {
      suppressRowTabbing(li);
      li.appendChild(createDeletePrompt(id));
    }

    // Event Delegation
    li.querySelector('[data-action="toggle"]').onclick = () => {
      chrome.runtime.sendMessage({ action: 'TOGGLE_TASK', taskId: id }, async (res) => {
        if (res && res.success) {
          await loadData();
        } else {
          showError((res && res.error) || 'Failed to update timer.');
        }
      });
    };
    li.onfocus = () => {
      selectedTaskId = id;
      updateKeyboardSelection();
    };
    li.querySelector('[data-action="link"]').onclick = () => {
      startAndOpenTask(id);
    };
    li.querySelector('[data-action="delete"]').onclick = () => {
      showDeletePrompt(id);
    };
    li.querySelector('[data-action="log"]').onclick = () => {
      const decimal = formatDecimal(calculateTime(task));
      if (Number(decimal) < 0.01) {
        showError('Timer must reach 0.01 hours before logging.');
        return;
      }
      showLogPrompt(id);
    };
    const decimalEl = li.querySelector('[data-action="copy"]');
    decimalEl.onclick = () => {
        const decimal = formatDecimal(calculateTime(task));
        navigator.clipboard.writeText(decimal).then(() => {
            decimalEl.classList.add('copied');
            decimalEl.textContent = '(Copied!)';
            decimalEl.dataset.locked = "true";
            setTimeout(() => {
                decimalEl.classList.remove('copied');
                decimalEl.dataset.locked = "false";
                decimalEl.textContent = `(${formatDecimal(calculateTime(task))})`;
            }, 1200);
        });
    };

    ul.appendChild(li);
  });

  // 2. FLIP: Calculate Delta and Animate
  // We perform this AFTER the new list is inserted into the DOM
  requestAnimationFrame(() => {
      ul.querySelectorAll('.task-row').forEach(row => {
        const id = row.dataset.id;
        if (prevPositions[id] !== undefined) {
          const newTop = row.getBoundingClientRect().top;
          const oldTop = prevPositions[id];
          const deltaY = oldTop - newTop;

          // If the item actually moved
          if (deltaY !== 0) {
            // INVERT: Move it back to where it was instantly
            row.style.transform = `translateY(${deltaY}px)`;
            row.style.transition = 'none';

            // Force Reflow so the browser registers the position
            void row.offsetHeight;

            // PLAY: Remove the transform and let it slide to 0
            requestAnimationFrame(() => {
                row.style.transition = 'transform 0.3s cubic-bezier(0.2, 0, 0, 1)'; // Smooth easing
                row.style.transform = '';
            });
          }
        }
      });
  });
}

function createLogPrompt(taskId) {
  const panel = document.createElement('div');
  panel.className = 'log-prompt';

  const noteInput = document.createElement('input');
  noteInput.className = 'log-note';
  noteInput.dataset.action = 'log-note';
  noteInput.type = 'text';
  noteInput.placeholder = 'Add a note (optional)';
  noteInput.maxLength = 1000;

  const actions = document.createElement('div');
  actions.className = 'log-prompt-actions';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'log-cancel-btn';
  cancelBtn.dataset.action = 'cancel-log';
  cancelBtn.type = 'button';
  cancelBtn.title = 'Cancel';
  setIcon(cancelBtn, 'x', 'Cancel log');

  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'log-confirm-btn';
  confirmBtn.dataset.action = 'confirm-log';
  confirmBtn.type = 'button';
  confirmBtn.title = 'Confirm';
  setIcon(confirmBtn, 'check', 'Confirm log');

  actions.append(confirmBtn, cancelBtn);
  panel.append(noteInput, actions);

  cancelBtn.onclick = () => {
    if (pendingLogTaskId === taskId) {
      pendingLogTaskId = null;
      render();
    }
  };

  confirmBtn.onclick = () => {
    submitLogPrompt(taskId, noteInput.value);
  };

  panel.onkeydown = (event) => {
    trapPromptTab(panel, event);

    if (event.key === 'Escape') {
      cancelBtn.click();
      return;
    }

    if (event.key === 'Enter' && event.target === noteInput) {
      event.preventDefault();
      confirmBtn.click();
    }
  };

  return panel;
}

function createDeletePrompt(taskId) {
  const panel = document.createElement('div');
  panel.className = 'delete-prompt';

  const label = document.createElement('div');
  label.className = 'delete-prompt-label';
  label.textContent = 'Delete timer?';

  const actions = document.createElement('div');
  actions.className = 'delete-prompt-actions';

  const noBtn = document.createElement('button');
  noBtn.className = 'delete-no-btn';
  noBtn.dataset.action = 'cancel-delete';
  noBtn.type = 'button';
  noBtn.textContent = 'No';

  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'delete-confirm-btn';
  confirmBtn.dataset.action = 'confirm-delete';
  confirmBtn.type = 'button';
  confirmBtn.textContent = 'Confirm delete';

  actions.append(confirmBtn, noBtn);
  panel.append(label, actions);

  noBtn.onclick = () => {
    if (pendingDeleteTaskId === taskId) {
      pendingDeleteTaskId = null;
      render();
    }
  };

  confirmBtn.onclick = () => {
    submitDeletePrompt(taskId);
  };

  panel.onkeydown = (event) => {
    trapPromptTab(panel, event);

    if (event.key === 'Escape') {
      noBtn.click();
    }
  };

  return panel;
}

function suppressRowTabbing(row) {
  row.querySelectorAll('[data-action]').forEach(element => {
    element.tabIndex = -1;
  });
}

function trapPromptTab(container, event) {
  if (event.key !== 'Tab') return;

  const focusable = Array.from(container.querySelectorAll('button:not(:disabled), input:not(:disabled)'));
  if (focusable.length === 0) return;

  const first = focusable[0];
  const last = focusable[focusable.length - 1];

  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function handlePopupShortcut(event) {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
  if (isEditableElement(event.target)) return;
  const key = event.key;
  const shortcutKey = key.toLowerCase();

  if (shortcutKey === 'q') {
    event.preventDefault();
    window.close();
    return;
  }

  if (pendingLogTaskId || pendingDeleteTaskId) return;

  if (key === 'Tab') {
    event.preventDefault();
    moveTaskFocus(event.shiftKey ? -1 : 1);
    return;
  }

  if (key === 'ArrowUp' || key === 'ArrowDown') {
    event.preventDefault();
    moveTaskFocus(key === 'ArrowDown' ? 1 : -1);
    return;
  }

  if (key === 'Enter') {
    if (isButtonElement(event.target)) return;
    event.preventDefault();
    openSelectedTask();
    return;
  }

  if (!['a', 's', 'd', ' '].includes(shortcutKey)) return;

  event.preventDefault();

  if (shortcutKey === 'a') {
    document.getElementById('addBtn').click();
    return;
  }

  const row = getShortcutTaskRow();
  if (!row) return;

  if (shortcutKey === 's') {
    const logBtn = row.querySelector('[data-action="log"]');
    if (logBtn && logBtn.disabled) {
      showError('Timer must reach 0.01 hours before logging.');
      return;
    }
    if (logBtn) logBtn.click();
    return;
  }

  const action = shortcutKey === ' ' ? 'toggle' : 'delete';
  const button = row.querySelector(`[data-action="${action}"]`);
  if (button) button.click();
}

function isEditableElement(element) {
  if (!element) return false;
  const tagName = element.tagName;
  return element.isContentEditable || tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT';
}

function isButtonElement(element) {
  return Boolean(element && element.closest && element.closest('button'));
}

function getShortcutTaskRow() {
  return findTaskRow(selectedTaskId) ||
    document.querySelector('.task-row.current-page-row') ||
    findTaskRow(currentData.activeTaskId) ||
    document.querySelector('.task-row');
}

function getDefaultSelectedTaskId(ids) {
  if (ids.includes(currentTabId)) return currentTabId;
  if (ids.includes(currentData.activeTaskId)) return currentData.activeTaskId;
  return ids[0] || null;
}

function getVisibleTaskIds() {
  return Array.from(document.querySelectorAll('.task-row')).map(row => row.dataset.id);
}

function moveTaskSelection(direction) {
  const ids = getVisibleTaskIds();
  if (ids.length === 0) return;

  const currentIndex = ids.indexOf(selectedTaskId);
  const nextIndex = currentIndex === -1
    ? (direction > 0 ? 0 : ids.length - 1)
    : (currentIndex + direction + ids.length) % ids.length;

  selectedTaskId = ids[nextIndex];
  updateKeyboardSelection();
}

function moveTaskFocus(direction) {
  moveTaskSelection(direction);
  const selectedRow = findTaskRow(selectedTaskId);
  if (selectedRow) selectedRow.focus();
}

function updateKeyboardSelection() {
  document.querySelectorAll('.task-row').forEach(row => {
    row.classList.toggle('keyboard-selected', row.dataset.id === selectedTaskId);
  });

  const selectedRow = findTaskRow(selectedTaskId);
  if (selectedRow) selectedRow.scrollIntoView({ block: 'nearest' });
}

function openSelectedTask() {
  const row = findTaskRow(selectedTaskId) || getShortcutTaskRow();
  if (!row) return;

  startAndOpenTask(row.dataset.id);
}

function startAndOpenTask(taskId) {
  const task = currentData.tasks[taskId];
  if (!task) return;

  const openTask = async (shouldReload = false) => {
    if (shouldReload) await loadData();
    chrome.runtime.sendMessage({ action: 'OPEN_LINK', url: task.url });
    closePopupSoon();
  };

  if (task.status === 'running') {
    openTask();
    return;
  }

  chrome.runtime.sendMessage({ action: 'TOGGLE_TASK', taskId }, (res) => {
    if (res && res.success) {
      openTask(true);
    } else {
      showError((res && res.error) || 'Failed to start timer.');
    }
  });
}

function closePopupSoon() {
  setTimeout(() => {
    window.close();
  }, 500);
}

function showLogPrompt(taskId) {
  pendingLogTaskId = taskId;
  pendingDeleteTaskId = null;
  showError('');
  showSuccess('');
  render();

  requestAnimationFrame(() => {
    const row = findTaskRow(taskId);
    if (row) row.querySelector('[data-action="log-note"]').focus();
  });
}

function showDeletePrompt(taskId) {
  pendingDeleteTaskId = taskId;
  pendingLogTaskId = null;
  showError('');
  showSuccess('');
  render();

  requestAnimationFrame(() => {
    const row = findTaskRow(taskId);
    if (row) row.querySelector('[data-action="cancel-delete"]').focus();
  });
}

function submitLogPrompt(taskId, note) {
  const task = currentData.tasks[taskId];
  if (!task) {
    pendingLogTaskId = null;
    render();
    return;
  }

  const decimal = formatDecimal(calculateTime(task));
  const logNote = String(note || '');
  const row = findTaskRow(taskId);
  const confirmBtn = row && row.querySelector('[data-action="confirm-log"]');
  const cancelBtn = row && row.querySelector('[data-action="cancel-log"]');

  if (confirmBtn) confirmBtn.disabled = true;
  if (cancelBtn) cancelBtn.disabled = true;

  chrome.runtime.sendMessage({ action: 'LOG_TASK', taskId, note: logNote }, (res) => {
    if (res && res.success) {
      pendingLogTaskId = null;
      showSuccess(`Logged ${decimal} hours to Basecamp.`);
      loadData();
    } else {
      if (confirmBtn) confirmBtn.disabled = false;
      if (cancelBtn) cancelBtn.disabled = false;
      showError((res && res.error) || 'Failed to log time to Basecamp.');
    }
  });
}

function submitDeletePrompt(taskId) {
  const row = findTaskRow(taskId);
  const confirmBtn = row && row.querySelector('[data-action="confirm-delete"]');
  const noBtn = row && row.querySelector('[data-action="cancel-delete"]');

  if (confirmBtn) confirmBtn.disabled = true;
  if (noBtn) noBtn.disabled = true;

  chrome.runtime.sendMessage({ action: 'DELETE_TASK', taskId }, () => {
    if (pendingDeleteTaskId === taskId) pendingDeleteTaskId = null;
    loadData();
  });
}

function updateActiveTimerVisuals() {
  const activeId = currentData.activeTaskId;
  if (!activeId) return;

  const row = findTaskRow(activeId);
  if (row) {
    const task = currentData.tasks[activeId];
    if(task) {
        const totalMs = calculateTime(task);
        const decimalHours = formatDecimal(totalMs);
        row.querySelector('.timer').textContent = formatTime(totalMs);

        const decimalEl = row.querySelector('.decimal');
        if (decimalEl && decimalEl.dataset.locked !== "true") {
            decimalEl.textContent = `(${decimalHours})`;
        }

        const logBtn = row.querySelector('[data-action="log"]');
        if (logBtn) {
            const canLog = Number(decimalHours) >= 0.01;
            logBtn.disabled = !canLog;
            logBtn.title = canLog ? 'Log this time to Basecamp Timesheet' : 'Timer must reach 0.01 hours before logging';
        }
    }
  }
}

function findTaskRow(taskId) {
  return Array.from(document.querySelectorAll('.task-row')).find(row => row.dataset.id === taskId);
}

function calculateTime(task) {
  let t = task.accumulatedTime;
  if (task.status === 'running' && task.lastStartTime) {
    t += (Date.now() - task.lastStartTime);
  }
  return t;
}

function formatTime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${h.toString().padStart(2,'0')}:${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`;
}

function formatDecimal(ms) {
    const hours = ms / (1000 * 60 * 60);
    return hours.toFixed(2);
}

function showError(msg) {
  const el = document.getElementById('errorMsg');
  el.textContent = msg;
  el.classList.toggle('hidden', !msg);
  if (msg) showSuccess('');
}

function showSuccess(msg) {
  const el = document.getElementById('successMsg');
  el.textContent = msg;
  el.classList.toggle('hidden', !msg);
  if (msg) showError('');
}
