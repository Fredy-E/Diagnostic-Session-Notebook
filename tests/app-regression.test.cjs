'use strict';
/*
 * App-level regression tests for the Diagnostic Session Notebook UI wiring
 * (app.js). No runtime dependencies: the real app.js runs inside a minimal
 * DOM sandbox built from node:vm plus a tiny element stub.
 *
 * Regression under test ("stale report"): after a comparison is shown, any
 * applied store mutation - editing a compared session, replacing all sessions
 * (sample reload), adding an unrelated session, deleting one, or a write that
 * fails but is kept in memory - must invalidate the cached comparison and its
 * prebuilt report. A stale report must never stay downloadable or printable.
 * See qa check: "Editing compared evidence must invalidate or refresh the
 * report; no stale exports".
 *
 * Run: node tests/app-regression.test.cjs   (or: node --test)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const CORE_SRC = fs.readFileSync(path.join(ROOT, 'core.js'), 'utf8');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const REPORT_PLACEHOLDER = 'Run a comparison to build the report.';
const N = require('../core.js');

/* Minimal DOM: enough element surface for app.js (textContent, hidden,
 * disabled, value, attributes, children, listeners, focus). */
function boot(options) {
  options = options || {};
  const storageMap = new Map();
  const flags = { failWrites: !!options.failWrites, blobCalls: 0, timerSeq: 1 };

  const documentStub = {
    activeElement: null,
    listeners: {},
    body: null,
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    removeEventListener() {}
  };
  const selectorNodes = new Map();

  function makeNode(tag) {
    return {
      nodeType: 1,
      tagName: String(tag).toUpperCase(),
      children: [],
      parentNode: null,
      attributes: {},
      listeners: {},
      textContent: '',
      value: '',
      hidden: false,
      disabled: false,
      className: '',
      classList: { add() {}, remove() {} },
      get firstChild() { return this.children.length ? this.children[0] : null; },
      appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
      removeChild(child) {
        const index = this.children.indexOf(child);
        if (index >= 0) this.children.splice(index, 1);
        child.parentNode = null;
        return child;
      },
      remove() { if (this.parentNode) this.parentNode.removeChild(this); },
      setAttribute(name, value) { this.attributes[String(name)] = String(value); },
      getAttribute(name) {
        return Object.prototype.hasOwnProperty.call(this.attributes, String(name)) ? this.attributes[String(name)] : null;
      },
      addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
      removeEventListener(type, fn) {
        const list = this.listeners[type] || [];
        const index = list.indexOf(fn);
        if (index >= 0) list.splice(index, 1);
      },
      dispatch(type, event) {
        (this.listeners[type] || []).slice().forEach((fn) => fn(event || { preventDefault() {}, target: this }));
      },
      click() { this.dispatch('click'); },
      focus() { documentStub.activeElement = this; }
    };
  }

  documentStub.createElement = (tag) => makeNode(tag);
  documentStub.createTextNode = (text) => ({ nodeType: 3, textContent: String(text), parentNode: null });
  documentStub.querySelector = (selector) => {
    if (!selectorNodes.has(selector)) selectorNodes.set(selector, makeNode('div'));
    return selectorNodes.get(selector);
  };
  documentStub.body = makeNode('body');

  const localStorageStub = {
    getItem(key) { return storageMap.has(String(key)) ? storageMap.get(String(key)) : null; },
    setItem(key, value) {
      if (flags.failWrites) {
        const error = new Error('QuotaExceededError: storage full');
        error.name = 'QuotaExceededError';
        throw error;
      }
      storageMap.set(String(key), String(value));
    },
    removeItem(key) { storageMap.delete(String(key)); }
  };

  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.document = documentStub;
  sandbox.localStorage = localStorageStub;
  sandbox.setTimeout = () => flags.timerSeq++;
  sandbox.clearTimeout = () => {};
  sandbox.addEventListener = () => {};
  sandbox.removeEventListener = () => {};
  sandbox.print = () => {};
  sandbox.Blob = function Blob() { flags.blobCalls += 1; };
  sandbox.URL = { createObjectURL: () => 'blob:stub', revokeObjectURL() {} };

  const context = vm.createContext(sandbox);
  vm.runInContext(CORE_SRC, context, { filename: 'core.js' });
  if (options.seedText != null) storageMap.set(sandbox.Notebook.STORAGE_KEY, String(options.seedText));
  vm.runInContext(APP_SRC, context, { filename: 'app.js' });

  const byTestId = (id) => documentStub.querySelector('[data-testid="' + id + '"]');
  function descendants(node, out) {
    out = out || [];
    node.children.forEach((child) => {
      if (child.nodeType === 1) {
        out.push(child);
        descendants(child, out);
      }
    });
    return out;
  }
  function findAll(root, testid) {
    return descendants(root).filter((node) => node.attributes['data-testid'] === testid);
  }
  function findOne(root, testid) {
    return findAll(root, testid)[0] || null;
  }
  function cards() {
    return findAll(byTestId('session-list'), 'session-card');
  }
  function storedText() {
    return storageMap.get(sandbox.Notebook.STORAGE_KEY);
  }
  function storedStore() {
    const raw = storedText();
    return raw ? JSON.parse(raw) : null;
  }

  return {
    byTestId,
    cards,
    descendants,
    findOne,
    loadSample: () => byTestId('load-sample').dispatch('click'),
    compare: () => byTestId('compare-button').dispatch('click'),
    submitForm: () => byTestId('session-form').dispatch('submit', { preventDefault() {} }),
    confirmYes: () => byTestId('confirm-yes').dispatch('click'),
    setFailWrites: (value) => { flags.failWrites = !!value; },
    storedText,
    storedStore,
    blobCalls: () => flags.blobCalls,
    activeElement: () => documentStub.activeElement,
    keydown: (key, keyOptions) => {
      const event = {
        key,
        shiftKey: !!(keyOptions && keyOptions.shiftKey),
        defaultPrevented: false,
        preventDefault() { event.defaultPrevented = true; }
      };
      (documentStub.listeners['keydown'] || []).slice().forEach((fn) => fn(event));
      return event;
    },
    toastText: () => byTestId('toast').textContent
  };
}

