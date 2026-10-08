'use strict';
/*
 * Unit tests for the Diagnostic Session Notebook core logic (core.js).
 * No DOM, no network, no runtime dependencies.
 *
 * Run all tests:   node tests/core.test.cjs
 * Or via runner:   node --test tests/
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const N = require('../core.js');
const ROOT = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(ROOT, name), 'utf8');

/* Fictional identifiers used in fixtures. None of these may ever survive
 * redaction, comparison, reporting, exporting, or storage. */
const RAW_IDS = [
  'WVWZZZ1KZ6W000001', 'WVWZZZ1KZ6W000002', 'WVWZZZ1KZ6W000003',
  'WVWZZZ1KZ6W000004', 'WVWZZZ1KZ6W000005', 'WVWZZZ1KZ6W000006',
  'WVWZZZ1KZ6W000007', 'WVWZZZ1KZ6W000009',
  'AB-123-CD', 'XY-777-ZZ', 'REG-99887', 'SN-55-001', 'SER-000123', 'ZZ-99-ZZ'
];

function assertNoRawIdentifiers(value, label) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const id of RAW_IDS) {
    assert.ok(!text.includes(id), (label || 'value') + ' must not contain raw identifier ' + id);
  }
}

const DIRTY_TEXT = [
  'VCDS-style log (fictional)',
  'VIN: WVWZZZ1KZ6W000001',
  'Chassis Number: WVWZZZ1KZ6W000002',
  'License Plate: AB-123-CD',
  'Registration: REG-99887',
  'Serial No.: SN-55-001',
  'Address 01: Engine',
  '000123 - Example sensor fault (fictional)',
  'P0101 - Example lean code (fictional)',
  'P0101 - Duplicate line (fictional)',
  'some notes mention VIN WVWZZZ1KZ6W000003 here'
].join('\n');

const DIRTY_JSON = JSON.stringify({
  vin: 'WVWZZZ1KZ6W000004',
  licensePlate: 'XY-777-ZZ',
  serialNumber: 'SER-000123',
  title: 'After service scan',
  vehicle: 'WVWZZZ1KZ6W000005 hatch',
  notes: 'Glovebox log mentions VIN WVWZZZ1KZ6W000006.',
  tags: ['engine', 'fictional'],
  mystery: 'not kept',
  faults: [
    { module: '01 Engine', code: 'p0300', description: 'Misfire reference WVWZZZ1KZ6W000007' },
    { module: '03 ABS', code: '01234', description: 'Brake controller (fictional)' }
  ]
});

/* ------------------------------------------------------------------ */
/* Redaction                                                           */
/* ------------------------------------------------------------------ */

test('redacts labeled identifiers and VIN-like strings', () => {
  const result = N.redactText(DIRTY_TEXT);
  assertNoRawIdentifiers(result.text, 'redacted text');
  assert.equal(result.count, 6);
  assert.deepEqual(result.byType, { VIN: 2, CHASSIS: 1, PLATE: 1, REGISTRATION: 1, SERIAL: 1 });
  assert.ok(result.text.includes('VIN: [REDACTED:VIN]'));
  assert.ok(result.text.includes('Chassis Number: [REDACTED:CHASSIS]'));
  assert.ok(result.text.includes('License Plate: [REDACTED:PLATE]'));
  assert.ok(result.text.includes('Registration: [REDACTED:REGISTRATION]'));
  assert.ok(result.text.includes('Serial No.: [REDACTED:SERIAL]'));
  assert.ok(result.text.includes('some notes mention VIN: [REDACTED:VIN] here'));
});

test('redaction is idempotent on already-redacted markers', () => {
  const once = N.redactText(DIRTY_TEXT);
  const twice = N.redactText(once.text);
  assert.equal(twice.count, 0);
  assert.equal(twice.text, once.text);
});

test('redacts underscore-style labels such as license_plate', () => {
  const result = N.redactText('license_plate: XY-777-ZZ');
  assert.equal(result.count, 1);
  assert.ok(!result.text.includes('XY-777-ZZ'));
  assert.ok(result.text.includes('[REDACTED:PLATE]'));
});

test('leaves ordinary repair text untouched and ignores all-digit runs', () => {
  const plain = 'Replaced air filter; cleared adaptations; road test ok.';
  const result = N.redactText(plain);
  assert.equal(result.count, 0);
  assert.equal(result.text, plain);

  const digits = N.redactText('Order 12345678901234567 was archived.');
  assert.equal(digits.count, 0);
  assert.ok(digits.text.includes('12345678901234567'));
});

/* ------------------------------------------------------------------ */
/* Scan parsing                                                        */
/* ------------------------------------------------------------------ */

test('parses VCDS-style text with deduplication and module attribution', () => {
  const res = N.parseScan(DIRTY_TEXT);
  assert.equal(res.source, 'text');
  assert.deepEqual(res.faults.map((f) => f.code), ['000123', 'P0101']);
  assert.equal(res.faults[0].module, '01 Engine');
  assert.equal(res.faults[1].module, '01 Engine');
  assert.equal(res.faults[1].occurrences, 2);
  assert.equal(res.faults[1].description, 'Example lean code (fictional)');
  assertNoRawIdentifiers(res, 'parse result');
  assertNoRawIdentifiers(res.redactedPreview, 'redacted preview');
  assert.ok(res.redactedPreview.includes('[REDACTED:VIN]'));
});

test('defaults the module to Unassigned before any module header', () => {
  const res = N.parseScan('P0101 - Example code (fictional)');
  assert.equal(res.faults.length, 1);
  assert.equal(res.faults[0].module, 'Unassigned');
});

test('supports bracket module headers and longer numeric codes', () => {
  const res = N.parseScan('[Brakes]\n16487 - Example pump fault (fictional)');
  assert.equal(res.faults.length, 1);
  assert.equal(res.faults[0].module, 'Brakes');
  assert.equal(res.faults[0].code, '16487');
});

