import {_electron as electron} from 'playwright-core';
import fs from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out=path.join(root,'.cache/desktop-smoke');await fs.mkdir(out,{recursive:true});
const lib={};globalThis.__testPdf=lib;
vm.runInThisContext(`(function(exports,module){${readFileSync(path.join(root,'vendor/pdf-lib.min.js'),'utf8')}\n})(globalThis.__testPdf,{});`);delete globalThis.__testPdf;
const input=await lib.PDFDocument.create();input.addPage([400,500]).drawText('Paper PDF - desktop verification',{x:40,y:420,size:16});
const inputPath=path.join(out,'input.pdf');await fs.writeFile(inputPath,await input.save());
const packaged=process.env.PAPER_PDF_EXECUTABLE;
const app=await electron.launch({...(packaged?{executablePath:path.resolve(packaged),args:[]}:{args:[root]}),env:{...process.env},timeout:60000});
const checks=[],errors=[];
try{
  const page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
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
    const info=await page.evaluate(()=>window.paperDesktop.checkUpdate());assert.equal(info.status,'up_to_date');assert.equal(info.currentVersion,'0.1.0');checks.push('published signed update feed reports current version');
  }
  await page.screenshot({path:path.join(out,'desktop.png')});
  assert.deepEqual(errors,[]);
  await fs.writeFile(path.join(out,'results.json'),JSON.stringify({packaged:!!packaged,checks,errors,wordTested:!!sourceWord},null,2));
  console.log(JSON.stringify({packaged:!!packaged,checks,errors},null,2));
}finally{await app.evaluate(({app})=>app.exit()).catch(()=>{});await app.close().catch(()=>{});}