function editFirstCardNotes(app, notes) {
  const card = app.cards()[0];
  const id = card.attributes['data-session-id'];
  app.findOne(card, 'edit-session').dispatch('click');
  app.byTestId('session-notes').value = notes;
  app.submitForm();
  assert.equal(app.byTestId('confirm-dialog').hidden, false, 'edit save must ask for confirmation');
  app.confirmYes();
  return id;
}

function assertReportInvalidated(app, label) {
  assert.equal(app.byTestId('download-report').disabled, true, label + ': report download must be disabled');
  assert.equal(app.byTestId('download-compare-json').disabled, true, label + ': comparison JSON download must be disabled');
  assert.equal(app.byTestId('print-report').disabled, true, label + ': print must be disabled');
  assert.equal(app.byTestId('report-preview').textContent, REPORT_PLACEHOLDER, label + ': preview must reset to the placeholder');
  app.byTestId('download-report').dispatch('click');
  assert.equal(app.blobCalls(), 0, label + ': clicking the report button must not produce a download');
}

test('regression: editing a compared session after a comparison invalidates the cached report', () => {
  const app = boot();
  app.loadSample();
  assert.equal(app.cards().length, 2);
  app.compare();
  assert.equal(app.byTestId('download-report').disabled, false, 'report download is enabled after a comparison');
  assert.ok(app.byTestId('report-preview').textContent.includes('Pre-service scan (fictional)'));

  const editedId = editFirstCardNotes(app, 'Edited evidence after comparison');

  // The save itself applied and persisted (we are testing invalidation, not a failed save)...
  const stored = app.storedStore();
  const storedSession = stored.sessions.filter((session) => session.id === editedId)[0];
  assert.ok(storedSession, 'edited session still exists in the store');
  assert.equal(storedSession.notes, 'Edited evidence after comparison');
  const card = app.cards().filter((candidate) => candidate.attributes['data-session-id'] === editedId)[0];
  const notesNode = app.descendants(card).filter((node) => node.className === 'notes')[0];
  assert.ok(notesNode && notesNode.textContent.includes('Edited evidence after comparison'), 'card shows the edited notes');

  // ...and the cached comparison/report must be gone: no stale export.
  assertReportInvalidated(app, 'edit');
});

