'use strict';
/* UI shell regression for Diagnostic Session Notebook redesign.
 * Proves the new workbench shell without changing behavior:
 * data-ui-revision, honest prototype notice, family tokens, focus/
 * reduced-motion/print, containment, and preserved session/report wiring.
 * Run: node tests/ui-shell.test.cjs (RED before revamp, GREEN after).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const read = (n) => fs.readFileSync(path.join(ROOT, n), 'utf8');

test('workbench shell revision marker exists', () => {
  const html = read('index.html');
  assert.ok(html.includes('data-ui-revision="portfolio-preview-1"'), 'main must carry data-ui-revision="portfolio-preview-1"');
});

test('honest prototype notice is present with exact wording', () => {
  const html = read('index.html');
  assert.ok(html.includes('id="prototype-notice"'), '#prototype-notice must exist');
  assert.ok(html.includes('Experimental concept prototype \u2014 idea exploration only.'), 'exact prototype phrase required');
  assert.match(html, /not (a )?finished/i, 'must state not finished');
  assert.match(html, /production-ready/i, 'must state not production-ready');
});

test('family tokens honor system colors without new persistence', () => {
  const css = read('style.css');
  for (const tok of ['--ui-bg', '--ui-surface', '--ui-ink', '--ui-muted', '--ui-accent', '--ui-border', '--ui-radius']) {
    assert.ok(css.includes(tok), 'style.css must define ' + tok);
  }
  assert.match(css, /color-scheme:\s*light\s+dark/, 'must honor automatic system colors via color-scheme: light dark');
  assert.match(css, /prefers-color-scheme:\s*light/, 'must adapt to light scheme without persistence');
  assert.ok(!/localStorage|sessionStorage/.test(css), 'CSS must not persist anything');
});

test('keyboard focus, reduced motion, and print stay provable', () => {
  const css = read('style.css');
  assert.match(css, /:focus-visible/, 'visible keyboard focus required');
  assert.match(css, /prefers-reduced-motion/, 'reduced-motion handling required');
  assert.match(css, /@media\s+print/, 'print styles required');
  assert.match(css, /body\.print-report/, 'app print handler class required');
  assert.match(css, /#report-panel/, 'report panel print isolation required');
  assert.match(css, /\.lower-grid\s*>\s*:not\(#report-panel\)/, 'nested report isolation must handle .lower-grid wrapper so the genuine print view is report-only');
});

test('narrow viewports contain via inner scrolling, not hidden overflow', () => {
  const css = read('style.css');
  assert.ok(!/overflow-x\s*:\s*hidden/.test(css), 'must not camouflage with overflow-x:hidden');
  assert.match(css, /min-width:\s*0/, 'grid children must allow min-width:0 containment');
  assert.match(css, /overflow:\s*auto/, 'inner panels must scroll internally');
});

test('offline safety unchanged: no new runtime/network/font deps', () => {
  const html = read('index.html');
  const css = read('style.css');
  for (const t of ['http://', 'https://']) {
    assert.ok(!html.includes(t), 'index.html must not contain ' + t);
    assert.ok(!css.includes(t), 'style.css must not contain ' + t);
  }
  assert.ok(!css.includes('@import'), 'no CSS imports');
  assert.ok(!/url\(/.test(css), 'no url() resources');
  assert.ok(!/<script(?![^>]*\bsrc=)/i.test(html), 'no inline scripts');
});

test('session/report/privacy wiring preserved with readable workbench', () => {
  const html = read('index.html');
  for (const id of ['session-form', 'session-date', 'session-title', 'session-vehicle', 'session-tags', 'session-notes',
    'import-text', 'import-file', 'preview-button', 'clear-import', 'preview-panel', 'save-session',
    'session-list', 'session-count', 'search-input', 'tag-filter', 'empty-state',
    'before-select', 'after-select', 'compare-button', 'diff-new-list', 'diff-absent-list', 'diff-persisting-list',
    'report-preview', 'download-report', 'download-compare-json', 'print-report',
    'export-backup', 'import-backup-file', 'load-sample', 'reset-data', 'storage-status']) {
    assert.ok(html.includes('data-testid="' + id + '"'), 'missing data-testid="' + id + '"');
  }
  assert.match(html, /No sessions yet/i, 'empty state must guide first session/sample');
  assert.match(html, /redact/i, 'privacy/redaction guidance must remain visible');
  assert.match(html, /Export backup|Local data/i, 'export choices must remain explicit');
  assert.match(html, /Before \/ after|comparison/i, 'comparison workspace must remain explicit');
});
