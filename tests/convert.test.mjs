import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {convertWord,findConverter,MAX_WORD_BYTES} from '../desktop/convert.mjs';

const docx=Buffer.concat([Buffer.from([0x50,0x4b,0x03,0x04]),Buffer.from('[Content_Types].xml word/document.xml')]);
const doc=Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]);
const missing=path.join(os.tmpdir(),'paper-pdf-no-such-program','soffice');
async function fixture(t,content=docx,name='测试 空格.docx'){
 const dir=await mkdtemp(path.join(os.tmpdir(),'paper-pdf-test-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const input=path.join(dir,name);await writeFile(input,content);return {dir,input};
}
async function stub(t,body){
 const {dir}=await fixture(t);
 const script=path.join(dir,'converter.mjs');
 await writeFile(script,`import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';const args=process.argv.slice(2);${body}`);
 const calls=[];
 return {calls,spawnImpl:(executable,args,options)=>{calls.push({executable,args,options});return spawn(process.execPath,[script,...args],options);}};
}

test('converter discovery reports missing engine and invalid selected program',async()=>{
 assert.equal((await findConverter({env:{},platform:'linux'})).available,false);
 const selected=await findConverter({configuredPath:missing});
 assert.equal(selected.available,false);assert.match(selected.reason,/不存在/);
 const configured=await findConverter({configuredPath:process.execPath});
 assert.equal(configured.available,true);assert.equal(configured.source,'configured');
 assert.equal((await findConverter({env:{SOFFICE_PATH:process.execPath},platform:'linux'})).source,'environment');
});

test('rejects wrong extensions, wrong magic, encrypted DOCX, and oversized Word before launch',async t=>{
 const f=await fixture(t,Buffer.from('not a Word document'));
 await assert.rejects(convertWord(f.input,{executable:missing}),{code:'INVALID_WORD_FILE'});
 const encrypted=path.join(f.dir,'encrypted.docx');await writeFile(encrypted,doc);
 await assert.rejects(convertWord(encrypted,{executable:missing}),{code:'INVALID_WORD_FILE'});
 await assert.rejects(convertWord(path.join(f.dir,'input.txt')),{code:'UNSUPPORTED_WORD_TYPE'});
 const large=path.join(f.dir,'large.doc');
 const {open}=await import('node:fs/promises');const handle=await open(large,'w');await handle.truncate(MAX_WORD_BYTES+1);await handle.close();
 await assert.rejects(convertWord(large,{executable:missing}),{code:'WORD_TOO_LARGE'});
});

test('valid Word without LibreOffice has an actionable error',async t=>{
 const f=await fixture(t);
 await assert.rejects(convertWord(f.input,{executable:missing}),error=>error.code==='CONVERTER_NOT_FOUND'&&error.message.includes('LibreOffice'));
});

test('converts Word through an isolated locked-down profile, validates PDF, leaves source untouched, and cleans temp',async t=>{
 const f=await fixture(t);
 const s=await stub(t,`
 const profile=fileURLToPath(args.find(a=>a.startsWith('-env:UserInstallation=')).slice('-env:UserInstallation='.length));
 const config=fs.readFileSync(path.join(profile,'user/registrymodifications.xcu'),'utf8');
 if(!config.includes('DisableMacrosExecution')||!config.includes('<value>true</value>')||!config.includes('MacroSecurityLevel')||!config.includes('<value>3</value>'))throw new Error('Unsafe profile');
 if(!args.includes('--headless')||!args.includes('pdf:writer_pdf_Export'))throw new Error('Wrong converter arguments');
 const out=args[args.indexOf('--outdir')+1];fs.writeFileSync(path.join(out,'document.pdf'),'%PDF-1.7\\nconverted\\n%%EOF');
 `);
 const result=await convertWord(f.input,{executable:process.execPath,spawnImpl:s.spawnImpl});
 assert.equal(result.filename,'测试 空格.pdf');assert.ok(result.bytes instanceof Uint8Array);
 assert.equal(Buffer.from(result.bytes).toString(),'%PDF-1.7\nconverted\n%%EOF');
 assert.deepEqual(await readFile(f.input),docx);
 assert.equal(s.calls[0].options.shell,false);
 assert.equal(s.calls[0].args.at(-1).endsWith('document.docx'),true);
 await assert.rejects(stat(s.calls[0].options.cwd),{code:'ENOENT'});
});

test('legacy .doc magic is accepted and original output name is preserved',async t=>{
 const f=await fixture(t,doc,'old.DOC');
 const s=await stub(t,`fs.writeFileSync(path.join(args[args.indexOf('--outdir')+1],'document.pdf'),'%PDF-1.4\\n%%EOF');`);
 assert.equal((await convertWord(f.input,{executable:process.execPath,spawnImpl:s.spawnImpl})).filename,'old.pdf');
});

test('failed conversion, missing output and non-PDF output never reach the editor',async t=>{
 const f=await fixture(t);
 for(const [body,code] of [
  ["process.stderr.write('conversion failed');process.exit(2)",'CONVERSION_FAILED'],
  ["process.exit(0)",'CONVERSION_FAILED'],
  ["fs.writeFileSync(path.join(args[args.indexOf('--outdir')+1],'document.pdf'),'not pdf')",'INVALID_PDF_OUTPUT']
 ]){
  const s=await stub(t,body);
  await assert.rejects(convertWord(f.input,{executable:process.execPath,spawnImpl:s.spawnImpl}),{code});
  await assert.rejects(stat(s.calls[0].options.cwd),{code:'ENOENT'});
 }
});

test('timeout kills the conversion and removes its isolated directory',async t=>{
 const f=await fixture(t);
 const s=await stub(t,'setInterval(()=>{},1000)');
 const started=Date.now();
 await assert.rejects(convertWord(f.input,{executable:process.execPath,spawnImpl:s.spawnImpl,timeoutMs:100}),{code:'CONVERSION_TIMEOUT'});
 assert.ok(Date.now()-started<4000);
 await assert.rejects(stat(s.calls[0].options.cwd),{code:'ENOENT'});
});

test('excess converter output is bounded and temporary files are removed',async t=>{
 const f=await fixture(t);
 const s=await stub(t,"process.stdout.write('x'.repeat(70000));setInterval(()=>{},1000)");
 await assert.rejects(convertWord(f.input,{executable:process.execPath,spawnImpl:s.spawnImpl}),{code:'CONVERTER_OUTPUT_LIMIT'});
 await assert.rejects(stat(s.calls[0].options.cwd),{code:'ENOENT'});
});