test('does not treat timestamps as numeric fault codes', () => {
  const res = N.parseScan('2024-09-01 10:00 - log started\nAddress 01: Engine\nP0101 - Example code');
  assert.deepEqual(res.faults.map((f) => f.code), ['P0101']);
});

test('parses P/B/C/U codes case-insensitively', () => {
  const res = N.parseScan('[Body]\nb1234 - Example body code\n[CAN]\nu0100 - Example network code\n[Chassis]\nC0562 - Example chassis code');
  assert.deepEqual(res.faults.map((f) => f.code).sort(), ['B1234', 'C0562', 'U0100']);
});

test('parses JSON fault arrays and objects', () => {
  const arr = N.parseScan('[{"module":"01 Engine","code":"p0101","description":"Example"}]');
  assert.equal(arr.source, 'json');
  assert.equal(arr.faults[0].code, 'P0101');
  assert.equal(arr.faults[0].module, '01 Engine');

  const obj = N.parseScan(JSON.stringify({ faults: [{ code: 'P0300' }] }));
  assert.equal(obj.faults[0].module, 'Unassigned');
  assert.equal(obj.faults[0].description, '');
});

test('JSON import redacts raw fields and drops identifier keys before use', () => {
  const res = N.parseScan(DIRTY_JSON);
  assert.equal(res.source, 'json');
  assert.deepEqual(res.faults.map((f) => f.code), ['P0300', '01234']);
  assert.equal(res.meta.title, 'After service scan');
  assert.ok(res.meta.vehicle.includes('[REDACTED:VIN]'));
  assert.ok(res.meta.notes.includes('[REDACTED:VIN]'));
  assert.deepEqual(res.meta.tags, ['engine', 'fictional']);
  assert.equal(res.redactions.byType.FIELD, 3);
  assert.ok(res.warnings.some((w) => /Ignored 1 unrecognized field/.test(w) && w.includes('mystery')));
  assertNoRawIdentifiers(res, 'JSON parse result');
  assertNoRawIdentifiers(res.redactedPreview, 'JSON redacted preview');
  assert.ok(!JSON.stringify(res).includes('not kept'), 'unknown JSON fields must not be kept');
});

test('rejects malformed JSON scan imports with clear codes', () => {
  const expectCode = (fn, code) => {
    assert.throws(fn, (err) => err && err.code === code);
  };
  expectCode(() => N.parseScan('{bad json'), 'E_FORMAT');
  expectCode(() => N.parseScan(JSON.stringify([{ module: 'm', description: 'no code here' }])), 'E_SCHEMA');
  expectCode(() => N.parseScan(JSON.stringify([{ code: 123 }])), 'E_SCHEMA');
  expectCode(() => N.parseScan(JSON.stringify([{ code: 'P0$F' }])), 'E_SCHEMA');
  expectCode(() => N.parseScan(JSON.stringify([{ code: 'WVWZZZ1KZ6W000001' }])), 'E_SCHEMA');
  expectCode(() => N.parseScan(JSON.stringify({ hello: 'world' })), 'E_SCHEMA');
  expectCode(() => N.parseScan(12345), 'E_TYPE');
});

test('enforces import size, JSON row and fault count limits', () => {
  const expectCode = (fn, code) => {
    assert.throws(fn, (err) => err && err.code === code);
  };
  expectCode(() => N.parseScan('x'.repeat(5 * 1024 * 1024 + 1)), 'E_SIZE');

  const tooManyRows = JSON.stringify({
    faults: Array.from({ length: 5001 }, (_, i) => ({ code: 'P' + String(i).padStart(4, '0') }))
  });
  expectCode(() => N.parseScan(tooManyRows), 'E_LIMIT');

  const tooManyFaults = JSON.stringify({
    faults: Array.from({ length: 501 }, (_, i) => ({ code: 'P' + String(i).padStart(4, '0') }))
  });
  expectCode(() => N.parseScan(tooManyFaults), 'E_LIMIT');
});

test('warns when no fault entries are recognized', () => {
  const res = N.parseScan('hello world, nothing recognizable here');
  assert.equal(res.faults.length, 0);
  assert.ok(res.warnings.some((w) => w.includes('No fault entries were recognized')));
});

/* ------------------------------------------------------------------ */
/* Sessions                                                            */
/* ------------------------------------------------------------------ */

test('creates a validated, redacted session with defaults and metadata', () => {
  const s = N.createSession({
    date: '2026-10-08',
    title: '  Pre-service check  ',
    vehicle: 'Blue Comet',
    tags: ['engine', 'pre-service', 'Engine '],
    notes: 'Oil weep. VIN WVWZZZ1KZ6W000001 recorded.',
    faults: [{ module: '01 Engine', code: 'p0101', description: 'Leak near VIN WVWZZZ1KZ6W000002 sensor.' }]
  }, { id: 's-test-1', now: '2026-10-08T10:00:00.000Z' });

  assert.equal(s.id, 's-test-1');
  assert.equal(s.date, '2026-10-08');
  assert.equal(s.title, 'Pre-service check');
  assert.equal(s.vehicle, 'Blue Comet');
  assert.deepEqual(s.tags, ['engine', 'pre-service']);
  assert.equal(s.faults[0].code, 'P0101');
  assert.equal(s.faults[0].occurrences, 1);
  assert.equal(s.createdAt, '2026-10-08T10:00:00.000Z');
  assert.equal(s.updatedAt, '2026-10-08T10:00:00.000Z');
  assert.ok(s.redactions.count >= 2, 'session records its redaction count');
  assert.equal(s.redactions.byType.VIN, 2);
  assertNoRawIdentifiers(s, 'session');
});