test('regression: replacing all sessions (sample reload) after a comparison invalidates the cached report', () => {
  const app = boot();
  app.loadSample();
  app.compare();
  assert.equal(app.byTestId('download-report').disabled, false);

  app.loadSample(); // sessions exist -> confirmation required
  assert.equal(app.byTestId('confirm-dialog').hidden, false, 'sample reload over existing records must ask for confirmation');
  app.confirmYes();
  assert.equal(app.cards().length, 2);

  assertReportInvalidated(app, 'replace');
});

test('regression: adding an unrelated session after a comparison invalidates the cached report', () => {
  const app = boot();
  app.loadSample();
  app.compare();
  assert.equal(app.byTestId('download-report').disabled, false);

  app.byTestId('session-title').value = 'Unrelated follow-up';
  app.submitForm();
  assert.equal(app.cards().length, 3, 'the unrelated session was saved');

  assertReportInvalidated(app, 'unrelated add');
});

test('regression: a failed write applies in memory, invalidates the report, and preserves stored bytes', () => {
  const app = boot();
  app.loadSample();
  app.compare();
  const before = app.storedText();
  assert.ok(before && before.length > 0, 'sample store was written');

  app.setFailWrites(true);
  const editedId = editFirstCardNotes(app, 'Edited evidence after comparison');

  // In-memory change applied and visible, with a visible warning...
  const card = app.cards().filter((candidate) => candidate.attributes['data-session-id'] === editedId)[0];
  const notesNode = app.descendants(card).filter((node) => node.className === 'notes')[0];
  assert.ok(notesNode && notesNode.textContent.includes('Edited evidence after comparison'), 'edited notes kept in memory');
  assert.ok(app.byTestId('storage-status').textContent.includes('In-memory only'), 'failed write is reported visibly');
  assert.equal(app.storedText(), before, 'failed write must leave stored bytes untouched');

  // ...and no stale report may be exported from memory either.
  assertReportInvalidated(app, 'failed write');
});

test('regression: deleting a compared session invalidates the cached report', () => {
  const app = boot();
  app.loadSample();
  app.compare();
  assert.equal(app.byTestId('download-report').disabled, false);

  const firstCard = app.cards()[0];
  app.findOne(firstCard, 'delete-session').dispatch('click');
  assert.equal(app.byTestId('confirm-dialog').hidden, false, 'delete must ask for confirmation');
  app.confirmYes();
  assert.equal(app.cards().length, 1);

  assertReportInvalidated(app, 'delete');
});

/* ------------------------------------------------------------------ */
/* Regression batch: quality-review minor findings                     */
/* ------------------------------------------------------------------ */

