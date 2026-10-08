/*
 * Diagnostic Session Notebook - UI wiring.
 * Classic script, no frameworks, no network. All user text renders through
 * textContent / createTextNode; the document is never assembled from HTML
 * strings. Raw scan input stays in the textarea only and is redacted before
 * anything is stored.
 */
(function () {
  'use strict';

  var N = window.Notebook;
  if (!N) {
    var statusEl = document.querySelector('[data-testid="storage-status"]');
    if (statusEl) statusEl.textContent = 'core.js failed to load, so the notebook cannot start.';
    return;
  }

  var state = {
    store: N.emptyStore(),
    storage: null,
    storageMode: 'local',      /* 'local' | 'memory' */
    protectedStorage: false,   /* stored data unreadable: saves stay blocked until reset/import */
    lastWriteError: null,
    writeBlocked: false,       /* probe write refused: reads work, new writes go to memory */
    editingId: null,
    filters: { query: '', tag: '' },
    comparison: null,
    modalAction: null,
    lastFocus: null
  };

  /* ---------------- helpers ---------------- */

  function $(testid) {
    return document.querySelector('[data-testid="' + testid + '"]');
  }

  function setText(node, text) {
    node.textContent = text;
  }

  function clearChildren(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        if (key === 'text') node.textContent = attrs[key];
        else if (key === 'class') node.className = attrs[key];
        else node.setAttribute(key, attrs[key]);
      });
    }
    (children || []).forEach(function (child) {
      if (child == null) return;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return node;
  }

  function todayLocal() {
    var now = new Date();
    var pad = function (value) { return value < 10 ? '0' + value : String(value); };
    return now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
  }

  function findSession(id) {
    var found = null;
    state.store.sessions.forEach(function (session) {
      if (session.id === id) found = session;
    });
    return found;
  }

  function sortSessions(a, b) {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    var aCreated = a.createdAt || '';
    var bCreated = b.createdAt || '';
    if (aCreated !== bCreated) return aCreated < bCreated ? -1 : 1;
    return 0;
  }

  function cloneStore() {
    return { version: state.store.version, sessions: state.store.sessions.slice() };
  }

  var toastTimer = null;
  function toast(message) {
    var node = $('toast');
    setText(node, message);
    node.hidden = false;
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () { node.hidden = true; }, 8000);
  }

  function download(filename, text, mime) {
    var blob = new window.Blob([text], { type: mime });
    var url = window.URL.createObjectURL(blob);
    var anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(function () { window.URL.revokeObjectURL(url); }, 4000);
  }

  /* ---------------- storage ---------------- */

  /* Distinguishes three storage states: fully blocked (memory only), and
   * readable-but-write-refused (quota/security on write) where stored
   * sessions can still be loaded and only writes fall back to memory. */
  function probeStorage() {
    var probeKey = N.STORAGE_KEY + '.probe';
    var writeOk = true;
    try {
      window.localStorage.setItem(probeKey, '1');
      window.localStorage.removeItem(probeKey);
    } catch (error) {
      writeOk = false;
    }
    try {
      window.localStorage.getItem(probeKey);
    } catch (error) {
      return { storage: null, mode: 'memory', writeOk: false };
    }
    return { storage: window.localStorage, mode: 'local', writeOk: writeOk };
  }

  function commitStore(nextStore) {
    if (state.protectedStorage) {
      toast('Stored notebook data was not loaded (unreadable or different version). Reset local data or import a backup before saving.');
      return false;
    }
    var result = N.saveStoreTo(state.storage, nextStore);
    state.store = nextStore;
    /* Central stale-report guard: the cached comparison and its prebuilt
     * report belong to the previous store. Any applied mutation - edit,
     * delete, replacement or addition, persisted or kept in memory after a
     * failed write - drops them, so a stale report can never be exported.
     * A commit blocked by protected storage returns above and changes
     * nothing, so the existing report stays valid in that case. */
    state.comparison = null;
    if (result.ok) {
      state.lastWriteError = null;
      state.writeBlocked = false;
    } else {
      state.lastWriteError = result;
    }
    renderStorageStatus();
    return true;
  }

  function renderStorageStatus() {
    var node = $('storage-status');
    var count = state.store.sessions.length;
    var message;
    if (state.protectedStorage) {
      message = 'Stored notebook data was NOT loaded (unreadable or written by a different version). Saving is disabled so it cannot be destroyed. Reset local data or import a backup to continue.';
      node.className = 'notice warn';
    } else if (state.lastWriteError) {
      message = 'In-memory only - the last save failed: ' + state.lastWriteError.message + ' Export a backup to keep your changes.';
      node.className = 'notice warn';
    } else if (state.writeBlocked) {
      message = 'Storage is readable but this browser refused a test write (full or blocked). Stored sessions were loaded; new changes will be kept in memory only. Export a backup to keep them.';
      node.className = 'notice warn';
    } else if (state.storageMode === 'memory') {
      message = 'In-memory only - browser storage is unavailable or blocked. Changes are lost when this tab closes. Export a backup to keep them.';
      node.className = 'notice warn';
    } else {
      var bytes = N.byteLength(N.serializeStore(state.store));
      var sizeLabel = bytes < 1024 ? bytes + ' B' : Math.round(bytes / 1024) + ' KB';
      message = 'Saved locally in this browser - ' + count + ' session' + (count === 1 ? '' : 's') + ' - ' + sizeLabel + ' stored - no network requests.';
      node.className = 'notice';
    }
    setText(node, message);
  }

  /* ---------------- rendering: notebook ---------------- */

  function filteredSessions() {
    var query = state.filters.query.trim().toLowerCase();
    var tag = state.filters.tag.trim().toLowerCase();
    return state.store.sessions.filter(function (session) {
      if (tag) {
        var hasTag = session.tags.some(function (value) { return value.toLowerCase() === tag; });
        if (!hasTag) return false;
      }
      if (!query) return true;
      var haystack = [session.title, session.vehicle, session.notes, session.date, session.tags.join(' ')]
        .concat(session.faults.map(function (fault) { return fault.code + ' ' + fault.module + ' ' + fault.description; }))
        .join(' ')
        .toLowerCase();
      return haystack.indexOf(query) !== -1;
    });
  }

  function sessionCard(session) {
    var card = el('article', { 'data-testid': 'session-card', 'data-session-id': session.id, class: 'session-card' });
    card.appendChild(el('div', { class: 'card-head' }, [
      el('h3', { 'data-testid': 'card-title', text: session.title }),
      el('span', { class: 'chip', 'data-testid': 'card-date', text: session.date })
    ]));
    card.appendChild(el('p', { class: 'meta', 'data-testid': 'card-vehicle', text: session.vehicle ? 'Vehicle: ' + session.vehicle : 'No vehicle nickname' }));
    var tagRow = el('div', { class: 'tags', 'data-testid': 'card-tags' });
    session.tags.forEach(function (tag) {
      tagRow.appendChild(el('span', { class: 'tag', text: tag }));
    });
    card.appendChild(tagRow);
    var faultsLabel = session.faults.length + ' fault entr' + (session.faults.length === 1 ? 'y' : 'ies');
    if (session.redactions && session.redactions.count) faultsLabel += ' - ' + session.redactions.count + ' redaction(s) applied at save';
    card.appendChild(el('p', { class: 'meta', 'data-testid': 'card-faults-count', text: faultsLabel }));
    if (session.notes) {
      var notes = session.notes.length > 200 ? session.notes.slice(0, 200) + '\u2026' : session.notes;
      card.appendChild(el('p', { class: 'notes', text: notes }));
    }
    var details = el('details', { class: 'card-faults' });
    details.appendChild(el('summary', { text: 'Fault list (' + session.faults.length + ')' }));
    var faultList = el('ul', { 'data-testid': 'card-fault-list', class: 'fault-list' });
    if (!session.faults.length) {
      faultList.appendChild(el('li', { class: 'meta', text: 'No fault entries stored.' }));
    }
    session.faults.forEach(function (fault) {
      faultList.appendChild(el('li', {}, [
        el('strong', { text: fault.code }),
        el('span', { class: 'meta', text: ' - ' + fault.module + (fault.occurrences > 1 ? ' (x' + fault.occurrences + ')' : '') }),
        fault.description ? el('small', { text: fault.description }) : null
      ]));
    });
    details.appendChild(faultList);
    card.appendChild(details);
    var editButton = el('button', { type: 'button', 'data-testid': 'edit-session', text: 'Edit' });
    var deleteButton = el('button', { type: 'button', 'data-testid': 'delete-session', class: 'danger', text: 'Delete' });
    editButton.addEventListener('click', function () { startEdit(session.id); });
    deleteButton.addEventListener('click', function () { deleteSession(session.id); });
    card.appendChild(el('div', { class: 'toolbar' }, [editButton, deleteButton]));
    return card;
  }

  function renderSessions() {
    var list = $('session-list');
    clearChildren(list);
    var sessions = filteredSessions();
    var total = state.store.sessions.length;
    setText($('session-count'), sessions.length + ' of ' + total + ' session' + (total === 1 ? '' : 's'));
    $('empty-state').hidden = total !== 0;
    if (!sessions.length) {
      if (total) list.appendChild(el('p', { class: 'empty', text: 'No sessions match the current search or tag filter.' }));
      return;
    }
    sessions.slice().sort(sortSessions).reverse().forEach(function (session) {
      list.appendChild(sessionCard(session));
    });
  }

  function fillSelect(select, placeholder, sessions) {
    var previous = select.value;
    clearChildren(select);
    select.appendChild(el('option', { value: '', text: placeholder }));
    sessions.forEach(function (session) {
      select.appendChild(el('option', { value: session.id, text: session.date + ' - ' + session.title }));
    });
    if (previous && findSession(previous)) select.value = previous;
  }

  function renderSelects() {
    var sessions = state.store.sessions.slice().sort(sortSessions);
    fillSelect($('before-select'), 'Select before session', sessions);
    fillSelect($('after-select'), 'Select after session', sessions);
  }

  function setSelects(beforeId, afterId) {
    $('before-select').value = beforeId;
    $('after-select').value = afterId;
  }

  function renderTagFilter() {
    var select = $('tag-filter');
    var current = select.value;
    var tags = new Map();
    state.store.sessions.forEach(function (session) {
      session.tags.forEach(function (tag) { tags.set(tag.toLowerCase(), tag); });
    });
    clearChildren(select);
    select.appendChild(el('option', { value: '', text: 'All tags' }));
    Array.from(tags.keys()).sort().forEach(function (key) {
      select.appendChild(el('option', { value: key, text: tags.get(key) }));
    });
    if (current && tags.has(current)) {
      select.value = current;
    } else if (current) {
      state.filters.tag = '';
      select.value = '';
    }
  }

  /* ---------------- rendering: comparison and report ---------------- */

  function renderDiffList(testid, entries, group) {
    var list = $(testid);
    clearChildren(list);
    if (!entries.length) {
      list.appendChild(el('li', { class: 'none', text: 'None.' }));
      return;
    }
    entries.forEach(function (entry) {
      list.appendChild(el('li', { 'data-testid': 'diff-item', 'data-group': group, 'data-code': entry.code, class: 'diff-item' }, [
        el('strong', { text: entry.code }),
        el('span', { class: 'meta', text: ' - ' + entry.module }),
        el('small', { text: (entry.description || '(no description)') + ' - before x' + entry.occurrencesBefore + ' / after x' + entry.occurrencesAfter })
      ]));
    });
  }

  function renderComparison() {
    var comparison = state.comparison;
    var counts = { new: 0, absent: 0, persisting: 0 };
    var entries = { new: [], absent: [], persisting: [] };
    if (comparison) {
      counts = {
        'new': comparison.result.new.length,
        absent: comparison.result.absent.length,
        persisting: comparison.result.persisting.length
      };
      entries = comparison.result;
    }
    setText($('diff-new-count'), String(counts['new']));
    setText($('diff-absent-count'), String(counts.absent));
    setText($('diff-persisting-count'), String(counts.persisting));
    renderDiffList('diff-new-list', entries['new'], 'new');
    renderDiffList('diff-absent-list', entries.absent, 'absent');
    renderDiffList('diff-persisting-list', entries.persisting, 'persisting');
    var note = $('compare-note');
    if (comparison) {
      var parts = ['Compared "' + comparison.before.title + '" then "' + comparison.after.title + '". Absence from a later scan does not prove a repair.'];
      if (N.isReversedDateOrder(comparison.before, comparison.after)) {
        parts.push('Note: the "after" session is dated earlier than the "before" session; verify the selection order.');
      }
      comparison.result.warnings.forEach(function (warning) { parts.push(warning); });
      setText(note, parts.join(' '));
    } else {
      setText(note, 'Pick two sessions and compare. Absence from a later scan does not prove a repair.');
    }
  }

  function renderReport() {
    var hasReport = !!state.comparison;
    $('download-report').disabled = !hasReport;
    $('download-compare-json').disabled = !hasReport;
    $('print-report').disabled = !hasReport;
    setText($('report-preview'), hasReport ? state.comparison.report : 'Run a comparison to build the report.');
  }

  function renderAll() {
    /* renderTagFilter first: it may clear a filter whose tag no longer
     * exists, and the list must render with the cleared state. */
    renderTagFilter();
    renderSessions();
    renderSelects();
    renderStorageStatus();
    renderComparison();
    renderReport();
  }

  /* ---------------- confirm modal ---------------- */

  function confirmAction(message, onYes) {
    state.modalAction = onYes;
    state.lastFocus = document.activeElement;
    setText($('confirm-message'), message);
    $('confirm-dialog').hidden = false;
    $('confirm-no').focus();
  }

  function closeConfirm() {
    $('confirm-dialog').hidden = true;
    state.modalAction = null;
    if (state.lastFocus && state.lastFocus.focus) state.lastFocus.focus();
  }

  function acceptConfirm() {
    var action = state.modalAction;
    closeConfirm();
    if (action) action();
  }

  /* ---------------- form actions ---------------- */

  function collectForm() {
    return {
      date: $('session-date').value,
      title: $('session-title').value,
      vehicle: $('session-vehicle').value,
      tags: $('session-tags').value.split(',').map(function (tag) { return tag.trim(); }).filter(function (tag) { return tag.length > 0; }),
      notes: $('session-notes').value
    };
  }

  function clearForm() {
    $('session-date').value = todayLocal();
    $('session-title').value = '';
    $('session-vehicle').value = '';
    $('session-tags').value = '';
    $('session-notes').value = '';
    $('import-text').value = '';
    state.editingId = null;
    hidePreview();
    $('edit-banner').hidden = true;
    $('cancel-edit').hidden = true;
    setText($('save-session'), 'Save session');
    setText($('fault-count'), 'Saving without a scan stores a session with zero fault entries.');
  }

  function hidePreview() {
    $('preview-panel').hidden = true;
    setText($('preview-summary'), '');
    setText($('preview-text'), '');
    clearChildren($('preview-faults'));
  }

  function renderPreview(parsed) {
    var panel = $('preview-panel');
    var byType = parsed.redactions.byType || {};
    var typeParts = Object.keys(byType).map(function (key) { return key + ' x' + byType[key]; });
    var lines = [];
    lines.push('Source: ' + (parsed.source === 'json' ? 'JSON import (structured)' : 'text log'));
    lines.push('Redactions applied: ' + parsed.redactions.count + (typeParts.length ? ' (' + typeParts.join(', ') + ')' : ''));
    if (parsed.warnings.length) lines.push('Warnings: ' + parsed.warnings.join(' | '));
    lines.push('Only the redacted result below is stored when you save. The raw input never leaves this textarea.');
    setText($('preview-summary'), lines.join('\n'));
    setText($('preview-text'), parsed.redactedPreview);
    var box = $('preview-faults');
    clearChildren(box);
    box.appendChild(el('p', { class: 'hint', text: 'Parsed fault entries (redacted): ' + parsed.faults.length + ' shown up to 50.' }));
    var list = el('ul', { class: 'fault-list' });
    if (!parsed.faults.length) {
      list.appendChild(el('li', { class: 'meta', text: 'No fault entries recognized.' }));
    }
    parsed.faults.slice(0, 50).forEach(function (fault) {
      list.appendChild(el('li', {}, [
        el('strong', { text: fault.code }),
        el('span', { class: 'meta', text: ' - ' + fault.module + (fault.occurrences > 1 ? ' (x' + fault.occurrences + ')' : '') }),
        fault.description ? el('small', { text: fault.description }) : null
      ]));
    });
    box.appendChild(list);
    panel.hidden = false;
  }

  function previewRedaction() {
    var raw = $('import-text').value;
    if (!raw.trim()) {
      hidePreview();
      setText($('fault-count'), 'No scan text to preview. Saving without a scan stores a session with zero fault entries.');
      toast('Paste or open a scan first.');
      return;
    }
    try {
      var parsed = N.parseScan(raw);
      renderPreview(parsed);
      var meta = parsed.meta || {};
      if (meta.title && !$('session-title').value.trim()) $('session-title').value = meta.title;
      if (meta.vehicle && !$('session-vehicle').value.trim()) $('session-vehicle').value = meta.vehicle;
      if (meta.tags && meta.tags.length && !$('session-tags').value.trim()) $('session-tags').value = meta.tags.join(', ');
      if (meta.notes && !$('session-notes').value.trim()) $('session-notes').value = meta.notes;
      var label = parsed.faults.length + ' fault entr' + (parsed.faults.length === 1 ? 'y' : 'ies') + ' parsed and redacted.';
      if (!parsed.faults.length) label += ' Nothing recognized: check the format before saving.';
      setText($('fault-count'), label);
      parsed.warnings.forEach(function (warning) { toast(warning); });
    } catch (error) {
      hidePreview();
      setText($('fault-count'), 'Scan could not be parsed. Fix the input and preview again.');
      toast(error && error.message ? error.message : 'Scan could not be parsed.');
    }
  }

  function handleScanFile(file) {
    if (!file) return;
    if (file.size > N.LIMITS.MAX_IMPORT_BYTES) {
      toast('That file is larger than the 5 MB import limit.');
      return;
    }
    file.text().then(function (text) {
      $('import-text').value = text;
      previewRedaction();
    }).catch(function () {
      toast('Could not read that file.');
    });
  }

  function saveSession() {
    try {
      var fields = collectForm();
      var existing = state.editingId ? findSession(state.editingId) : null;
      var hasImportText = $('import-text').value.trim().length > 0;
      if (existing) {
        fields.faults = hasImportText ? N.parseScan($('import-text').value).faults : existing.faults;
        var updated = N.updateSession(existing, fields);
        confirmAction('Save changes to "' + updated.title + '"? The stored record is replaced (' + updated.faults.length + ' fault entries).', function () {
          var next = cloneStore();
          next.sessions = next.sessions.map(function (session) { return session.id === updated.id ? updated : session; });
          if (!commitStore(next)) { renderAll(); return; }
          clearForm();
          renderAll();
          toast('Session updated.');
        });
        return;
      }
      fields.faults = hasImportText ? N.parseScan($('import-text').value).faults : [];
      var created = N.createSession(fields);
      if (state.store.sessions.length >= N.LIMITS.MAX_SESSIONS) {
        toast('The notebook already holds the maximum of ' + N.LIMITS.MAX_SESSIONS + ' sessions. Delete one first.');
        return;
      }
      var nextStore = cloneStore();
      nextStore.sessions.push(created);
      if (!commitStore(nextStore)) { renderAll(); return; }
      clearForm();
      renderAll();
      if (created.faults.length === 0) {
        toast('Session saved with zero fault entries. An empty list may mean the scan was empty or its format was not recognized - verify the source.');
      } else {
        toast('Session saved: ' + created.faults.length + ' fault entries stored (redacted).');
      }
    } catch (error) {
      toast(error && error.message ? error.message : 'Could not save the session.');
    }
  }

  function startEdit(sessionId) {
    var session = findSession(sessionId);
    if (!session) return;
    state.editingId = session.id;
    $('session-date').value = session.date;
    $('session-title').value = session.title;
    $('session-vehicle').value = session.vehicle;
    $('session-tags').value = session.tags.join(', ');
    $('session-notes').value = session.notes;
    $('import-text').value = '';
    hidePreview();
    $('edit-banner').hidden = false;
    $('cancel-edit').hidden = false;
    setText($('save-session'), 'Update session');
    setText($('fault-count'), 'Editing: ' + session.faults.length + ' fault entries stored. Saving keeps them unless you paste a new scan here (which replaces the list).');
    $('session-title').focus();
  }

  function deleteSession(sessionId) {
    var session = findSession(sessionId);
    if (!session) return;
    confirmAction('Delete session "' + session.title + '" (' + session.date + ') with ' + session.faults.length + ' fault entries? This cannot be undone.', function () {
      var next = cloneStore();
      next.sessions = next.sessions.filter(function (candidate) { return candidate.id !== sessionId; });
      commitStore(next);
      if (state.editingId === sessionId) clearForm();
      renderAll();
      toast('Session deleted.');
    });
  }

  /* ---------------- comparison, reports, exports ---------------- */

  function runComparison() {
    var beforeId = $('before-select').value;
    var afterId = $('after-select').value;
    if (!beforeId || !afterId) {
      toast('Choose both a before session and an after session.');
      return;
    }
    if (beforeId === afterId) {
      toast('Choose two different sessions to compare.');
      return;
    }
    var before = findSession(beforeId);
    var after = findSession(afterId);
    if (!before || !after) {
      toast('One of the selected sessions no longer exists.');
      return;
    }
    var result = N.compareFaults(before.faults, after.faults);
    var generatedAt = new Date().toISOString();
    var report = N.buildReportText({ before: before, after: after, comparison: result, generatedAt: generatedAt });
    state.comparison = { beforeId: beforeId, afterId: afterId, before: before, after: after, result: result, generatedAt: generatedAt, report: report };
    renderComparison();
    renderReport();
    toast('Comparison ready: ' + result['new'].length + ' new, ' + result.absent.length + ' absent, ' + result.persisting.length + ' persisting.');
  }

  function downloadReport() {
    if (!state.comparison) return;
    var names = N.exportFilenames(state.comparison.generatedAt);
    download(names.report, state.comparison.report, 'text/plain;charset=utf-8');
    toast('Report download started: ' + names.report);
  }

  function downloadComparisonJson() {
    if (!state.comparison) return;
    var names = N.exportFilenames(state.comparison.generatedAt);
    var text = N.buildComparisonJson({
      before: state.comparison.before,
      after: state.comparison.after,
      comparison: state.comparison.result,
      generatedAt: state.comparison.generatedAt
    });
    download(names.comparisonJson, text, 'application/json;charset=utf-8');
    toast('Comparison download started: ' + names.comparisonJson);
  }

  function exportBackup() {
    var names = N.exportFilenames(new Date().toISOString());
    var text = N.buildBackupJson(state.store, {});
    download(names.backup, text, 'application/json;charset=utf-8');
    toast('Backup download started: ' + names.backup);
  }

  function importBackupFile(file) {
    if (!file) return;
    if (file.size > N.LIMITS.MAX_TOTAL_BYTES * 2) {
      toast('That backup file is far larger than the 5 MB notebook limit.');
      return;
    }
    file.text().then(function (text) {
      var preview = null;
      try {
        preview = JSON.parse(text);
      } catch (error) {
        toast('Backup file is not valid JSON.');
        return;
      }
      var count = preview && Array.isArray(preview.sessions) ? preview.sessions.length : 'an unknown number of';
      confirmAction('Import this backup and replace all current local data? The file lists ' + count + ' session(s). Validation and redaction run before anything is written.', function () {
        var imported = N.importBackupText(state.storage, text);
        if (!imported.ok) {
          toast('Import failed: ' + imported.message);
          return;
        }
        state.store = imported.store;
        state.protectedStorage = false;
        state.lastWriteError = null;
        state.writeBlocked = false;
        state.comparison = null;
        renderAll();
        toast('Backup imported: ' + imported.store.sessions.length + ' session(s), re-redacted on import.');
      });
    }).catch(function () {
      toast('Could not read the backup file.');
    });
  }

  function loadSample() {
    var proceed = function () {
      var sample = N.sampleData();
      var before = N.createSession(sample.before, { id: 'sample-before', now: '2026-09-14T09:00:00.000Z' });
      var after = N.createSession(sample.after, { id: 'sample-after', now: '2026-10-05T09:00:00.000Z' });
      var next = { version: N.SCHEMA_VERSION, sessions: [before, after] };
      if (!commitStore(next)) return;
      renderAll();
      setSelects('sample-before', 'sample-after');
      toast('Fictional sample loaded (2 sessions). The comparison selects are preset; click Compare sessions.');
    };
    if (state.store.sessions.length > 0) {
      confirmAction('Replace ' + state.store.sessions.length + ' existing session(s) with 2 fictional sample sessions? Existing records will be removed.', proceed);
    } else {
      proceed();
    }
  }

  function resetData() {
    confirmAction('Erase all locally stored notebook data (sessions and settings)? This cannot be undone.', function () {
      try {
        state.storage.removeItem(N.STORAGE_KEY);
      } catch (error) {
        /* storage may be unavailable; clearing memory below is still correct */
      }
      state.store = N.emptyStore();
      state.protectedStorage = false;
      state.lastWriteError = null;
      state.comparison = null;
      clearForm();
      renderAll();
      toast('Local data cleared.');
    });
  }

  function printReport() {
    if (!state.comparison) return;
    document.body.classList.add('print-report');
    var cleanup = function () {
      document.body.classList.remove('print-report');
      window.removeEventListener('afterprint', cleanup);
    };
    window.addEventListener('afterprint', cleanup);
    window.print();
    window.setTimeout(cleanup, 2000);
  }

  /* ---------------- events and init ---------------- */

  function bindEvents() {
    $('session-form').addEventListener('submit', function (event) {
      event.preventDefault();
      saveSession();
    });
    $('preview-button').addEventListener('click', previewRedaction);
    $('clear-import').addEventListener('click', function () {
      $('import-text').value = '';
      hidePreview();
      setText($('fault-count'), 'Import cleared. Saving without a scan stores a session with zero fault entries.');
    });
    $('cancel-edit').addEventListener('click', function () {
      clearForm();
      toast('Edit cancelled.');
    });
    $('import-file').addEventListener('change', function (event) {
      handleScanFile(event.target.files[0]);
      event.target.value = '';
    });
    $('import-backup-file').addEventListener('change', function (event) {
      importBackupFile(event.target.files[0]);
      event.target.value = '';
    });
    $('search-input').addEventListener('input', function (event) {
      state.filters.query = event.target.value;
      renderSessions();
    });
    $('tag-filter').addEventListener('change', function (event) {
      state.filters.tag = event.target.value;
      renderSessions();
    });
    $('compare-button').addEventListener('click', runComparison);
    $('download-report').addEventListener('click', downloadReport);
    $('download-compare-json').addEventListener('click', downloadComparisonJson);
    $('print-report').addEventListener('click', printReport);
    $('export-backup').addEventListener('click', exportBackup);
    $('load-sample').addEventListener('click', loadSample);
    $('reset-data').addEventListener('click', resetData);
    $('confirm-yes').addEventListener('click', acceptConfirm);
    $('confirm-no').addEventListener('click', closeConfirm);
    document.addEventListener('keydown', function (event) {
      var dialog = $('confirm-dialog');
      if (dialog.hidden) return;
      if (event.key === 'Escape') {
        closeConfirm();
        return;
      }
      if (event.key !== 'Tab') return;
      /* Keep keyboard focus inside the open dialog: Tab and Shift+Tab
       * cycle through its controls instead of reaching the background. */
      var focusables = [$('confirm-yes'), $('confirm-no')];
      var index = focusables.indexOf(document.activeElement);
      var next = event.shiftKey
        ? (index <= 0 ? focusables.length - 1 : index - 1)
        : (index === -1 || index === focusables.length - 1 ? 0 : index + 1);
      event.preventDefault();
      focusables[next].focus();
    });
  }

  function init() {
    var probed = probeStorage();
    if (probed.storage) {
      state.storage = probed.storage;
      state.storageMode = probed.mode;
      state.writeBlocked = !probed.writeOk;
    } else {
      state.storage = N.createMemoryStorage();
      state.storageMode = 'memory';
      state.writeBlocked = false;
    }
    var loaded = N.loadStoreFrom(state.storage);
    state.store = loaded.store;
    state.protectedStorage = loaded.protected;
    if (loaded.status === 'unavailable') {
      state.storageMode = 'memory';
      state.storage = N.createMemoryStorage();
    }
    $('session-date').value = todayLocal();
    bindEvents();
    renderAll();
    $('app').setAttribute('data-ready', 'true');
    var notices = loaded.warnings.slice(0, 2);
    if (loaded.skippedCount) notices.push(loaded.skippedCount + ' unreadable session record(s) were skipped during load and are still stored; saving will drop them.');
    if (notices.length) toast(notices.join(' '));
    window.__notebookDebug = {
      storageKey: N.STORAGE_KEY,
      version: N.SCHEMA_VERSION,
      storageMode: function () { return state.storageMode; },
      protected: function () { return state.protectedStorage; },
      sessionCount: function () { return state.store.sessions.length; }
    };
  }

  init();
})();
