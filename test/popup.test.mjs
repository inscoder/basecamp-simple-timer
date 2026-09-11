import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync('extension/popup.html', 'utf8');

[
  'addBtn',
  'connectBtn',
  'disconnectBtn',
  'authStatus',
  'errorMsg',
  'successMsg',
  'taskList',
  'emptyState'
].forEach(id => {
  assert.match(html, new RegExp(`id=["']${id}["']`), `popup.html is missing #${id}`);
});

assert.match(html, /<link[^>]+href=["']popup\.css["']/);
assert.match(html, /<script[^>]+src=["']config\.js["']/);
assert.match(html, /<script[^>]+src=["']popup\.js["']/);

const popupJs = fs.readFileSync('extension/popup.js', 'utf8');
assert.match(popupJs, /app\.basecamp\.com/);
assert.match(popupJs, /3\.basecamp\.com/);

console.log('popup tests passed');