test('regression: deleting the last session with the active tag filter clears the filter before the list renders', () => {
  const app = boot();
  app.byTestId('session-title').value = 'Alpha';
  app.byTestId('session-tags').value = 'engine';
  app.submitForm();
  app.byTestId('session-title').value = 'Beta';
  app.byTestId('session-tags').value = 'brakes';
  app.submitForm();
  assert.equal(app.cards().length, 2);

  const filter = app.byTestId('tag-filter');
  filter.value = 'engine';
  filter.dispatch('change', { target: filter });
  assert.equal(app.cards().length, 1, 'the tag filter narrows the list');

  app.findOne(app.cards()[0], 'delete-session').dispatch('click');
  assert.equal(app.byTestId('confirm-dialog').hidden, false, 'delete must ask for confirmation');
  app.confirmYes();

  assert.equal(app.cards().length, 1, 'the remaining session is listed once the vanished filter clears');
  assert.equal(app.findOne(app.cards()[0], 'card-title').textContent, 'Beta');
  const emptyNodes = app.descendants(app.byTestId('session-list')).filter((node) => node.className === 'empty');
  assert.equal(emptyNodes.length, 0, 'no stale "No sessions match" message');
  assert.equal(app.byTestId('tag-filter').value, '', 'the tag filter resets to All tags');
  assert.equal(app.byTestId('session-count').textContent, '1 of 1 session');
});

test('regression: the confirm dialog keeps keyboard focus contained and restores it on close', () => {
  const app = boot();
  const trigger = app.byTestId('reset-data');
  trigger.focus();
  trigger.dispatch('click');
  assert.equal(app.byTestId('confirm-dialog').hidden, false, 'the dialog opens');
  assert.equal(app.activeElement(), app.byTestId('confirm-no'), 'focus moves into the dialog on open');

  app.keydown('Tab');
  assert.equal(app.activeElement(), app.byTestId('confirm-yes'), 'Tab from the last control wraps to the first');
  app.keydown('Tab');
  assert.equal(app.activeElement(), app.byTestId('confirm-no'), 'Tab moves between dialog controls');
  app.keydown('Tab', { shiftKey: true });
  assert.equal(app.activeElement(), app.byTestId('confirm-yes'), 'Shift+Tab cycles backwards inside the dialog');

  app.byTestId('confirm-no').dispatch('click');
  assert.equal(app.byTestId('confirm-dialog').hidden, true, 'the dialog closes');
  assert.equal(app.activeElement(), trigger, 'focus returns to the trigger');

  trigger.dispatch('click');
  app.keydown('Escape');
  assert.equal(app.byTestId('confirm-dialog').hidden, true, 'Escape still closes the dialog');
  const event = app.keydown('Tab');
  assert.equal(event.defaultPrevented, false, 'Tab is not intercepted while the dialog is closed');
});

test('regression: a reversed before/after selection gets an explicit note in the UI and report', () => {
  const app = boot();
  app.byTestId('session-date').value = '2026-10-05';
  app.byTestId('session-title').value = 'Later session';
  app.submitForm();
  app.byTestId('session-date').value = '2026-09-14';
  app.byTestId('session-title').value = 'Earlier session';
  app.submitForm();
  assert.equal(app.cards().length, 2);

  const cardByTitle = (title) => app.cards().filter((card) => app.findOne(card, 'card-title').textContent === title)[0];
  app.byTestId('before-select').value = cardByTitle('Later session').attributes['data-session-id'];
  app.byTestId('after-select').value = cardByTitle('Earlier session').attributes['data-session-id'];
  app.compare();

  assert.ok(app.byTestId('compare-note').textContent.includes('dated earlier'), 'the UI note flags the reversed order');
  assert.ok(app.byTestId('report-preview').textContent.includes('does not follow chronological order'), 'the report flags the reversed order');

  app.loadSample();
  app.confirmYes();
  app.compare();
  assert.ok(!app.byTestId('compare-note').textContent.includes('dated earlier'), 'no reversal note for the in-order sample');
  assert.ok(!app.byTestId('report-preview').textContent.includes('does not follow chronological order'));
});