test('uses a default title when none is provided', () => {
  const s = N.createSession({ date: '2026-10-08' });
  assert.equal(s.title, 'Session 2026-10-08');
  assert.equal(s.vehicle, '');
  assert.deepEqual(s.tags, []);
  assert.deepEqual(s.faults, []);
});

test('rejects invalid dates and non-string dates', () => {
  const expectCode = (fn, code) => {
    assert.throws(fn, (err) => err && err.code === code);
  };
  expectCode(() => N.createSession({ date: '2026-02-30' }), 'E_DATE');
  expectCode(() => N.createSession({ date: '2026-1-1' }), 'E_DATE');
  expectCode(() => N.createSession({ date: '1969-12-31' }), 'E_DATE');
  expectCode(() => N.createSession({ date: '2101-01-01' }), 'E_DATE');
  expectCode(() => N.createSession({ date: 20261008 }), 'E_TYPE');
  expectCode(() => N.createSession({}), 'E_TYPE');
});

test('enforces field length and count limits', () => {
  const expectCode = (fn, code) => {
    assert.throws(fn, (err) => err && err.code === code);
  };
  const base = { date: '2026-10-08' };
  expectCode(() => N.createSession(Object.assign({}, base, { title: 't'.repeat(121) })), 'E_LIMIT');
  expectCode(() => N.createSession(Object.assign({}, base, { vehicle: 'v'.repeat(61) })), 'E_LIMIT');
  expectCode(() => N.createSession(Object.assign({}, base, { notes: 'n'.repeat(4001) })), 'E_LIMIT');
  expectCode(() => N.createSession(Object.assign({}, base, { tags: Array.from({ length: 21 }, (_, i) => 'tag' + i) })), 'E_LIMIT');
  expectCode(() => N.createSession(Object.assign({}, base, { tags: ['x'.repeat(33)] })), 'E_LIMIT');
  expectCode(() => N.createSession(Object.assign({}, base, { tags: 'not-an-array' })), 'E_TYPE');
  expectCode(() => N.createSession(Object.assign({}, base, {
    faults: Array.from({ length: 501 }, (_, i) => ({ code: 'P' + String(i).padStart(4, '0') }))
  })), 'E_LIMIT');
  expectCode(() => N.createSession(Object.assign({}, base, {
    faults: [{ code: 'P0101', description: 'x'.repeat(301) }]
  })), 'E_LIMIT');
  expectCode(() => N.createSession(Object.assign({}, base, { faults: [{ code: '' }] })), 'E_SCHEMA');
  expectCode(() => N.createSession(Object.assign({}, base, { faults: [{ code: 42 }] })), 'E_SCHEMA');
  expectCode(() => N.createSession(Object.assign({}, base, { faults: [{ code: 'P0101', occurrences: 'two' }] })), 'E_TYPE');
});

test('updates a session while preserving id and created time', () => {
  const base = N.createSession({ date: '2026-10-08', title: 'First pass' }, { id: 'keep-me', now: '2026-10-08T10:00:00.000Z' });
  const updated = N.updateSession(base, { notes: 'Updated note with VIN WVWZZZ1KZ6W000003.' }, { now: '2026-10-09T00:00:00.000Z' });
  assert.equal(updated.id, 'keep-me');
  assert.equal(updated.createdAt, '2026-10-08T10:00:00.000Z');
  assert.equal(updated.updatedAt, '2026-10-09T00:00:00.000Z');
  assert.ok(updated.notes.includes('[REDACTED:VIN]'));
  assertNoRawIdentifiers(updated, 'updated session');
});

/* ------------------------------------------------------------------ */
/* Store: validation, storage, limits                                  */
/* ------------------------------------------------------------------ */

test('validates stores strictly and rejects bad documents', () => {
  const expectCode = (fn, code) => {
    assert.throws(fn, (err) => err && err.code === code);
  };
  const good = N.validateStore({
    version: 1,
    sessions: [{ id: 'x', date: '2026-01-01', title: 't', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }]
  });
  assert.equal(good.sessions[0].vehicle, '');
  assert.deepEqual(good.sessions[0].tags, []);

  expectCode(() => N.validateStore({ version: 2, sessions: [] }), 'E_VERSION');
  expectCode(() => N.validateStore({ version: 1, sessions: 'nope' }), 'E_SCHEMA');
  expectCode(() => N.validateStore(null), 'E_SCHEMA');
  const dup = N.createSession({ date: '2026-01-01' }, { id: 'dup', now: '2026-01-01T00:00:00.000Z' });
  expectCode(() => N.validateStore({ version: 1, sessions: [dup, dup] }), 'E_SCHEMA');
  const many = Array.from({ length: 251 }, (_, i) => N.createSession({ date: '2026-01-01' }, { id: 's' + i, now: '2026-01-01T00:00:00.000Z' }));
  expectCode(() => N.validateStore({ version: 1, sessions: many }), 'E_LIMIT');
  expectCode(() => N.validateStore({
    version: 1,
    sessions: [{ id: 'bad', date: 'not-a-date', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }]
  }), 'E_DATE');
  try {
    N.validateStore({ version: 1, sessions: [{ id: 'bad', date: 'not-a-date', createdAt: 'x', updatedAt: 'x' }] });
    assert.fail('expected an error');
  } catch (err) {
    assert.ok(/Session 1/.test(err.message), 'error identifies the failing record');
  }
});

test('saves and loads a store through memory storage', () => {
  const mem = N.createMemoryStorage();
  const store = N.emptyStore();
  store.sessions.push(N.createSession({ date: '2026-01-01', title: 'One' }, { id: 'a', now: '2026-01-01T00:00:00.000Z' }));
  store.sessions.push(N.createSession({ date: '2026-02-01', title: 'Two' }, { id: 'b', now: '2026-02-01T00:00:00.000Z' }));

  const saved = N.saveStoreTo(mem, store);
  assert.equal(saved.ok, true);
  assert.ok(saved.bytes > 0);

  const loaded = N.loadStoreFrom(mem);
  assert.equal(loaded.status, 'ok');
  assert.deepEqual(loaded.store, store);

  const fresh = N.loadStoreFrom(N.createMemoryStorage());
  assert.equal(fresh.status, 'empty');
  assert.deepEqual(fresh.store.sessions, []);
});

