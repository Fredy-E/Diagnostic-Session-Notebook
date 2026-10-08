'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..');
const ART = path.join(ROOT, 'test-results');
const results = [];
async function eqText(page, selector, text) {
  await page.waitForFunction(({s,t}) => document.querySelector(s)?.textContent.trim() === t, {s:selector,t:text}, {timeout:5000});
}
async function count(page, selector, n) {
  await page.waitForFunction(({s,n}) => document.querySelectorAll(s).length === n, {s:selector,n}, {timeout:5000});
}
async function download(page, selector, name) {
  const event = page.waitForEvent('download');
  await page.locator(selector).click();
  const file = await event;
  assert.equal(await file.failure(), null);
  const dest = path.join(ART, name);
  await file.saveAs(dest);
  return fs.readFile(dest,'utf8');
}
async function mobile(page) {
  for(const width of [390,320]) {
    await page.setViewportSize({width,height:844});
    const overflow=await page.evaluate(() => Math.max(document.documentElement.scrollWidth,document.body.scrollWidth)-innerWidth);
    assert.ok(overflow<=1, 'Mobile body overflow at '+width+' px: '+overflow+' px');
  }
  await page.setViewportSize({width:1440,height:1000});
}
async function execute(browser, name, callback, storageBlocked=false, initScript=null) {
  const context=await browser.newContext({acceptDownloads:true,viewport:{width:1440,height:1000}});
  if(storageBlocked) await context.addInitScript(() => Object.defineProperty(window,'localStorage',{configurable:true,get(){throw new DOMException('blocked for test','SecurityError');}}));
  if(initScript) await context.addInitScript(initScript);
  const page=await context.newPage();
  const errors=[]; const requests=[];
  page.on('pageerror', e=>errors.push(e.message));
  page.on('console', m=>{if(m.type()==='error')errors.push(m.text());});
  page.on('request', r=>{if(/^https?:/i.test(r.url())) requests.push(r.url());});
  try {
    await callback(page);
    assert.deepEqual(errors,[],'Unexpected page/console errors');
    assert.deepEqual(requests,[],'Unexpected network requests');
    results.push({name,status:'pass',errors,externalRequests:requests});
    console.log('PASS '+name);
  } catch(error) {
    results.push({name,status:'fail',message:error.message,stack:error.stack,errors,externalRequests:requests});
    console.error('FAIL '+name+'\n'+error.stack);
    await page.screenshot({path:path.join(ART,name.replace(/\W+/g,'-')+'-failure.png'),fullPage:true});
  } finally {await context.close();}
}
async function open(page, repo) {
  await page.goto(pathToFileURL(path.join(ROOT,'index.html')).href,{waitUntil:'load'});
}
async function notebook(page) {
  await open(page,'Diagnostic-Session-Notebook');
  await page.locator('[data-ready="true"]').waitFor();
  const scanFileFocus=await page.evaluate(() => { document.getElementById('import-file').focus(); return document.activeElement && document.activeElement.id; });
  assert.equal(scanFileFocus,'import-file','scan file input must be keyboard-focusable');
  const backupFileFocus=await page.evaluate(() => { document.getElementById('import-backup-file').focus(); return document.activeElement && document.activeElement.id; });
  assert.equal(backupFileFocus,'import-backup-file','backup file input must be keyboard-focusable');
  const vin='WVWZZZ1KZ6W000001', plate='QA-123456';
  await page.locator('#session-date').fill('2026-10-01');
  await page.locator('#session-title').fill('Fictional pre-service');
  await page.locator('#session-notes').fill('License Plate: '+plate);
  await page.locator('#import-file').setInputFiles({name:'fictional.log',mimeType:'text/plain',buffer:Buffer.from('VIN: '+vin+'\nLicense Plate: '+plate+'\nAddress 01: Engine\nP0101 - Example sensor fault')});
  await page.locator('#preview-panel').waitFor({state:'visible'});
  assert.doesNotMatch(await page.locator('#preview-text').textContent(),new RegExp(vin+'|'+plate));
  await page.locator('#save-session').click();
  await count(page,'[data-testid="session-card"]',1);
  const stored=await page.evaluate(()=>localStorage.getItem(Notebook.STORAGE_KEY));
  assert.doesNotMatch(stored,new RegExp(vin+'|'+plate));
  await page.reload();
  await count(page,'[data-testid="session-card"]',1);
  const backup=await download(page,'#export-backup','notebook-backup.json');
  assert.doesNotMatch(backup,new RegExp(vin+'|'+plate));
  await page.locator('#import-backup-file').setInputFiles({name:'bad.json',mimeType:'application/json',buffer:Buffer.from('{"version":999,"sessions":[]}')});
  await page.locator('#confirm-yes').click();
  await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('Import failed'));
  await count(page,'[data-testid="session-card"]',1);
  await page.locator('#load-sample').click();
  await page.locator('#confirm-no').click();
  await count(page,'[data-testid="session-card"]',1);
  await page.locator('#load-sample').click();
  await page.locator('#confirm-yes').click();
  await count(page,'[data-testid="session-card"]',2);
  await page.locator('#compare-button').click();
  await eqText(page,'#diff-new-count','1');
  await eqText(page,'#diff-absent-count','2');
  await eqText(page,'#diff-persisting-count','1');
  const report=await download(page,'#download-report','notebook-report.txt');
  assert.match(report,/does not prove|not proof|not.*repair/i);
  const comparison=JSON.parse(await download(page,'#download-compare-json','notebook-comparison.json'));
  assert.ok(comparison && typeof comparison==='object');
  await page.evaluate(()=>{window.print=()=>{window.__printed=true;};});
  await page.locator('#print-report').click();
  assert.equal(await page.evaluate(()=>window.__printed),true);
  const roundTrip=await download(page,'#export-backup','notebook-backup-roundtrip.json');
  assert.doesNotMatch(roundTrip,new RegExp(vin+'|'+plate));
  await page.locator('#import-backup-file').setInputFiles({name:'roundtrip.json',mimeType:'application/json',buffer:Buffer.from(roundTrip)});
  await page.locator('#confirm-yes').click();
  await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('Backup imported'));
  await count(page,'[data-testid="session-card"]',2);
  await mobile(page);
  await page.screenshot({path:path.join(ART,'notebook.png'),fullPage:true});
  await page.locator('[data-testid="edit-session"]').first().click();
  await page.locator('#session-notes').fill('Edited evidence after comparison');
  await page.locator('#save-session').click();
  await page.locator('#confirm-yes').click();
  const accurate=await page.locator('#download-report').isDisabled() || (await page.locator('#report-preview').textContent()).includes('Edited evidence after comparison');
  assert.ok(accurate,'Editing compared evidence must invalidate or refresh the report; no stale exports');
}
async function blockedNotebook(page) {
  await open(page,'Diagnostic-Session-Notebook');
  await page.locator('#load-sample').click();
  await count(page,'[data-testid="session-card"]',2);
  assert.match(await page.locator('#storage-status').textContent(),/memory/i);
  const backup=await download(page,'#export-backup','notebook-memory-backup.json');
  assert.equal(JSON.parse(backup).sessions.length,2);
}

