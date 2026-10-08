# Browser verification: stale-report fix (Playwright, headless Chrome)

Tooling: the parent QA Playwright installation (read-only) driving a scratch
reproduction script; the parent acceptance runner was executed **unmodified**
(it wrote only its own artifacts).

## Scenario (mirrors the parent acceptance "notebook-main" tail)
Load fictional sample → Compare (1 new / 2 absent / 1 persisting) → edit first
session notes to `Edited evidence after comparison` → Save session → confirm.

## Pre-fix reproduction (app.js before the central invalidation)
- `#download-report` stayed enabled and `#report-preview` kept the stale report.
- Clicking Download produced a real stale export: `includesEditedText: false`,
  `includesOldNotes: true` (the old sample notes, not the edit).
- Same stale state after sample reload (replace) and unrelated add.
- Script result: `RESULT: FAIL (stale report remains)`, exit 1.

## Post-fix verification
- After the edit: `#download-report`, `#download-compare-json` and
  `#print-report` all disabled; preview reset to
  `Run a comparison to build the report.`; clicking the report button produces
  no download (`staleExport: {downloaded: false}`).
- Replacement (sample reload), unrelated add, and delete: all invalidated the
  comparison (`downloadDisabled: true`).
- No page errors, no external requests.
- Script result: `RESULT: PASS (no stale report after edit/replace/add/delete)`, exit 0.

## Parent acceptance (unmodified runner)
```
notebook-main            -> PASS {"cases":1,"pass":1,"fail":0}
notebook-blocked-storage -> PASS {"cases":1,"pass":1,"fail":0}
```