test('reports blocked storage as unavailable and keeps memory fallback', () => {
  const blocked = {
    getItem() { throw new Error('SecurityError: storage blocked'); },
    setItem() { throw new Error('SecurityError: storage blocked'); },
    removeItem() { throw new Error('SecurityError: storage blocked'); }
  };
  const loaded = N.loadStoreFrom(blocked);
  assert.equal(loaded.status, 'unavailable');
  assert.equal(loaded.protected, false);
  assert.deepEqual(loaded.store.sessions, []);

  const saved = N.saveStoreTo(blocked, N.emptyStore());
  assert.equal(saved.ok, false);
  assert.equal(saved.code, 'E_BLOCKED');
});

test('reports quota failures as E_QUOTA', () => {
  const full = N.createMemoryStorage();
  full.setItem = () => {
    const err = new Error('QuotaExceededError: storage full');
    err.name = 'QuotaExceededError';
    throw err;
  };
  const saved = N.saveStoreTo(full, N.emptyStore());
  assert.equal(saved.ok, false);
  assert.equal(saved.code, 'E_QUOTA');
});

test('protects corrupt and future-version stored data instead of overwriting blindly', () => {
  const corrupt = { value: '{not valid json', getItem() { return this.value; }, setItem() {}, removeItem() { this.value = null; } };
  const corrupted = N.loadStoreFrom(corrupt);
  assert.equal(corrupted.status, 'corrupt');
  assert.equal(corrupted.protected, true);
  assert.equal(corrupt.value, '{not valid json', 'stored bytes are left untouched');

  const future = { value: JSON.stringify({ version: 99, sessions: [] }), getItem() { return this.value; }, setItem() {}, removeItem() { this.value = null; } };
  const versioned = N.loadStoreFrom(future);
  assert.equal(versioned.status, 'version');
  assert.equal(versioned.protected, true);
});

test('skips unreadable records during load and reports them', () => {
  const mixed = JSON.stringify({
    version: 1,
    sessions: [
      { id: 'good', date: '2026-01-01', title: 'Fine', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'bad', date: 'nope', title: 'Broken', createdAt: 'x', updatedAt: 'x' }
    ]
  });
  const mem = { value: mixed, getItem() { return this.value; }, setItem() {}, removeItem() { this.value = null; } };
  const loaded = N.loadStoreFrom(mem);
  assert.equal(loaded.status, 'ok');
  assert.equal(loaded.store.sessions.length, 1);
  assert.equal(loaded.skippedCount, 1);
  assert.ok(loaded.warnings.some((w) => w.includes('Skipped unreadable session record 2')));
});

test('rejects oversized stores before writing anything', () => {
  const mem = N.createMemoryStorage();
  const huge = {
    version: 1,
    sessions: [{
      id: 's', date: '2026-10-08', title: 't', vehicle: '', tags: [], notes: 'x'.repeat(5 * 1024 * 1024),
      faults: [], redactions: { count: 0, byType: {} }, createdAt: '2026-10-08T00:00:00.000Z', updatedAt: '2026-10-08T00:00:00.000Z'
    }]
  };
  const saved = N.saveStoreTo(mem, huge);
  assert.equal(saved.ok, false);
  assert.equal(saved.code, 'E_SIZE');
  assert.equal(mem.getItem(N.STORAGE_KEY), null, 'nothing was written');
});

test('backup import is transactional, redacts raw fields and preserves state on failure', () => {
  const mem = N.createMemoryStorage();
  const seed = N.emptyStore();
  seed.sessions.push(N.createSession({ date: '2026-01-01', title: 'Seed' }, { id: 'seed', now: '2026-01-01T00:00:00.000Z' }));
  assert.equal(N.saveStoreTo(mem, seed).ok, true);
  const before = mem.getItem(N.STORAGE_KEY);

  const rejected = N.importBackupText(mem, '{"version":5,"sessions":[]}');
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'E_VERSION');
  assert.equal(mem.getItem(N.STORAGE_KEY), before, 'failed import leaves stored data untouched');

  const rejectedFormat = N.importBackupText(mem, 'not json');
  assert.equal(rejectedFormat.ok, false);
  assert.equal(rejectedFormat.code, 'E_FORMAT');
  assert.equal(mem.getItem(N.STORAGE_KEY), before, 'unparseable import leaves stored data untouched');

  const dirtyBackup = JSON.stringify({
    app: 'Diagnostic Session Notebook',
    version: 1,
    generatedAt: '2026-03-03T00:00:00.000Z',
    sessions: [{
      id: 'imported', date: '2026-02-02', title: 'Plate check', vehicle: '', tags: [], notes: 'License Plate: ZZ-99-ZZ',
      faults: [{ module: '01 Engine', code: 'P0101', description: 'VIN: WVWZZZ1KZ6W000009' }],
      redactions: { count: 0, byType: {} },
      createdAt: '2026-02-02T00:00:00.000Z', updatedAt: '2026-02-02T00:00:00.000Z'
    }]
  });
  const imported = N.importBackupText(mem, dirtyBackup);
  assert.equal(imported.ok, true);
  const stored = mem.getItem(N.STORAGE_KEY);
  assertNoRawIdentifiers(stored, 'imported store text');
  assert.ok(stored.includes('[REDACTED:VIN]') && stored.includes('[REDACTED:PLATE]'), 'identifiers were redacted before the atomic commit');
  assert.equal(N.loadStoreFrom(mem).store.sessions.length, 1);
});