/* Storage that reads fine but refuses every write: stored sessions must
 * still load, and the banner must say writes are kept in memory only. */
const readOnlyInit = () => {
  const seed = JSON.stringify({version:1,sessions:[
    {id:'ro-1',date:'2026-09-01',title:'Seeded one',vehicle:'',tags:[],notes:'',faults:[],redactions:{count:0,byType:{}},createdAt:'2026-09-01T00:00:00.000Z',updatedAt:'2026-09-01T00:00:00.000Z'},
    {id:'ro-2',date:'2026-10-01',title:'Seeded two',vehicle:'',tags:[],notes:'',faults:[],redactions:{count:0,byType:{}},createdAt:'2026-10-01T00:00:00.000Z',updatedAt:'2026-10-01T00:00:00.000Z'}
  ]});
  const real = window.localStorage;
  real.setItem('diagnostic-session-notebook.v1', seed);
  const failing = {
    getItem: (k) => real.getItem(k),
    removeItem: (k) => real.removeItem(k),
    setItem: () => { const error = new Error('QuotaExceededError: storage full'); error.name = 'QuotaExceededError'; throw error; }
  };
  Object.defineProperty(window, 'localStorage', { configurable: true, get() { return failing; } });
};
async function readOnlyNotebook(page) {
  await open(page,'Diagnostic-Session-Notebook');
  await page.locator('[data-ready="true"]').waitFor();
  await count(page,'[data-testid="session-card"]',2);
  assert.match(await page.locator('#storage-status').textContent(),/refused a test write/i);
  await page.locator('#session-title').fill('Read-only storage session');
  await page.locator('#save-session').click();
  await count(page,'[data-testid="session-card"]',3);
  await page.waitForFunction(()=>/last save failed/i.test(document.querySelector('#storage-status').textContent));
  const storedCount=await page.evaluate(()=>JSON.parse(localStorage.getItem(Notebook.STORAGE_KEY)).sessions.length);
  assert.equal(storedCount,2,'failed writes must leave stored sessions untouched');
}

(async()=>{
  await fs.mkdir(ART,{recursive:true});
  const launch={headless:true};
  const channel=process.env.PLAYWRIGHT_CHANNEL || (process.platform==='win32' ? 'chrome' : '');
  if(channel) launch.channel=channel;
  const browser=await chromium.launch(launch);
  try {
    await execute(browser,"notebook-main",notebook,false);
    await execute(browser,"notebook-blocked-storage",blockedNotebook,true);
    await execute(browser,"notebook-readonly-storage",readOnlyNotebook,false,readOnlyInit);
  } finally {await browser.close();}
  await fs.writeFile(path.join(ART,'browser-results.json'),JSON.stringify({checkedAt:new Date().toISOString(),results},null,2));
  const failed=results.filter(x=>x.status==='fail');
  console.log(JSON.stringify({cases:results.length,pass:results.length-failed.length,fail:failed.length}));
  if(!results.length || failed.length)process.exitCode=1;
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