test('regression: duplicate stored session ids get fresh ids on load and act on exactly one record', () => {
  const first = N.createSession({ date: '2026-09-01', title: 'Duplicate first' }, { id: 'dup-1', now: '2026-09-01T00:00:00.000Z' });
  const second = N.createSession({ date: '2026-10-01', title: 'Duplicate second' }, { id: 'dup-1', now: '2026-10-01T00:00:00.000Z' });
  const app = boot({ seedText: JSON.stringify({ version: 1, sessions: [first, second] }) });

  assert.equal(app.cards().length, 2, 'both duplicate-id records are preserved');
  const ids = app.cards().map((card) => card.attributes['data-session-id']);
  assert.equal(new Set(ids).size, 2, 'ids are unique after load');
  assert.ok(app.toastText().includes('Duplicate session id'), 'the reassignment is announced');

  const secondCard = app.cards().filter((card) => app.findOne(card, 'card-title').textContent === 'Duplicate second')[0];
  app.findOne(secondCard, 'edit-session').dispatch('click');
  app.byTestId('session-notes').value = 'Edited duplicate';
  app.submitForm();
  app.confirmYes();
  const stored = app.storedStore();
  assert.equal(stored.sessions.filter((session) => session.notes === 'Edited duplicate').length, 1, 'an edit touches exactly one record');

  const currentSecond = app.cards().filter((card) => app.findOne(card, 'card-title').textContent === 'Duplicate second')[0];
  app.findOne(currentSecond, 'delete-session').dispatch('click');
  app.confirmYes();
  assert.equal(app.cards().length, 1, 'a delete removes exactly one record');
  assert.equal(app.findOne(app.cards()[0], 'card-title').textContent, 'Duplicate first', 'the other record survives');
});

test('regression: storage that refuses writes still loads readable sessions with an honest banner', () => {
  const seed = JSON.stringify({ version: 1, sessions: [
    N.createSession({ date: '2026-09-01', title: 'Readable one' }, { id: 'ro-1', now: '2026-09-01T00:00:00.000Z' }),
    N.createSession({ date: '2026-10-01', title: 'Readable two' }, { id: 'ro-2', now: '2026-10-01T00:00:00.000Z' })
  ] });
  const app = boot({ seedText: seed, failWrites: true });

  assert.equal(app.cards().length, 2, 'readable stored sessions are loaded even though writes are refused');
  assert.ok(app.byTestId('storage-status').textContent.includes('refused a test write'), 'the banner is honest about the write failure');
  assert.ok(app.byTestId('storage-status').textContent.includes('memory'), 'the banner states the memory fallback');

  app.byTestId('session-title').value = 'New in-memory session';
  app.submitForm();
  assert.equal(app.cards().length, 3, 'the session is kept in memory');
  assert.ok(app.byTestId('storage-status').textContent.includes('In-memory only'), 'the failed save is reported visibly');
  assert.equal(app.storedText(), seed, 'failed writes leave stored bytes untouched');
});

test('regression: an over-limit text log fails visibly at preview instead of passing to save', () => {
  const app = boot();
  const lines = ['Address 01: Engine'];
  for (let i = 0; i < 501; i++) lines.push(String(100000 + i) + ' - Example fault ' + i);
  app.byTestId('import-text').value = lines.join('\n');
  app.byTestId('preview-button').dispatch('click');
  assert.ok(app.toastText().includes('more than 500'), 'the preview surfaces the over-limit failure');
  assert.equal(app.byTestId('preview-panel').hidden, true, 'no preview is shown for a rejected log');
});

test('regression: a tag named __proto__ still appears in the tag filter', () => {
  const app = boot();
  app.byTestId('session-title').value = 'Prototype tag';
  app.byTestId('session-tags').value = '__proto__';
  app.submitForm();
  assert.equal(app.cards().length, 1);

  const options = app.descendants(app.byTestId('tag-filter')).filter((node) => node.attributes.value === '__proto__');
  assert.equal(options.length, 1, 'the tag filter must list the __proto__ tag');

  const filter = app.byTestId('tag-filter');
  filter.value = '__proto__';
  filter.dispatch('change', { target: filter });
  assert.equal(app.cards().length, 1, 'filtering by the __proto__ tag keeps its session');
});