/* ------------------------------------------------------------------ */
/* Comparison                                                          */
/* ------------------------------------------------------------------ */

test('compares faults into new, absent and persisting groups', () => {
  const before = N.parseScan('Address 01: Engine\n000123 - Example sensor fault\nP0101 - Example lean code\nP0101 - Example lean code again').faults;
  const after = N.parseScan('Address 01: Engine\n000123 - Example sensor fault\nP0300 - Example misfire code').faults;
  const cmp = N.compareFaults(before, after);

  assert.deepEqual(cmp.new.map((f) => f.code), ['P0300']);
  assert.equal(cmp.new[0].occurrencesBefore, 0);
  assert.equal(cmp.new[0].occurrencesAfter, 1);
  assert.deepEqual(cmp.absent.map((f) => f.code), ['P0101']);
  assert.equal(cmp.absent[0].occurrencesBefore, 2);
  assert.deepEqual(cmp.persisting.map((f) => f.code), ['000123']);
  assert.equal(cmp.persisting[0].occurrencesBefore, 1);
  assert.equal(cmp.persisting[0].occurrencesAfter, 1);
  assert.deepEqual(cmp.warnings, []);
});

test('treats the same code on different modules as different faults', () => {
  const before = N.parseScan('Address 01: Engine\nP0101 - Example').faults;
  const after = N.parseScan('Address 03: ABS\nP0101 - Example').faults;
  const cmp = N.compareFaults(before, after);
  assert.deepEqual(cmp.new.map((f) => f.module), ['03 ABS']);
  assert.deepEqual(cmp.absent.map((f) => f.module), ['01 Engine']);
  assert.deepEqual(cmp.persisting, []);
});

test('comparison warns when either side lists zero faults', () => {
  const empty = N.compareFaults([], []);
  assert.equal(empty.warnings.length, 2);
  assert.ok(empty.warnings.every((w) => /zero faults/.test(w)));

  const oneSide = N.compareFaults(N.parseScan('P0101 - x').faults, []);
  assert.equal(oneSide.warnings.length, 1);
  assert.ok(/after scan lists zero faults/.test(oneSide.warnings[0]));
});

test('comparison rejects non-array inputs', () => {
  assert.throws(() => N.compareFaults('nope', []), (err) => err && err.code === 'E_TYPE');
});

/* ------------------------------------------------------------------ */
/* Reports and exports                                                 */
/* ------------------------------------------------------------------ */

const reportBefore = N.createSession({
  date: '2026-09-14', title: 'Pre-service scan', vehicle: 'Blue Comet',
  notes: 'Fictional note. VIN WVWZZZ1KZ6W000001 seen in glovebox.',
  faults: [
    { module: '01 Engine', code: '000123', description: 'Example sensor fault (fictional)' },
    { module: '01 Engine', code: 'P0101', description: 'Example lean code (fictional)' }
  ]
}, { id: 'a', now: '2026-09-14T09:00:00.000Z' });
const reportAfter = N.createSession({
  date: '2026-10-05', title: 'Post-service scan', vehicle: 'Blue Comet',
  notes: 'Rescan after fictional repair work.',
  faults: [
    { module: '01 Engine', code: '000123', description: 'Example sensor fault (fictional)' },
    { module: '01 Engine', code: 'P0300', description: 'Example misfire code (fictional)' }
  ]
}, { id: 'b', now: '2026-10-05T09:00:00.000Z' });

test('report includes evidence, notes and limitations without identifiers', () => {
  const cmp = N.compareFaults(reportBefore.faults, reportAfter.faults);
  const report = N.buildReportText({ before: reportBefore, after: reportAfter, comparison: cmp, generatedAt: '2026-10-08T12:00:00.000Z' });
  assert.ok(report.includes('Pre-service scan'));
  assert.ok(report.includes('Post-service scan'));
  assert.ok(report.includes('[REDACTED:VIN]'));
  assert.ok(report.includes('DIFF SUMMARY'));
  assert.ok(report.includes('[NEW]'));
  assert.ok(report.includes('[ABSENT]'));
  assert.ok(report.includes('[PERSISTING]'));
  assert.ok(report.includes('P0300') && report.includes('P0101') && report.includes('000123'));
  assert.ok(report.includes('2026-10-08T12:00:00.000Z'));
  assert.ok(report.includes('does not prove a repair'));
  assert.ok(report.includes('best effort'));
  assert.ok(report.includes('zero faults does not prove'));
  assert.ok(report.includes('no vehicle control'));
  assertNoRawIdentifiers(report, 'report');
});

test('report repeats zero-fault warnings from the comparison', () => {
  const emptyAfter = N.createSession({ date: '2026-10-06', title: 'Empty scan (fictional)', faults: [] }, { id: 'c', now: '2026-10-06T00:00:00.000Z' });
  const cmp = N.compareFaults(reportBefore.faults, emptyAfter.faults);
  const report = N.buildReportText({ before: reportBefore, after: emptyAfter, comparison: cmp, generatedAt: '2026-10-08T12:00:00.000Z' });
  assert.ok(/zero faults/i.test(report));
  assert.ok(cmp.warnings.some((w) => /zero faults/i.test(w)));
});

