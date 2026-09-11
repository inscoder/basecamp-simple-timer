import assert from 'node:assert/strict';
import fs from 'node:fs';

const manifest = JSON.parse(fs.readFileSync('extension/manifest.json', 'utf8'));

assert.equal(manifest.manifest_version, 3);
assert.ok(manifest.permissions.includes('storage'));
assert.ok(manifest.permissions.includes('activeTab'));
assert.ok(manifest.permissions.includes('identity'));
assert.equal(manifest.permissions.includes('permissions'), false);
assert.ok(manifest.host_permissions.includes('https://*.workers.dev/*'));
assert.ok(manifest.host_permissions.includes('https://*.pages.dev/*'));
assert.ok(manifest.optional_host_permissions.includes('https://*/*'));
assert.ok(manifest.optional_host_permissions.includes('http://localhost/*'));
assert.equal(
  manifest.host_permissions.some(pattern => pattern.includes('3.basecampapi.com')),
  false
);

console.log('manifest tests passed');
