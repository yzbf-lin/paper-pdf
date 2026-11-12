import {_electron as electron} from 'playwright-core';
import fs from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const {version:appVersion}=JSON.parse(readFileSync(path.join(root,'package.json'),'utf8'));
const out=path.join(root,'.cache/desktop-smoke');await fs.mkdir(out,{recursive:true});
const lib={};globalThis.__testPdf=lib;
vm.runInThisContext(`(function(exports,module){${readFileSync(path.join(root,'vendor/pdf-lib.min.js'),'utf8')}\n})(globalThis.__testPdf,{});`);delete globalThis.__testPdf;
const input=await lib.PDFDocument.create();input.addPage([400,500]).drawText('Paper PDF - desktop verification',{x:40,y:420,size:16});
const inputPath=path.join(out,'input.pdf');await fs.writeFile(inputPath,await input.save());
const packaged=process.env.PAPER_PDF_EXECUTABLE;
const userData=await fs.mkdtemp(path.join(out,'profile-'));
const launch=()=>electron.launch({...(packaged?{executablePath:path.resolve(packaged)}:{}),args:[...(packaged?[]:[root]),`--user-data-dir=${userData}`],env:{...process.env},timeout:60000});
let app;
const checks=[],errors=[];
try{
  app=await launch();
  assert.equal(await app.evaluate(({app})=>app.getPath('userData')),userData,'tests must not change the user profile');
  let page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
  await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');
  assert.ok(await page.locator('#import-word').isVisible());checks.push('desktop bridge and Word import entry');
  async function menuOpen(label,input){
    const pending=page.waitForEvent('filechooser',{timeout:8000});
    await app.evaluate(({Menu},label)=>Menu.getApplicationMenu().items.find(x=>x.label==='文件').submenu.items.find(x=>x.label===label).click(),label);
    await (await pending).setFiles(input);
  }
  await menuOpen('打开 PDF…',inputPath);checks.push('native Open PDF menu');
  await page.waitForFunction(()=>document.querySelector('#paper').getAttribute('aria-busy')==='false'&&document.querySelector('#page-count').textContent==='1 页');
  assert.ok(page.workers().length>0,'PDF renders in an actual Web Worker');
  async function draw(){const r=await page.locator('#ink-layer').boundingBox();await page.mouse.move(r.x+55,r.y+100);await page.mouse.down();await page.mouse.move(r.x+110,r.y+125,{steps:8});await page.mouse.up();}
  await draw();assert.equal(await page.locator('#strokes').evaluate(n=>n.children.length),1);
  await page.locator('#undo').click();assert.equal(await page.locator('#strokes').evaluate(n=>n.children.length),0);
  await page.locator('#redo').click();assert.equal(await page.locator('#strokes').evaluate(n=>n.children.length),1);checks.push('real pointer handwriting / undo / redo');
  await app.evaluate(({dialog})=>{dialog.showSaveDialog=async()=>({canceled:true});});
  await page.locator('#save-draft').click();await page.waitForFunction(()=>document.querySelector('#busy').hidden);
  assert.match(await page.locator('#save-state').textContent(),/有新笔迹/);checks.push('cancelled native save preserves dirty state');
  async function save(selector,name){const target=path.join(out,name);await fs.unlink(target).catch(()=>{});await app.evaluate(({dialog},filePath)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath});},target);await page.locator(selector).click();await page.waitForFunction(()=>document.querySelector('#busy').hidden);await fs.access(target);return target;}
  const draftPath=await save('#save-draft','answer.pdfink');
  const pdfPath=await save('#export-pdf','answer.pdf');
  let draft=JSON.parse(await fs.readFile(draftPath,'utf8'));
  assert.equal(draft.ink[0].length,1);assert.equal((await lib.PDFDocument.load(await fs.readFile(pdfPath))).getPageCount(),1);
  await page.reload();await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');
  await menuOpen('打开草稿…',draftPath);checks.push('native Open Draft menu');
  await page.waitForFunction(()=>document.querySelector('#paper').getAttribute('aria-busy')==='false'&&document.querySelector('#strokes').children.length===1);
  checks.push('native draft/PDF save and full draft restore');
  const sourceWord=process.env.PAPER_PDF_SMOKE_WORD;
  if(sourceWord){
    await app.evaluate(({dialog},input)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[input]});},path.resolve(sourceWord));
    await page.locator('#import-word').click();
    const expected=path.basename(sourceWord).replace(/\.docx?$/i,'.pdf');
    await page.waitForFunction(name=>document.querySelector('#file-name').textContent===name&&document.querySelector('#busy').hidden,expected,{timeout:150000});
    assert.equal(await page.locator('#strokes').evaluate(n=>n.children.length),0);await draw();
    const convertedDraft=await save('#save-draft','word-answer.pdfink');
    const convertedPdf=await save('#export-pdf','word-answer.pdf');
    draft=JSON.parse(await fs.readFile(convertedDraft,'utf8'));assert.equal(draft.ink[0].length,1);
    assert.ok((await lib.PDFDocument.load(await fs.readFile(convertedPdf))).getPageCount()>0);
    checks.push('real Word import -> local PDF conversion -> handwriting -> draft/PDF export');
    const bad=path.join(out,'invalid.docx');await fs.writeFile(bad,'not a Word file');
    await app.evaluate(({dialog},input)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[input]});},bad);
    await page.locator('#import-word').click();await page.waitForFunction(()=>document.querySelector('#busy').hidden);
    assert.equal(await page.locator('#file-name').textContent(),expected);assert.equal(await page.locator('#strokes').evaluate(n=>n.children.length),1);checks.push('invalid Word leaves existing document and ink intact');
  }
  if(process.env.PAPER_PDF_EXPECT_CURRENT_UPDATE==='1'){
    const info=await page.evaluate(()=>window.paperDesktop.checkUpdate());assert.equal(info.status,'up_to_date');assert.equal(info.currentVersion,appVersion);assert.equal(info.version,appVersion);checks.push('published signed update feed reports current version');
  }
  // Exercise fast strokes and interruptions through the real desktop pointer handlers.
  await page.locator('#clear-page').click();await page.locator('#confirm-dialog button[value="confirm"]').click();
  const strokeCount=()=>page.locator('#strokes').evaluate(n=>n.children.length);
  await page.waitForFunction(()=>document.querySelector('#strokes').children.length===0);
  assert.equal(await strokeCount(),0);
  const r=await page.locator('#ink-layer').boundingBox();
  for(let i=0;i<40;i++){
    const x=r.x+45+(i%10)*22,y=r.y+90+Math.floor(i/10)*24;
    await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+12,y+8);await page.mouse.up();
  }
  for(let i=0;i<20;i++){await page.mouse.move(r.x+45+i*10,r.y+205);await page.mouse.down();await page.mouse.up();}
  let expectedCount=60;
  assert.equal(await strokeCount(),expectedCount);checks.push('40 rapid short strokes and 20 rapid dots are retained');
  await page.evaluate(()=>{
    document.querySelector('#ink-layer').addEventListener('pointerdown',event=>{window.__smokePointerId=event.pointerId;},{capture:true});
  });
  async function beginStroke(y){
    await page.mouse.move(r.x+55,r.y+y);await page.mouse.down();await page.mouse.move(r.x+110,r.y+y+10);
    assert.equal(await page.locator('#preview').evaluate(n=>n.children.length),1);
  }
  await beginStroke(230);
  const capturedId=await page.evaluate(()=>{
    const layer=document.querySelector('#ink-layer'),id=window.__smokePointerId;
    if(!layer.hasPointerCapture(id))throw new Error('The real pointer was not captured');
    window.__smokeLostPointerId=null;
    layer.addEventListener('lostpointercapture',event=>{window.__smokeLostPointerId=event.pointerId;},{once:true});
    layer.releasePointerCapture(id);return id;
  });
  await page.mouse.move(r.x+112,r.y+242);
  assert.equal(await page.evaluate(()=>window.__smokeLostPointerId),capturedId);
  assert.equal(await strokeCount(),++expectedCount,'capture loss retains the visible stroke');
  await page.mouse.up();assert.equal(await strokeCount(),expectedCount,'late pointerup must not duplicate the stroke');
  const interruptedInk=await page.locator('#strokes').innerHTML();
  await page.locator('#undo').click();assert.equal(await strokeCount(),expectedCount-1);
  await page.locator('#redo').click();assert.equal(await page.locator('#strokes').innerHTML(),interruptedInk);
  checks.push('real pointer capture loss retains ink exactly once with undo/redo');
  for(const interruption of ['pointercancel','blur','resize']){
    await beginStroke(250);
    await page.evaluate(type=>{
      if(type==='pointercancel')document.querySelector('#ink-layer').dispatchEvent(new PointerEvent(type,{pointerId:window.__smokePointerId,pointerType:'mouse',bubbles:true}));
      else window.dispatchEvent(new Event(type));
    },interruption);
    if(interruption==='resize')await page.waitForFunction(count=>document.querySelector('#strokes').children.length===count&&document.querySelector('#paper').getAttribute('aria-busy')==='false',expectedCount+1);
    assert.equal(await strokeCount(),++expectedCount,`${interruption} retains the visible stroke`);
    await page.mouse.up();assert.equal(await strokeCount(),expectedCount,`${interruption} and late pointerup commit only once`);
  }
  checks.push('pointer cancellation, focus loss and resize preserve sampled ink');
  await beginStroke(275);
  await page.evaluate(()=>{
    const layer=document.querySelector('#ink-layer'),pointerId=window.__smokePointerId+1000;
    for(const type of ['pointercancel','lostpointercapture'])layer.dispatchEvent(new PointerEvent(type,{pointerId,pointerType:'mouse',bubbles:true}));
  });
  assert.equal(await strokeCount(),expectedCount);assert.equal(await page.locator('#preview').evaluate(n=>n.children.length),1);
  await page.mouse.up();assert.equal(await strokeCount(),++expectedCount);checks.push('unrelated pointer interruptions do not affect the active stroke');
  const completedInk=await page.locator('#strokes').innerHTML();
  await page.locator('#undo').click();assert.equal(await strokeCount(),expectedCount-1);
  await page.locator('#redo').click();assert.equal(await strokeCount(),expectedCount);assert.equal(await page.locator('#strokes').innerHTML(),completedInk);
  const fastDraftPath=await save('#save-draft','fast-ink.pdfink');
  draft=JSON.parse(await fs.readFile(fastDraftPath,'utf8'));assert.equal(draft.ink[0].length,expectedCount);
  await page.reload();await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');
  await menuOpen('打开草稿…',fastDraftPath);
  await page.waitForFunction(count=>document.querySelector('#strokes').children.length===count&&document.querySelector('#paper').getAttribute('aria-busy')==='false',expectedCount);
  assert.equal(await page.locator('#strokes').innerHTML(),completedInk);checks.push('fast and interrupted ink survives undo/redo and draft restore');

  const originalColor=(await page.locator('#current-color-value').textContent()).trim();
  await page.locator('#custom-color').click();
  await page.locator('#color-hex').fill('3a7');
  assert.equal(await page.locator('#color-picker').inputValue(),'#33aa77');
  assert.deepEqual(await Promise.all(['r','g','b'].map(channel=>page.locator(`#color-${channel}`).inputValue())),['51','170','119']);
  for(const [channel,value] of [['r','12'],['g','34'],['b','56']])await page.locator(`#color-${channel}`).fill(value);
  assert.equal(await page.locator('#color-picker').inputValue(),'#0c2238');
  assert.equal((await page.locator('#color-hex').inputValue()).toLowerCase(),'#0c2238');
  await page.locator('#color-picker').evaluate(input=>{input.value='#8a35c7';input.dispatchEvent(new Event('input',{bubbles:true}));});
  assert.equal((await page.locator('#color-hex').inputValue()).toLowerCase(),'#8a35c7');
  assert.deepEqual(await Promise.all(['r','g','b'].map(channel=>page.locator(`#color-${channel}`).inputValue())),['138','53','199']);
  await page.locator('#color-r').fill('300');
  assert.equal(await page.locator('#color-apply').isDisabled(),true);assert.ok(await page.locator('#color-error').isVisible());
  assert.equal((await page.locator('#current-color-value').textContent()).trim(),originalColor);
  await page.locator('#color-hex').fill('#2a6bce');
  await page.locator('#color-hex').fill('#xyz');assert.equal(await page.locator('#color-apply').isDisabled(),true);
  await page.locator('#color-hex').fill('#2a6bce');
  await page.locator('#color-cancel').click();await page.waitForFunction(()=>!document.querySelector('#color-dialog').open);
  assert.equal((await page.locator('#current-color-value').textContent()).trim(),originalColor);
  assert.equal(await page.locator('#strokes').innerHTML(),completedInk);
  checks.push('HEX/RGB/picker stay synchronized; invalid and cancelled edits leave ink settings intact');

  await page.locator('#custom-color').click();await page.locator('#color-hex').fill(' 2a6bce ');
  await page.screenshot({path:path.join(out,'color-dialog.png')});
  await page.locator('#color-apply').click();await page.waitForFunction(()=>!document.querySelector('#color-dialog').open);
  assert.equal((await page.locator('#current-color-value').textContent()).trim(),'#2A6BCE');
  await page.locator('#pen-width').evaluate(input=>{input.value='3.2';input.dispatchEvent(new Event('input',{bubbles:true}));});
  await draw();assert.equal(await strokeCount(),expectedCount+1);
  const newStroke=page.locator('#strokes > :last-child');
  assert.equal(await newStroke.getAttribute('stroke'),'#2a6bce');assert.equal(await newStroke.getAttribute('stroke-width'),'3.2');
  assert.equal(await page.locator('#strokes').evaluate((node,count)=>[...node.children].slice(0,count).map(child=>child.outerHTML).join(''),expectedCount),completedInk);
  const colorDraftPath=await save('#save-draft','color-answer.pdfink');
  const colorDraft=JSON.parse(await fs.readFile(colorDraftPath,'utf8'));
  assert.deepEqual(colorDraft.ink[0].slice(0,expectedCount),draft.ink[0]);
  assert.equal(colorDraft.ink[0].at(-1).color,'#2a6bce');assert.equal(colorDraft.ink[0].at(-1).width,3.2);
  checks.push('custom color and width reach new strokes and saved drafts without recoloring prior ink');
  await page.locator('#pen-only').check();await draw();assert.equal(await strokeCount(),expectedCount+1,'pen-only ignores mouse strokes');
  async function assertPenSettings(color,width,penOnly){
    assert.equal((await page.locator('#current-color-value').textContent()).trim(),color);
    assert.equal(await page.locator('#pen-width').inputValue(),width);assert.equal(await page.locator('#width-value').textContent(),width);
    assert.equal(await page.locator('#pen-only').isChecked(),penOnly);
  }
  await page.reload();await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');
  await assertPenSettings('#2A6BCE','3.2',true);checks.push('color, width and pen-only mode survive a page reload');
  await app.close();
  app=await launch();page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
  await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');
  await assertPenSettings('#2A6BCE','3.2',true);checks.push('pen settings survive a full application exit and restart');
  await page.evaluate(()=>localStorage.setItem('paper-pdf.pen-settings.v1','{broken json'));
  await page.reload();await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');
  await assertPenSettings('#202B35','1.6',false);checks.push('corrupt persisted settings recover to usable defaults');
  await menuOpen('打开草稿…',colorDraftPath);
  await page.waitForFunction(count=>document.querySelector('#strokes').children.length===count&&document.querySelector('#paper').getAttribute('aria-busy')==='false',expectedCount+1);
  await page.screenshot({path:path.join(out,'desktop.png')});
  assert.deepEqual(errors,[]);
  await fs.writeFile(path.join(out,'results.json'),JSON.stringify({packaged:!!packaged,checks,errors,wordTested:!!sourceWord},null,2));
  console.log(JSON.stringify({packaged:!!packaged,checks,errors},null,2));
}finally{
  if(app){await app.evaluate(({app})=>app.exit()).catch(()=>{});await app.close().catch(()=>{});}
  await fs.rm(userData,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