test('comparison JSON and backup JSON are parseable, documented and clean', () => {
  const cmp = N.compareFaults(reportBefore.faults, reportAfter.faults);
  const json = JSON.parse(N.buildComparisonJson({ before: reportBefore, after: reportAfter, comparison: cmp, generatedAt: '2026-10-08T12:00:00.000Z' }));
  assert.equal(json.app, 'Diagnostic Session Notebook');
  assert.equal(json.version, N.SCHEMA_VERSION);
  assert.equal(json.before.title, 'Pre-service scan');
  assert.equal(json.diff.new[0].code, 'P0300');
  assert.deepEqual(json.diff.absent.map((f) => f.code), ['P0101']);
  assert.equal(json.limitations.length, 4);
  assertNoRawIdentifiers(JSON.stringify(json), 'comparison JSON');

  const store = { version: 1, sessions: [reportBefore, reportAfter] };
  const backup = JSON.parse(N.buildBackupJson(store, { generatedAt: '2026-10-08T12:00:00.000Z' }));
  assert.equal(backup.app, 'Diagnostic Session Notebook');
  assert.equal(backup.sessions.length, 2);
  assertNoRawIdentifiers(JSON.stringify(backup), 'backup JSON');

  const names = N.exportFilenames('2026-10-08T12:00:00.000Z');
  assert.equal(names.report, 'diagnostic-notebook-comparison-2026-10-08.txt');
  assert.equal(names.comparisonJson, 'diagnostic-notebook-comparison-2026-10-08.json');
  assert.equal(names.backup, 'diagnostic-notebook-backup-2026-10-08.json');
});

/* ------------------------------------------------------------------ */
/* Sample data                                                         */
/* ------------------------------------------------------------------ */

test('sample data is fictional, valid and demonstrates a comparison', () => {
  const sample = N.sampleData();
  const s1 = N.createSession(sample.before, { id: 'sample-before', now: '2026-09-14T09:00:00.000Z' });
  const s2 = N.createSession(sample.after, { id: 'sample-after', now: '2026-10-05T09:00:00.000Z' });
  assert.equal(s1.id, 'sample-before');
  assert.equal(s2.id, 'sample-after');
  assert.ok(JSON.stringify(sample).toLowerCase().includes('fictional'), 'sample text is labeled fictional');
  assertNoRawIdentifiers(sample, 'sample data');

  const cmp = N.compareFaults(s1.faults, s2.faults);
  assert.equal(cmp.new.length, 1);
  assert.equal(cmp.absent.length, 2);
  assert.equal(cmp.persisting.length, 1);

  assert.doesNotThrow(() => N.validateStore({ version: 1, sessions: [s1, s2] }));
});

/* ------------------------------------------------------------------ */
/* Static safety and DOM contract                                      */
/* ------------------------------------------------------------------ */

