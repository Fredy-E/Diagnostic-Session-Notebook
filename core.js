/*
 * Diagnostic Session Notebook - core logic.
 *
 * Pure offline logic: no DOM access, no network, no runtime dependencies.
 * Loads as a classic script in the browser (window.Notebook) and as a
 * CommonJS module in Node (module.exports) for unit tests.
 *
 * Portions adapted from the MIT-licensed "Diagnostic Scan Diff" starter
 * (starters/Diagnostic-Scan-Diff/scan.js): the VCDS-style text parsing
 * shape, the labelled-identifier redaction approach, the 5 MB input cap,
 * and the module|code comparison keying. This module extends that work
 * for the session notebook (JSON normalisation, metadata redaction,
 * strict schema limits, versioned storage, reports and exports).
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Notebook = factory();
  }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  var SCHEMA_VERSION = 1;
  var STORAGE_KEY = 'diagnostic-session-notebook.v1';

  /* Ids and redaction-count keys that can reach storage, reports and
   * exports are constrained to these shapes, so imported or hand-edited
   * data can never smuggle markup or prototype-member names into a
   * re-exported backup. */
  var SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
  var REDACTION_TYPE_PATTERN = /^[A-Z][A-Z0-9_]{0,39}$/;

  var LIMITS = Object.freeze({
    MAX_IMPORT_BYTES: 5 * 1024 * 1024,
    MAX_TOTAL_BYTES: 5 * 1024 * 1024,
    MAX_SESSIONS: 250,
    MAX_FAULTS_PER_SESSION: 500,
    MAX_JSON_ROWS: 5000,
    MAX_TITLE: 120,
    MAX_VEHICLE: 60,
    MAX_NOTES: 4000,
    MAX_TAG: 32,
    MAX_TAGS: 20,
    MAX_DESCRIPTION: 300,
    MAX_MODULE: 60,
    MAX_CODE: 30,
    MIN_DATE: '1970-01-01',
    MAX_DATE: '2100-12-31'
  });

  var LIMITATIONS = Object.freeze([
    'Redaction is best effort. Review this report before sharing it; identifiers the redactor did not recognize may remain.',
    'A code absent from the after scan describes this comparison only. It does not prove a repair.',
    'A scan listing zero faults does not prove the vehicle is healthy, and no scan proves completeness of the underlying diagnostic session.',
    'This notebook performs no vehicle control and is not a safety assessment or repair certification.'
  ]);

  function NotebookError(code, message) {
    this.name = 'NotebookError';
    this.code = code;
    this.message = message;
  }
  NotebookError.prototype = Object.create(Error.prototype);
  NotebookError.prototype.constructor = NotebookError;

  function fail(code, message) {
    throw new NotebookError(code, message);
  }

  /* ------------------------------------------------------------------ */
  /* Small utilities                                                     */
  /* ------------------------------------------------------------------ */

  function byteLength(value) {
    var text = String(value);
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text).length;
    return encodeURIComponent(text).replace(/%[0-9A-F]{2}/g, 'x').length;
  }

  function isValidDateString(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    var year = Number(value.slice(0, 4));
    var month = Number(value.slice(5, 7));
    var day = Number(value.slice(8, 10));
    var probe = new Date(Date.UTC(year, month - 1, day));
    if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return false;
    return value >= LIMITS.MIN_DATE && value <= LIMITS.MAX_DATE;
  }

  function generateId() {
    return 's-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function toIso(value) {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'string' && value) return value;
    return new Date().toISOString();
  }

  function addRedactions(target, source) {
    if (!source) return;
    target.count += source.count || 0;
    var byType = source.byType || {};
    Object.keys(byType).forEach(function (key) {
      target.byType[key] = (target.byType[key] || 0) + byType[key];
    });
  }

  /* ------------------------------------------------------------------ */
  /* Redaction (best effort, applied before anything is stored)          */
  /* ------------------------------------------------------------------ */

  var IDENTIFIER_LABELS = [
    { type: 'VIN', words: ['Vehicle[\\s_]+Identification[\\s_]+Number', 'VIN'] },
    { type: 'CHASSIS', words: ['Chassis[\\s_]+Number', 'Chassis[\\s_]+No\\.?', 'Chassis'] },
    { type: 'PLATE', words: ['Licen[cs]e[\\s_]+Plate', 'Licen[cs]e[\\s_]+No\\.?', 'Plate'] },
    { type: 'REGISTRATION', words: ['Registration[\\s_]+Number', 'Registration[\\s_]+No\\.?', 'Registration', 'Reg[\\s_]?No\\.?', 'Reg\\.?'] },
    { type: 'SERIAL', words: ['Serial[\\s_]+Number', 'Serial[\\s_]+No\\.?', 'Serial', 'S/N'] }
  ];

  function applyLabelRule(text, words, type, bump) {
    var labelSource = '\\b(?:' + words.join('|') + ')(?![A-Za-z0-9])';
    /* The (?!\s*\[REDACTED) guard keeps redaction idempotent: an already
     * redacted "VIN: [REDACTED:VIN]" must not match again. */
    var assigned = new RegExp('(' + labelSource + ')["\']?\\s*[:=]\\s*["\']?(?!\\s*\\[REDACTED)([^,;\\r\\n"\']{0,2000})', 'gi');
    text = text.replace(assigned, function (match, label, value) {
      if (!value || !value.trim()) return match;
      bump(type);
      return label + ': [REDACTED:' + type + ']';
    });
    var adjacent = new RegExp('(' + labelSource + ')[\\s#]+([A-Z0-9][A-Z0-9.\\-]{1,19})', 'gi');
    text = text.replace(adjacent, function (match, label, token) {
      if (!/[0-9]/.test(token)) return match;
      bump(type);
      return label + ': [REDACTED:' + type + ']';
    });
    return text;
  }

  /*
   * Redacts labelled identifiers (VIN, chassis, license plate, registration,
   * serial) and VIN-like 17-character strings. Returns the redacted text,
   * the replacement count, and a per-type breakdown. Best effort: patterns
   * that do not match a known shape are not recognized, which is why the UI
   * asks the user to review before sharing anything.
   */
  function redactText(input) {
    var byType = {};
    var total = 0;
    var bump = function (type) {
      byType[type] = (byType[type] || 0) + 1;
      total += 1;
    };
    var text = input == null ? '' : String(input);
    for (var i = 0; i < IDENTIFIER_LABELS.length; i++) {
      text = applyLabelRule(text, IDENTIFIER_LABELS[i].words, IDENTIFIER_LABELS[i].type, bump);
    }
    text = text.replace(/\b[A-HJ-NPR-Z0-9]{17}\b/gi, function (token) {
      if (!/[0-9]/.test(token) || !/[A-HJ-NPR-Z]/i.test(token)) return token;
      bump('VIN');
      return '[REDACTED:VIN]';
    });
    return { text: text, count: total, byType: byType };
  }

  /* ------------------------------------------------------------------ */
  /* Fault normalisation                                                 */
  /* ------------------------------------------------------------------ */

  var CODE_PATTERN = /^[A-Z0-9][A-Z0-9 .\-\/]{0,29}$/;

  function normalizeCode(code) {
    var value = String(code).trim().toUpperCase();
    if (!value) fail('E_SCHEMA', 'Fault codes cannot be empty.');
    if (value.length > LIMITS.MAX_CODE || !CODE_PATTERN.test(value)) {
      fail('E_SCHEMA', 'Fault code "' + value.slice(0, 40) + '" uses unsupported characters or is too long.');
    }
    return value;
  }

  function normalizeModule(module) {
    if (module == null || module === '') return 'Unassigned';
    if (typeof module !== 'string') fail('E_SCHEMA', 'Fault module must be text.');
    var value = module.replace(/\s+/g, ' ').trim();
    return value || 'Unassigned';
  }

  function normalizeFault(raw, redactions) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('E_SCHEMA', 'Each fault entry must be an object.');
    if (typeof raw.code !== 'string') fail('E_SCHEMA', 'Each fault entry needs a string code.');
    var codeRedaction = redactText(raw.code);
    if (codeRedaction.text !== raw.code) fail('E_SCHEMA', 'A fault code looked like an identifier and was rejected.');
    var code = normalizeCode(raw.code);
    var module = normalizeModule(raw.module);
    var descriptionInput = raw.description == null ? '' : raw.description;
    if (typeof descriptionInput !== 'string') fail('E_SCHEMA', 'Fault description must be text.');
    var redactedDescription = redactText(descriptionInput);
    addRedactions(redactions, redactedDescription);
    var description = redactedDescription.text.trim();
    if (description.length > LIMITS.MAX_DESCRIPTION) {
      fail('E_LIMIT', 'Fault description is too long (max ' + LIMITS.MAX_DESCRIPTION + ' characters).');
    }
    var occurrences = raw.occurrences == null ? 1 : raw.occurrences;
    if (!Number.isInteger(occurrences) || occurrences < 1 || occurrences > 100000) {
      fail('E_TYPE', 'Fault occurrences must be a positive integer.');
    }
    var moduleRedaction = redactText(module);
    addRedactions(redactions, moduleRedaction);
    if (moduleRedaction.text.length > LIMITS.MAX_MODULE) {
      fail('E_LIMIT', 'Fault module is too long (max ' + LIMITS.MAX_MODULE + ' characters).');
    }
    return { module: moduleRedaction.text, code: code, description: description, occurrences: occurrences };
  }

  function dedupeFaults(list) {
    var map = new Map();
    (list || []).forEach(function (fault) {
      var key = String(fault.module || 'Unassigned').toUpperCase() + '|' + String(fault.code).toUpperCase();
      var existing = map.get(key);
      if (existing) {
        existing.occurrences = (existing.occurrences || 1) + (fault.occurrences || 1);
        return;
      }
      map.set(key, {
        module: fault.module || 'Unassigned',
        code: fault.code,
        description: fault.description || '',
        occurrences: fault.occurrences || 1
      });
    });
    return Array.from(map.values());
  }

  /* ------------------------------------------------------------------ */
  /* Text parsing (VCDS-style shape, adapted from the starter)           */
  /* ------------------------------------------------------------------ */

  function faultsFromText(clean, redactions) {
    var extracted = [];
    var module = 'Unassigned';
    var lines = String(clean).split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var header = line.match(/^\s*Address\s+([0-9A-F]{2})\s*:\s*([^\r\n]*)$/i);
      if (header) {
        module = (header[1].toUpperCase() + ' ' + header[2].trim()).trim();
        continue;
      }
      var bracket = line.match(/^\s*\[([^\[\]]{1,60})\]\s*$/);
      if (bracket) {
        module = bracket[1].trim();
        continue;
      }
      var numeric = line.match(/^\s*(\d{4,7})\s+-\s+(.+?)\s*$/);
      if (numeric) {
        extracted.push({ module: module, code: numeric[1], description: numeric[2] });
        continue;
      }
      var dtc = line.match(/(?:^|\s)([PBCU][0-3][0-9A-F]{3})(?=\s|$|[-:,.])/i);
      if (dtc) {
        var index = line.indexOf(dtc[1]);
        var description = line.slice(index + dtc[1].length).replace(/^[\s:.,-]+/, '').trim();
        extracted.push({ module: module, code: dtc[1], description: description });
      }
    }
    var normalized = extracted.map(function (raw) {
      return normalizeFault(raw, redactions);
    });
    return dedupeFaults(normalized);
  }

  /* ------------------------------------------------------------------ */
  /* JSON parsing                                                        */
  /* ------------------------------------------------------------------ */

  var IDENTIFIER_KEY_PATTERN = /^(?:vin|chassis|chassis_?no|chassis_?number|licen[cs]e_?plate|plate|registration|registration_?no|registration_?number|reg_?no|serial|serial_?no|serial_?number|s_?n|engine_?number)$/i;
  var META_KEYS = new Set(['title', 'vehicle', 'notes', 'tags']);

  function faultListFromJson(parsed, redactions, warnings) {
    var rows;
    var meta = {};
    if (Array.isArray(parsed)) {
      rows = parsed;
    } else if (parsed && typeof parsed === 'object') {
      if (!Array.isArray(parsed.faults)) {
        fail('E_SCHEMA', 'JSON must be an array of faults or an object with a faults array.');
      }
      rows = parsed.faults;
      if (parsed.title != null) meta.title = sanitizeText(parsed.title, 'Imported title', LIMITS.MAX_TITLE, redactions);
      if (parsed.vehicle != null) meta.vehicle = sanitizeText(parsed.vehicle, 'Imported vehicle nickname', LIMITS.MAX_VEHICLE, redactions);
      if (parsed.notes != null) meta.notes = sanitizeText(parsed.notes, 'Imported notes', LIMITS.MAX_NOTES, redactions);
      if (parsed.tags != null) meta.tags = normalizeTags(parsed.tags, redactions);
      var unknown = [];
      Object.keys(parsed).forEach(function (key) {
        if (key === 'faults' || META_KEYS.has(key)) return;
        if (IDENTIFIER_KEY_PATTERN.test(key)) {
          redactions.count += 1;
          redactions.byType.FIELD = (redactions.byType.FIELD || 0) + 1;
          return;
        }
        unknown.push(key);
      });
      if (unknown.length) {
        warnings.push('Ignored ' + unknown.length + ' unrecognized field(s) from the JSON import: ' + unknown.slice(0, 5).join(', ') + '.');
      }
    } else {
      fail('E_SCHEMA', 'JSON must be an array of faults or an object with a faults array.');
    }
    if (rows.length > LIMITS.MAX_JSON_ROWS) {
      fail('E_LIMIT', 'JSON fault list is too large (over ' + LIMITS.MAX_JSON_ROWS + ' rows).');
    }
    var normalized = rows.map(function (row) {
      return normalizeFault(row, redactions);
    });
    var faults = dedupeFaults(normalized);
    if (faults.length > LIMITS.MAX_FAULTS_PER_SESSION) {
      fail('E_LIMIT', 'Fault list has more than ' + LIMITS.MAX_FAULTS_PER_SESSION + ' entries; trim the scan before saving.');
    }
    return { faults: faults, meta: meta };
  }

  function makePreview(text) {
    var limit = 2000;
    if (text.length <= limit) return text;
    return text.slice(0, limit) + '\n\u2026 (preview truncated)';
  }

  /* Bracket-style module headers ("[Brakes]") start with "[", so an input
   * that begins like JSON but does not parse is re-checked for common scan
   * shapes before being rejected outright. */
  function looksLikeScanText(text) {
    if (/^\s*Address\s+[0-9A-F]{2}\s*:/im.test(text)) return true;
    if (/^\s*\[[^\[\]]{1,60}\]\s*$/m.test(text)) return true;
    if (/^\s*\d{4,7}\s+-\s+.+$/m.test(text)) return true;
    if (/(?:^|\s)[PBCU][0-3][0-9A-F]{3}(?=\s|$|[-:,.])/im.test(text)) return true;
    return false;
  }

  /*
   * Parses pasted text or JSON into redacted fault entries plus optional
   * redacted metadata (title / vehicle / notes / tags from JSON objects).
   * Text input is redacted before it is parsed further; JSON input is
   * parsed structurally and every stored string field passes through
   * redaction, so raw input never reaches storage.
   */
  function parseScan(text) {
    if (typeof text !== 'string') fail('E_TYPE', 'Scan input must be text.');
    if (byteLength(text) > LIMITS.MAX_IMPORT_BYTES) fail('E_SIZE', 'Scan input exceeds the 5 MB import limit.');
    var trimmed = text.replace(/^\uFEFF/, '').trim();
    var source = 'text';
    var faults = [];
    var meta = {};
    var warnings = [];
    var redactions = { count: 0, byType: {} };
    var redactedPreview;
    if (trimmed.charAt(0) === '[' || trimmed.charAt(0) === '{') {
      var parsed;
      var parseError = null;
      try {
        parsed = JSON.parse(trimmed);
      } catch (error) {
        parseError = error;
      }
      if (!parseError) {
        source = 'json';
        var result = faultListFromJson(parsed, redactions, warnings);
        faults = result.faults;
        meta = result.meta;
        redactedPreview = makePreview(JSON.stringify({ meta: meta, faults: faults.slice(0, 10) }, null, 2));
      } else if (looksLikeScanText(trimmed)) {
        var cleanedFallback = redactText(trimmed);
        addRedactions(redactions, cleanedFallback);
        faults = faultsFromText(cleanedFallback.text, redactions);
        redactedPreview = makePreview(cleanedFallback.text);
      } else {
        fail('E_FORMAT', 'Could not parse JSON: ' + parseError.message);
      }
    } else {
      var cleaned = redactText(trimmed);
      addRedactions(redactions, cleaned);
      faults = faultsFromText(cleaned.text, redactions);
      redactedPreview = makePreview(cleaned.text);
    }
    if (faults.length > LIMITS.MAX_FAULTS_PER_SESSION) {
      fail('E_LIMIT', 'Fault list has more than ' + LIMITS.MAX_FAULTS_PER_SESSION + ' entries; trim the scan before saving.');
    }
    if (faults.length === 0) {
      warnings.push('No fault entries were recognized. The format may be unsupported; verify the source before relying on an empty list.');
    }
    return {
      faults: faults,
      source: source,
      meta: meta,
      redactions: redactions,
      warnings: warnings,
      redactedPreview: redactedPreview
    };
  }

  /* ------------------------------------------------------------------ */
  /* Sessions                                                            */
  /* ------------------------------------------------------------------ */

  function sanitizeText(value, label, max, redactions, defaultValue) {
    if (value == null || value === '') return defaultValue != null ? defaultValue : '';
    if (typeof value !== 'string') fail('E_TYPE', label + ' must be text.');
    var redacted = redactText(value);
    addRedactions(redactions, redacted);
    var output = redacted.text.trim();
    if (!output && defaultValue != null) output = defaultValue;
    if (output.length > max) fail('E_LIMIT', label + ' is too long (max ' + max + ' characters).');
    return output;
  }

  function normalizeTags(input, redactions) {
    if (input == null) return [];
    if (!Array.isArray(input)) fail('E_TYPE', 'Tags must be an array of short labels.');
    if (input.length > LIMITS.MAX_TAGS) fail('E_LIMIT', 'Too many tags (max ' + LIMITS.MAX_TAGS + ').');
    var output = [];
    var seen = new Set();
    for (var i = 0; i < input.length; i++) {
      var tag = input[i];
      if (typeof tag !== 'string') fail('E_TYPE', 'Each tag must be text.');
      var redacted = redactText(tag);
      addRedactions(redactions, redacted);
      var value = redacted.text.replace(/\s+/g, ' ').trim();
      if (!value) continue;
      if (value.length > LIMITS.MAX_TAG) fail('E_LIMIT', 'Tag "' + value.slice(0, 40) + '" is too long (max ' + LIMITS.MAX_TAG + ' characters).');
      var key = value.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        output.push(value);
      }
    }
    return output;
  }

  function normalizeFaultList(input, redactions) {
    if (input == null) return [];
    if (!Array.isArray(input)) fail('E_TYPE', 'Faults must be an array of entries.');
    if (input.length > LIMITS.MAX_FAULTS_PER_SESSION) {
      fail('E_LIMIT', 'Too many fault entries (max ' + LIMITS.MAX_FAULTS_PER_SESSION + ' per session).');
    }
    var list = [];
    for (var i = 0; i < input.length; i++) list.push(normalizeFault(input[i], redactions));
    return dedupeFaults(list);
  }

  function normalizeSession(input, nowIso, id) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('E_SCHEMA', 'Session data must be an object.');
    if (typeof input.date !== 'string') fail('E_TYPE', 'Session date must be text in YYYY-MM-DD form.');
    if (!isValidDateString(input.date)) {
      fail('E_DATE', 'Session date must be a real calendar date between ' + LIMITS.MIN_DATE + ' and ' + LIMITS.MAX_DATE + ' in YYYY-MM-DD form.');
    }
    var redactions = { count: 0, byType: {} };
    var title = sanitizeText(input.title, 'Session title', LIMITS.MAX_TITLE, redactions, 'Session ' + input.date);
    var vehicle = sanitizeText(input.vehicle, 'Vehicle nickname', LIMITS.MAX_VEHICLE, redactions);
    var notes = sanitizeText(input.notes, 'Session notes', LIMITS.MAX_NOTES, redactions);
    var tags = normalizeTags(input.tags, redactions);
    var faults = normalizeFaultList(input.faults, redactions);
    return {
      id: id,
      date: input.date,
      title: title,
      vehicle: vehicle,
      tags: tags,
      notes: notes,
      faults: faults,
      redactions: redactions,
      createdAt: nowIso,
      updatedAt: nowIso
    };
  }

  function createSession(input, opts) {
    opts = opts || {};
    var nowIso = toIso(opts.now);
    var id = opts.id ? String(opts.id) : generateId();
    return normalizeSession(input || {}, nowIso, id);
  }

  function updateSession(session, patch, opts) {
    if (!session || typeof session !== 'object' || Array.isArray(session)) {
      fail('E_SCHEMA', 'An existing session is required for an update.');
    }
    patch = patch || {};
    var merged = {
      date: patch.date !== undefined ? patch.date : session.date,
      title: patch.title !== undefined ? patch.title : session.title,
      vehicle: patch.vehicle !== undefined ? patch.vehicle : session.vehicle,
      tags: patch.tags !== undefined ? patch.tags : session.tags,
      notes: patch.notes !== undefined ? patch.notes : session.notes,
      faults: patch.faults !== undefined ? patch.faults : session.faults
    };
    var nowIso = toIso(opts && opts.now);
    var id = typeof session.id === 'string' && session.id.trim() ? session.id.trim() : generateId();
    var next = normalizeSession(merged, nowIso, id);
    if (typeof session.createdAt === 'string') next.createdAt = session.createdAt;
    return next;
  }

  function sanitizeRedactions(raw, fallback) {
    try {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fallback;
      if (!Number.isInteger(raw.count) || raw.count < 0 || raw.count > 1000000) return fallback;
      var byType = {};
      var source = raw.byType && typeof raw.byType === 'object' && !Array.isArray(raw.byType) ? raw.byType : {};
      Object.keys(source).forEach(function (key) {
        var value = source[key];
        if (REDACTION_TYPE_PATTERN.test(key) && Number.isInteger(value) && value >= 0 && value <= 1000000) {
          byType[key] = value;
        }
      });
      return { count: raw.count, byType: byType };
    } catch (error) {
      return fallback;
    }
  }

  /*
   * Validates a session record (from storage or a backup import) and
   * re-applies redaction to every stored text field, so even a
   * hand-edited backup cannot re-introduce raw identifiers.
   */
  function validateSession(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('E_SCHEMA', 'Session record must be an object.');
    var id = typeof raw.id === 'string' ? raw.id.trim() : '';
    /* Hostile or malformed ids (markup, prototype-member names, oversized
     * values) never survive validation: the record is kept, the id is
     * regenerated, so it cannot leak into storage or re-exported backups. */
    if (!SESSION_ID_PATTERN.test(id)) id = generateId();
    if (typeof raw.createdAt !== 'string' || isNaN(Date.parse(raw.createdAt))) {
      fail('E_SCHEMA', 'Session createdAt must be an ISO date string.');
    }
    if (typeof raw.updatedAt !== 'string' || isNaN(Date.parse(raw.updatedAt))) {
      fail('E_SCHEMA', 'Session updatedAt must be an ISO date string.');
    }
    var session = normalizeSession(raw, raw.updatedAt, id);
    session.createdAt = raw.createdAt;
    session.redactions = sanitizeRedactions(raw.redactions, session.redactions);
    return session;
  }

  /* ------------------------------------------------------------------ */
  /* Store: validation, serialization, versioned storage                 */
  /* ------------------------------------------------------------------ */

  function emptyStore() {
    return { version: SCHEMA_VERSION, sessions: [] };
  }

  function serializeStore(store, options) {
    var pretty = options && options.pretty;
    return JSON.stringify(store, null, pretty ? 2 : undefined);
  }

  /* Strict all-or-nothing validation, used for backup imports. */
  function validateStore(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('E_SCHEMA', 'Notebook data must be an object.');
    if (raw.version !== SCHEMA_VERSION) fail('E_VERSION', 'Unsupported notebook data version (expected ' + SCHEMA_VERSION + ').');
    if (!Array.isArray(raw.sessions)) fail('E_SCHEMA', 'Notebook data needs a sessions array.');
    if (raw.sessions.length > LIMITS.MAX_SESSIONS) {
      fail('E_LIMIT', 'Notebook holds more than ' + LIMITS.MAX_SESSIONS + ' sessions.');
    }
    var sessions = [];
    var seenIds = new Set();
    for (var i = 0; i < raw.sessions.length; i++) {
      var session;
      try {
        session = validateSession(raw.sessions[i]);
      } catch (error) {
        if (error instanceof NotebookError) fail(error.code, 'Session ' + (i + 1) + ': ' + error.message);
        throw error;
      }
      if (seenIds.has(session.id)) fail('E_SCHEMA', 'Duplicate session id "' + session.id + '".');
      seenIds.add(session.id);
      sessions.push(session);
    }
    return { version: SCHEMA_VERSION, sessions: sessions };
  }

  function createMemoryStorage() {
    var map = new Map();
    return {
      getItem: function (key) {
        return map.has(String(key)) ? map.get(String(key)) : null;
      },
      setItem: function (key, value) {
        map.set(String(key), String(value));
      },
      removeItem: function (key) {
        map.delete(String(key));
      }
    };
  }

  /*
   * Loads the versioned store. Never throws and never writes: reports
   * blocked storage, corrupt data or a mismatched version instead, so the
   * UI can show a visible fallback and avoid destroying anything.
   */
  function loadStoreFrom(storage) {
    var rawText;
    try {
      rawText = storage.getItem(STORAGE_KEY);
    } catch (error) {
      return {
        status: 'unavailable',
        store: emptyStore(),
        warnings: ['Browser storage is not available; the notebook is running in memory-only mode and changes will not persist.'],
        protected: false,
        skippedCount: 0
      };
    }
    if (rawText == null || rawText === '') {
      return { status: 'empty', store: emptyStore(), warnings: [], protected: false, skippedCount: 0 };
    }
    if (byteLength(rawText) > LIMITS.MAX_TOTAL_BYTES) {
      return {
        status: 'corrupt',
        store: emptyStore(),
        warnings: ['Stored notebook data exceeds the 5 MB limit and was not loaded, to avoid destroying it. Use Reset local data or import a backup.'],
        protected: true,
        skippedCount: 0
      };
    }
    var parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (error) {
      return {
        status: 'corrupt',
        store: emptyStore(),
        warnings: ['Stored notebook data could not be read (invalid JSON) and was not loaded, to avoid overwriting it. Use Reset local data or import a backup.'],
        protected: true,
        skippedCount: 0
      };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.sessions)) {
      return {
        status: 'corrupt',
        store: emptyStore(),
        warnings: ['Stored notebook data has an unexpected shape and was not loaded. Use Reset local data or import a backup.'],
        protected: true,
        skippedCount: 0
      };
    }
    if (parsed.version !== SCHEMA_VERSION) {
      return {
        status: 'version',
        store: emptyStore(),
        warnings: ['Stored notebook data was written by a different version (found ' + String(parsed.version) + ', expected ' + SCHEMA_VERSION + ') and was not loaded, to avoid data loss.'],
        protected: true,
        skippedCount: 0
      };
    }
    if (parsed.sessions.length > LIMITS.MAX_SESSIONS) {
      return {
        status: 'corrupt',
        store: emptyStore(),
        warnings: ['Stored notebook holds more than ' + LIMITS.MAX_SESSIONS + ' sessions and was not loaded.'],
        protected: true,
        skippedCount: 0
      };
    }
    var sessions = [];
    var warnings = [];
    var skipped = 0;
    var seenIds = new Set();
    parsed.sessions.forEach(function (rawSession, index) {
      try {
        var session = validateSession(rawSession);
        if (seenIds.has(session.id)) {
          var originalId = session.id;
          do { session.id = generateId(); } while (seenIds.has(session.id));
          warnings.push('Duplicate session id "' + originalId + '" was found while loading; record ' + (index + 1) + ' was kept with a new internal id.');
        }
        seenIds.add(session.id);
        sessions.push(session);
      } catch (error) {
        skipped += 1;
        warnings.push('Skipped unreadable session record ' + (index + 1) + ': ' + (error && error.message ? error.message : String(error)));
      }
    });
    return {
      status: 'ok',
      store: { version: SCHEMA_VERSION, sessions: sessions },
      warnings: warnings,
      protected: false,
      skippedCount: skipped
    };
  }

  /* Serializes, size-checks and writes. Never throws; callers keep an
   * in-memory fallback visible when the write fails (quota or blocked). */
  function saveStoreTo(storage, store) {
    var text;
    try {
      text = serializeStore(store);
    } catch (error) {
      return { ok: false, code: 'E_SCHEMA', message: 'Notebook data could not be serialized.' };
    }
    var bytes = byteLength(text);
    if (bytes > LIMITS.MAX_TOTAL_BYTES) {
      return { ok: false, code: 'E_SIZE', message: 'Notebook exceeds the 5 MB local storage limit.', bytes: bytes };
    }
    try {
      storage.setItem(STORAGE_KEY, text);
      return { ok: true, bytes: bytes };
    } catch (error) {
      var quota = error && (error.name === 'QuotaExceededError' || /quota/i.test(String(error.name) + ' ' + String(error.message)));
      return {
        ok: false,
        code: quota ? 'E_QUOTA' : 'E_BLOCKED',
        message: quota ? 'Browser storage is full; the change was kept in memory only.' : 'Browser storage refused the write; the change was kept in memory only.',
        bytes: bytes
      };
    }
  }

  /*
   * Transactional backup import: validate and redact the whole document
   * first; only then write it. Any failure leaves existing stored data
   * exactly as it was.
   */
  function importBackupText(storage, text) {
    if (typeof text !== 'string') return { ok: false, code: 'E_TYPE', message: 'Backup import must be text.' };
    var parsed;
    try {
      parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch (error) {
      return { ok: false, code: 'E_FORMAT', message: 'Backup file is not valid JSON.' };
    }
    var store;
    try {
      store = validateStore(parsed);
    } catch (error) {
      if (error instanceof NotebookError) return { ok: false, code: error.code, message: error.message };
      throw error;
    }
    var saved = saveStoreTo(storage, store);
    if (!saved.ok) {
      return { ok: false, code: saved.code, message: saved.message + ' The import was validated but not applied; existing data was preserved.' };
    }
    return { ok: true, store: store, bytes: saved.bytes };
  }

  /* ------------------------------------------------------------------ */
  /* Comparison                                                          */
  /* ------------------------------------------------------------------ */

  function compareEntries(a, b) {
    var keyA = (a.module + '|' + a.code).toUpperCase();
    var keyB = (b.module + '|' + b.code).toUpperCase();
    if (keyA < keyB) return -1;
    if (keyA > keyB) return 1;
    return 0;
  }

  function comparisonEntry(fault, occurrencesBefore, occurrencesAfter) {
    return {
      module: fault.module || 'Unassigned',
      code: fault.code,
      description: fault.description || '',
      occurrencesBefore: occurrencesBefore,
      occurrencesAfter: occurrencesAfter
    };
  }

  /*
   * Groups faults the same way the starter did: keyed by module|code.
   * "Absent" describes the comparison of the two provided lists only; it
   * is not evidence that a fault was repaired.
   */
  function compareFaults(before, after) {
    if (!Array.isArray(before) || !Array.isArray(after)) fail('E_TYPE', 'Fault lists must be arrays.');
    var keyOf = function (fault) {
      return String(fault.module || 'Unassigned').toUpperCase() + '|' + String(fault.code).toUpperCase();
    };
    var beforeMap = new Map();
    var afterMap = new Map();
    before.forEach(function (fault) { if (!beforeMap.has(keyOf(fault))) beforeMap.set(keyOf(fault), fault); });
    after.forEach(function (fault) { if (!afterMap.has(keyOf(fault))) afterMap.set(keyOf(fault), fault); });

    var result = { new: [], absent: [], persisting: [], warnings: [] };
    afterMap.forEach(function (fault) {
      if (!beforeMap.has(keyOf(fault))) result.new.push(comparisonEntry(fault, 0, fault.occurrences || 1));
    });
    beforeMap.forEach(function (fault) {
      if (!afterMap.has(keyOf(fault))) result.absent.push(comparisonEntry(fault, fault.occurrences || 1, 0));
    });
    afterMap.forEach(function (fault) {
      if (beforeMap.has(keyOf(fault))) {
        result.persisting.push(comparisonEntry(fault, beforeMap.get(keyOf(fault)).occurrences || 1, fault.occurrences || 1));
      }
    });
    result.new.sort(compareEntries);
    result.absent.sort(compareEntries);
    result.persisting.sort(compareEntries);

    if (!before.length) {
      result.warnings.push('The before scan lists zero faults; an empty list may mean the format was not recognized or the scan genuinely listed none.');
    }
    if (!after.length) {
      result.warnings.push('The after scan lists zero faults; an empty list may mean the format was not recognized or the scan genuinely listed none.');
    }
    return result;
  }

  /* ------------------------------------------------------------------ */
  /* Reports and exports (plain text and JSON, ready for Blob download)  */
  /* ------------------------------------------------------------------ */

  function pushSessionLines(lines, session) {
    lines.push('  Session date: ' + session.date);
    lines.push('  Title: ' + session.title);
    if (session.vehicle) lines.push('  Vehicle nickname: ' + session.vehicle);
    if (session.tags && session.tags.length) lines.push('  Tags: ' + session.tags.join(', '));
    lines.push('  Fault entries: ' + session.faults.length);
    if (session.notes) {
      lines.push('  Notes:');
      session.notes.split(/\r?\n/).forEach(function (noteLine) {
        lines.push('    ' + noteLine);
      });
    } else {
      lines.push('  Notes: (none)');
    }
  }

  function pushEntryLines(lines, entries, marker) {
    if (!entries.length) {
      lines.push('  (none)');
      return;
    }
    entries.forEach(function (entry) {
      lines.push('  ' + marker + ' ' + entry.module + ' | ' + entry.code + ' | ' + (entry.description || '(no description)') + ' (before x' + entry.occurrencesBefore + ' / after x' + entry.occurrencesAfter + ')');
    });
  }

  function isReversedDateOrder(before, after) {
    return !!(before && after && typeof before.date === 'string' && typeof after.date === 'string' && before.date > after.date);
  }

  function buildReportText(options) {
    var before = options.before;
    var after = options.after;
    var comparison = options.comparison;
    var generatedAt = options.generatedAt || new Date().toISOString();
    var reversedOrder = isReversedDateOrder(before, after);
    var lines = [];
    lines.push('DIAGNOSTIC SESSION NOTEBOOK - SERVICE COMPARISON REPORT');
    lines.push('Generated: ' + generatedAt);
    lines.push('Application: Diagnostic Session Notebook v' + SCHEMA_VERSION + ' - offline tool, no network requests');
    lines.push('');
    lines.push('REDACTION NOTICE: Every stored field passed through best-effort redaction at save time. Review this report before sharing it; identifiers the redactor did not recognize may remain.');
    lines.push('');
    if (reversedOrder) {
      lines.push('NOTE: The session selected as "before" is dated ' + before.date + ', which is later than the session selected as "after" (' + after.date + '). The comparison direction does not follow chronological order; verify the selection.');
      lines.push('');
    }
    lines.push('BEFORE (' + (reversedOrder ? 'selected first - dated later' : 'earlier scan') + ')');
    pushSessionLines(lines, before);
    lines.push('');
    lines.push('AFTER (' + (reversedOrder ? 'selected second - dated earlier' : 'later scan') + ')');
    pushSessionLines(lines, after);
    lines.push('');
    lines.push('DIFF SUMMARY');
    lines.push('  New in after scan: ' + comparison.new.length);
    lines.push('  Absent from after scan (present before): ' + comparison.absent.length);
    lines.push('  Persisting in both: ' + comparison.persisting.length);
    lines.push('  Evidence key: module | code | description (before xN / after xN)');
    lines.push('');
    lines.push('NEW IN AFTER SCAN');
    pushEntryLines(lines, comparison.new, '[NEW]');
    lines.push('');
    lines.push('ABSENT FROM AFTER SCAN');
    pushEntryLines(lines, comparison.absent, '[ABSENT]');
    lines.push('');
    lines.push('PERSISTING IN BOTH');
    pushEntryLines(lines, comparison.persisting, '[PERSISTING]');
    lines.push('');
    lines.push('WARNINGS');
    if (comparison.warnings.length) {
      comparison.warnings.forEach(function (warning) {
        lines.push('  - ' + warning);
      });
    } else {
      lines.push('  (none)');
    }
    lines.push('');
    lines.push('LIMITATIONS AND INTERPRETATION');
    LIMITATIONS.forEach(function (limitation) {
      lines.push('  - ' + limitation);
    });
    lines.push('');
    lines.push('End of report. Codes are listed exactly as parsed from the provided scan text; they are not validated against a manufacturer database.');
    return lines.join('\n');
  }

  function sessionSummary(session) {
    return {
      id: session.id,
      date: session.date,
      title: session.title,
      vehicle: session.vehicle,
      tags: session.tags.slice(),
      notes: session.notes,
      faultCount: session.faults.length,
      faults: session.faults
    };
  }

  function buildComparisonJson(options) {
    var payload = {
      app: 'Diagnostic Session Notebook',
      version: SCHEMA_VERSION,
      generatedAt: options.generatedAt || new Date().toISOString(),
      before: sessionSummary(options.before),
      after: sessionSummary(options.after),
      diff: {
        new: options.comparison.new,
        absent: options.comparison.absent,
        persisting: options.comparison.persisting
      },
      warnings: options.comparison.warnings,
      limitations: LIMITATIONS.slice()
    };
    return JSON.stringify(payload, null, 2);
  }

  function buildBackupJson(store, options) {
    options = options || {};
    return JSON.stringify({
      app: 'Diagnostic Session Notebook',
      version: SCHEMA_VERSION,
      generatedAt: options.generatedAt || new Date().toISOString(),
      sessions: (store && store.sessions) || []
    }, null, 2);
  }

  function exportFilenames(generatedAtIso) {
    var datePart = String(generatedAtIso || '').slice(0, 10).replace(/[^0-9-]/g, '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) datePart = new Date().toISOString().slice(0, 10);
    return {
      report: 'diagnostic-notebook-comparison-' + datePart + '.txt',
      comparisonJson: 'diagnostic-notebook-comparison-' + datePart + '.json',
      backup: 'diagnostic-notebook-backup-' + datePart + '.json'
    };
  }

  /* ------------------------------------------------------------------ */
  /* Fictional sample data                                               */
  /* ------------------------------------------------------------------ */

  function sampleData() {
    return {
      before: {
        date: '2026-09-14',
        title: 'Pre-service scan (fictional)',
        vehicle: 'Blue Comet (fictional hatch)',
        tags: ['engine', 'pre-service', 'fictional'],
        notes: 'Fictional example. Owner reported an intermittent rough idle; no identifiers are stored in this notebook.',
        faults: [
          { module: '01 Engine', code: '000123', description: 'Example sensor circuit fault (fictional)' },
          { module: '01 Engine', code: 'P0101', description: 'Example mass air flow range fault (fictional)' },
          { module: '03 ABS', code: '01234', description: 'Example brake controller fault (fictional)' }
        ]
      },
      after: {
        date: '2026-10-05',
        title: 'Post-service scan (fictional)',
        vehicle: 'Blue Comet (fictional hatch)',
        tags: ['engine', 'post-service', 'fictional'],
        notes: 'Fictional example. Rescan after fictional service work. Verify findings before relying on them; absence of a code does not prove a repair.',
        faults: [
          { module: '01 Engine', code: '000123', description: 'Example sensor circuit fault (fictional)' },
          { module: '01 Engine', code: 'P0300', description: 'Example random misfire fault (fictional)' }
        ]
      }
    };
  }

  return {
    SCHEMA_VERSION: SCHEMA_VERSION,
    STORAGE_KEY: STORAGE_KEY,
    LIMITS: LIMITS,
    LIMITATIONS: LIMITATIONS,
    NotebookError: NotebookError,
    redactText: redactText,
    parseScan: parseScan,
    compareFaults: compareFaults,
    isReversedDateOrder: isReversedDateOrder,
    createSession: createSession,
    updateSession: updateSession,
    validateSession: validateSession,
    emptyStore: emptyStore,
    validateStore: validateStore,
    serializeStore: serializeStore,
    loadStoreFrom: loadStoreFrom,
    saveStoreTo: saveStoreTo,
    importBackupText: importBackupText,
    buildReportText: buildReportText,
    buildComparisonJson: buildComparisonJson,
    buildBackupJson: buildBackupJson,
    exportFilenames: exportFilenames,
    sampleData: sampleData,
    createMemoryStorage: createMemoryStorage,
    dedupeFaults: dedupeFaults,
    isValidDateString: isValidDateString,
    byteLength: byteLength
  };
});