test('runtime files stay offline, safe and free of HTML injection paths', () => {
  const html = read('index.html');
  const appSrc = read('app.js');
  const coreSrc = read('core.js');
  const cssSrc = read('style.css');
  const forbid = (src, tokens, label) => {
    for (const token of tokens) {
      assert.ok(!src.includes(token), label + ' must not contain "' + token + '"');
    }
  };

  forbid(appSrc, ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', 'fetch(', 'XMLHttpRequest', 'WebSocket', 'sendBeacon', 'http://', 'https://', 'import('], 'app.js');
  forbid(coreSrc, ['document.', 'fetch(', 'XMLHttpRequest', 'WebSocket', 'http://', 'https://'], 'core.js');
  forbid(html, ['http://', 'https://', 'onclick=', 'onchange=', 'onsubmit=', 'oninput='], 'index.html');
  forbid(cssSrc, ['http', '@import', 'url('], 'style.css');

  assert.ok(!/<script(?![^>]*\bsrc=)/i.test(html), 'index.html must not contain inline scripts');
  assert.ok(html.includes('core.js') && html.includes('app.js') && html.includes('style.css'));
  assert.ok(html.includes('lang="en"') && html.includes('charset="utf-8"') && html.includes('viewport'));
});

test('DOM contract: required test ids exist for browser verification', () => {
  const html = read('index.html');
  const appSrc = read('app.js');
  const STATIC_TESTIDS = [
    'app', 'storage-status', 'toast',
    'session-form', 'session-date', 'session-title', 'session-vehicle', 'session-tags', 'session-notes',
    'import-text', 'import-file', 'import-format-note', 'preview-button', 'clear-import',
    'preview-panel', 'preview-summary', 'preview-text', 'preview-faults', 'fault-count',
    'save-session', 'cancel-edit', 'edit-banner',
    'session-list', 'session-count', 'search-input', 'tag-filter', 'empty-state',
    'before-select', 'after-select', 'compare-button', 'compare-note',
    'diff-new', 'diff-absent', 'diff-persisting',
    'diff-new-count', 'diff-absent-count', 'diff-persisting-count',
    'diff-new-list', 'diff-absent-list', 'diff-persisting-list',
    'report-preview', 'download-report', 'download-compare-json', 'print-report',
    'export-backup', 'import-backup-file', 'load-sample', 'reset-data',
    'confirm-dialog', 'confirm-title', 'confirm-message', 'confirm-yes', 'confirm-no'
  ];
  for (const id of STATIC_TESTIDS) {
    assert.ok(html.includes('data-testid="' + id + '"'), 'index.html must contain data-testid="' + id + '"');
  }
  const DYNAMIC_TESTIDS = ['session-card', 'card-title', 'card-date', 'card-vehicle', 'card-tags', 'card-faults-count', 'card-fault-list', 'edit-session', 'delete-session', 'diff-item'];
  for (const id of DYNAMIC_TESTIDS) {
    assert.ok(appSrc.includes("'" + id + "'"), 'app.js must create data-testid "' + id + '"');
  }
});

test('core.js exposes the Notebook API on a browser-like global object', () => {
  const coreSrc = read('core.js');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(coreSrc, sandbox);
  assert.equal(typeof sandbox.Notebook, 'object');
  assert.equal(typeof sandbox.Notebook.parseScan, 'function');
  assert.equal(typeof sandbox.Notebook.redactText, 'function');
  assert.equal(typeof sandbox.Notebook.compareFaults, 'function');
  assert.equal(typeof sandbox.Notebook.buildReportText, 'function');
  assert.equal(typeof sandbox.Notebook.STORAGE_KEY, 'string');
});

/* ------------------------------------------------------------------ */
/* Regression batch: quality-review minor findings                     */
/* ------------------------------------------------------------------ */

test('hostile backup ids and redaction keys never survive into exports', () => {
  const mem = N.createMemoryStorage();
  const hostileId = 'x"><script>alert(1)</script>';
  const hostileKey = '"><img src=x onerror=alert(1)>';
  const backup = JSON.stringify({
    app: 'Diagnostic Session Notebook',
    version: 1,
    generatedAt: '2026-10-08T00:00:00.000Z',
    sessions: [{
      id: hostileId,
      date: '2026-10-01',
      title: 'Hostile import',
      vehicle: '',
      tags: [],
      notes: '',
      faults: [{ module: '01 Engine', code: 'P0101', description: 'Example fault (fictional)' }],
      redactions: { count: 9, byType: { VIN: 2, [hostileKey]: 7, ['__proto__']: 1, constructor: 1 } },
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z'
    }]
  });
  const imported = N.importBackupText(mem, backup);
  assert.equal(imported.ok, true, 'the hostile backup still imports (data is preserved, the id is not)');
  const stored = mem.getItem(N.STORAGE_KEY);
  assert.ok(!stored.includes('<script>') && !stored.includes('onerror'), 'stored bytes carry no markup from the hostile id');
  const loaded = N.loadStoreFrom(mem);
  assert.equal(loaded.status, 'ok');
  const session = loaded.store.sessions[0];
  assert.match(session.id, /^[A-Za-z0-9_-]{1,80}$/, 'unsafe ids are regenerated to a safe charset');
  assert.deepEqual(session.redactions.byType, { VIN: 2 }, 'unsafe redaction keys are dropped');
  assert.equal(session.redactions.count, 9, 'the redaction count is preserved');
  const reExported = N.buildBackupJson(loaded.store, { generatedAt: '2026-10-08T00:00:00.000Z' });
  assert.ok(!reExported.includes('<script>') && !reExported.includes('onerror'), 'the re-exported backup is clean');
  const roundTrip = N.importBackupText(N.createMemoryStorage(), reExported);
  assert.equal(roundTrip.ok, true, 'the clean re-export re-imports');
  const comparison = N.buildComparisonJson({
    before: session,
    after: session,
    comparison: N.compareFaults(session.faults, session.faults),
    generatedAt: '2026-10-08T00:00:00.000Z'
  });
  assert.ok(!comparison.includes('<script>') && !comparison.includes('onerror'), 'the comparison JSON is clean');
  const direct = N.validateStore({
    version: 1,
    sessions: [{
      id: 'ok-1', date: '2026-10-01', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
      redactions: { count: 3, byType: { constructor: 2, ['__proto__']: 1 } }
    }]
  });
  assert.deepEqual(direct.sessions[0].redactions.byType, {}, 'prototype-member names are not kept as redaction counts');
});

test('prototype-member names are valid ids, tags and JSON keys (no false drops)', () => {
  const expectCode = (fn, code) => {
    assert.throws(fn, (err) => err && err.code === code);
  };
  const mk = (id) => ({ id, date: '2026-10-01', title: 't', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' });
  for (const id of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
    const store = N.validateStore({ version: 1, sessions: [mk(id)] });
    assert.equal(store.sessions[0].id, id, 'session id "' + id + '" must not be falsely rejected');
  }
  expectCode(() => N.validateStore({ version: 1, sessions: [mk('constructor'), mk('constructor')] }), 'E_SCHEMA');

  const session = N.createSession({ date: '2026-10-08', tags: ['constructor', 'toString', 'valueOf', '__proto__', 'Engine', 'engine'] }, { id: 'tag-test' });
  assert.deepEqual(session.tags, ['constructor', 'toString', 'valueOf', '__proto__', 'Engine'], 'tags keep prototype-member names and still dedupe case-insensitively');

  const res = N.parseScan(JSON.stringify({ faults: [{ code: 'P0101' }], ['constructor']: 'x' }));
  assert.ok(res.warnings.some((w) => w.includes('Ignored 1 unrecognized field') && w.includes('constructor')), 'prototype-member JSON keys are reported as unknown, not silently swallowed');
});

test('caps fault module length and rejects over-limit text logs at parse time', () => {
  const expectCode = (fn, code) => {
    assert.throws(fn, (err) => err && err.code === code);
  };
  expectCode(() => N.parseScan(JSON.stringify({ faults: [{ module: 'M'.repeat(61), code: 'P0101' }] })), 'E_LIMIT');
  const exact = N.parseScan(JSON.stringify({ faults: [{ module: 'M'.repeat(60), code: 'P0101' }] }));
  assert.equal(exact.faults[0].module.length, 60, 'a 60-character module is still accepted');
  expectCode(() => N.parseScan('Address 01: ' + 'X'.repeat(80) + '\nP0101 - Example fault'), 'E_LIMIT');

  const lines = ['Address 01: Engine'];
  for (let i = 0; i < 501; i++) lines.push(String(100000 + i) + ' - Example fault ' + i);
  expectCode(() => N.parseScan(lines.join('\n')), 'E_LIMIT');

  const ok = ['Address 01: Engine'];
  for (let i = 0; i < 500; i++) ok.push(String(100000 + i) + ' - Example fault ' + i);
  assert.equal(N.parseScan(ok.join('\n')).faults.length, 500, 'exactly 500 entries still parse');
});

test('load gives duplicate session ids fresh ids and reports it without dropping data', () => {
  const a = N.createSession({ date: '2026-09-01', title: 'First' }, { id: 'dup-1', now: '2026-09-01T00:00:00.000Z' });
  const b = N.createSession({ date: '2026-10-01', title: 'Second' }, { id: 'dup-1', now: '2026-10-01T00:00:00.000Z' });
  const mem = N.createMemoryStorage();
  mem.setItem(N.STORAGE_KEY, JSON.stringify({ version: 1, sessions: [a, b] }));
  const loaded = N.loadStoreFrom(mem);
  assert.equal(loaded.status, 'ok');
  assert.equal(loaded.store.sessions.length, 2, 'both records are preserved');
  const ids = loaded.store.sessions.map((s) => s.id);
  assert.equal(new Set(ids).size, 2, 'ids are unique after load');
  assert.equal(ids[0], 'dup-1', 'the first record keeps its id');
  assert.ok(loaded.warnings.some((w) => w.includes('Duplicate session id')), 'the reassignment is reported visibly');
  assert.equal(loaded.skippedCount, 0, 'nothing is skipped');
});

test('oversized stored data is protected and never loaded', () => {
  const huge = 'x'.repeat(5 * 1024 * 1024 + 1);
  const mem = { value: huge, getItem() { return this.value; }, setItem() {}, removeItem() { this.value = null; } };
  const loaded = N.loadStoreFrom(mem);
  assert.equal(loaded.status, 'corrupt');
  assert.equal(loaded.protected, true);
  assert.deepEqual(loaded.store.sessions, []);
  assert.ok(loaded.warnings.some((w) => w.includes('5 MB')), 'the warning explains the size protection');
  assert.equal(mem.value, huge, 'oversized bytes are left untouched');
});

test('report labels follow the session dates and flag reversed selections', () => {
  const earlier = N.createSession({ date: '2026-09-14', title: 'Earlier scan', faults: [] }, { id: 'order-e', now: '2026-09-14T00:00:00.000Z' });
  const later = N.createSession({ date: '2026-10-05', title: 'Later scan', faults: [] }, { id: 'order-l', now: '2026-10-05T00:00:00.000Z' });
  assert.equal(N.isReversedDateOrder(earlier, later), false);
  assert.equal(N.isReversedDateOrder(later, earlier), true);

  const normal = N.buildReportText({ before: earlier, after: later, comparison: N.compareFaults([], []), generatedAt: '2026-10-08T00:00:00.000Z' });
  assert.ok(normal.includes('BEFORE (earlier scan)') && normal.includes('AFTER (later scan)'));
  assert.ok(!normal.includes('does not follow chronological order'), 'no reversal note when the dates are in order');

  const reversed = N.buildReportText({ before: later, after: earlier, comparison: N.compareFaults([], []), generatedAt: '2026-10-08T00:00:00.000Z' });
  assert.ok(reversed.includes('does not follow chronological order'), 'reversed dates are flagged explicitly');
  assert.ok(reversed.includes('2026-10-05') && reversed.includes('2026-09-14'), 'both dates are named in the note');
  assert.ok(!reversed.includes('BEFORE (earlier scan)') && !reversed.includes('AFTER (later scan)'), 'misleading chronological labels are replaced');
});

test('file pickers are keyboard-focusable and primary hover keeps readable contrast', () => {
  const html = read('index.html');
  const cssSrc = read('style.css');
  const tag = (id) => {
    const match = html.match(new RegExp('<input[^>]*id="' + id + '"[^>]*>'));
    assert.ok(match, 'index.html must contain the #' + id + ' input');
    return match[0];
  };
  for (const id of ['import-file', 'import-backup-file']) {
    const input = tag(id);
    assert.ok(input.includes('visually-hidden'), id + ' must use the visually-hidden-but-focusable pattern');
    assert.ok(!/\shidden[\s>=]/.test(input), id + ' must not use the hidden attribute (display:none is not focusable)');
  }
  assert.ok(/<textarea[^>]*id="import-text"[^>]*aria-label="[^"]+"/.test(html), 'the scan textarea needs an accessible name');
  assert.ok(/\.visually-hidden\s*\{/.test(cssSrc), 'style.css must define .visually-hidden');
  assert.ok(/\.button:focus-within/.test(cssSrc), 'the file-picker label needs a visible focus style');
  assert.ok(!/label\.button\s+input\s*\{\s*display:\s*none/.test(cssSrc), 'the display:none file-input rule must be gone');

  const contrast = (a, b) => {
    const luminance = (hex) => {
      const channels = hex.slice(1).match(/../g).map((h) => parseInt(h, 16) / 255);
      const linear = channels.map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
      return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
    };
    const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (values[0] + 0.05) / (values[1] + 0.05);
  };
  const base = cssSrc.match(/\.primary\s*\{[^}]*background:\s*(#[0-9a-fA-F]{6})/);
  assert.ok(base, '.primary background must be defined');
  assert.ok(contrast(base[1], '#ffffff') >= 4.5, 'primary contrast must be at least 4.5:1');
  const hover = cssSrc.match(/\.primary:hover[^{]*\{[^}]*background:\s*(#[0-9a-fA-F]{6})/);
  assert.ok(hover, '.primary:hover background must be defined');
  const ratio = contrast(hover[1], '#ffffff');
  assert.ok(ratio >= 4.5, 'primary hover contrast ' + ratio.toFixed(2) + ':1 must be at least 4.5:1');
});

test('README claim: node --test auto-discovers the unit suites', () => {
  if (process.env.NOTEBOOK_TEST_NESTED === '1') return; /* avoid recursive spawns */
  const { spawnSync } = require('node:child_process');
  /* Strip the outer runner's marker: NODE_TEST_CONTEXT=child-v8 makes the
   * nested runner report over IPC and emit no visible output. */
  const env = Object.assign({}, process.env, { NOTEBOOK_TEST_NESTED: '1' });
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--test'], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 120000
  });
  assert.equal(result.status, 0, 'node --test must pass from the repo root: ' + String(result.stderr).slice(0, 400));
  const out = String(result.stdout) + String(result.stderr);
  assert.ok(out.includes('redacts labeled identifiers'), 'core.test.cjs was discovered and ran');
  assert.ok(out.includes('regression: editing a compared session'), 'app-regression.test.cjs was discovered and ran');
});
