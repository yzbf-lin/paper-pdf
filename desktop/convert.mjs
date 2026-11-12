import {access, mkdir, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {spawn} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export const MAX_WORD_BYTES=50*1024*1024;
export const MAX_PDF_BYTES=100*1024*1024;
const OLE_MAGIC=Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]);

function failure(code,message){return Object.assign(new Error(message),{code});}
function executablePath(value,platform){
  if(typeof value!=='string'||!value.trim()||value.includes('\0'))return null;
  const resolved=path.resolve(value.trim());
  return platform==='darwin'&&resolved.toLowerCase().endsWith('.app')?path.join(resolved,'Contents','MacOS','soffice'):resolved;
}
async function canExecute(filename,platform){
  try {await access(filename,platform==='win32'?constants.F_OK:constants.X_OK);return (await stat(filename)).isFile();}
  catch{return false;}
}

/** No bundled/runtime-specific path is assumed; a selected LibreOffice.app is accepted. */
export async function findConverter({configuredPath,env=process.env,platform=process.platform}={}){
  const selected=executablePath(configuredPath,platform);
  if(configuredPath){
    if(selected&&await canExecute(selected,platform))return {available:true,executable:selected,source:'configured'};
    return {available:false,executable:null,reason:'选择的 LibreOffice 程序不存在或不可执行。'};
  }
  const candidates=[];
  const add=(value,source)=>{const candidate=executablePath(value,platform);if(candidate)candidates.push({candidate,source});};
  add(env.SOFFICE_PATH,'environment');
  if(platform==='darwin'){
    add('/Applications/LibreOffice.app/Contents/MacOS/soffice','system');
    add(path.join(env.HOME||os.homedir(),'Applications/LibreOffice.app/Contents/MacOS/soffice'),'system');
  }else if(platform==='win32'){
    for(const base of [env.ProgramFiles,env['ProgramFiles(x86)'],env.LOCALAPPDATA]){
      if(base){add(path.join(base,'LibreOffice/program/soffice.com'),'system');add(path.join(base,'LibreOffice/program/soffice.exe'),'system');}
    }
  }
  for(const entry of (env.PATH||'').split(platform==='win32'?';':path.delimiter)){
    // Never resolve an empty PATH entry to the current working directory.
    if(!entry||!path.isAbsolute(entry))continue;
    for(const command of platform==='win32'?['soffice.com','soffice.exe']:['soffice','libreoffice'])add(path.join(entry,command),'path');
  }
  for(const {candidate,source} of candidates)if(await canExecute(candidate,platform))return {available:true,executable:candidate,source};
  return {available:false,executable:null,reason:'Word 转换需要本机 LibreOffice。请先安装 LibreOffice，或选择已有的 LibreOffice 程序。'};
}

// The official LibreOffice schemas define these values. A new profile has no
// trusted locations or certificates; disabling macros overrides security level.
// https://github.com/LibreOffice/core/blob/master/officecfg/registry/schema/org/openoffice/Office/Common.xcs
// https://github.com/LibreOffice/core/blob/master/officecfg/registry/schema/org/openoffice/Office/Writer.xcs
const PROFILE=`<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry">
 <item oor:path="/org.openoffice.Office.Common/Security/Scripting">
  <prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop>
  <prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop>
  <prop oor:name="DisableActiveContent" oor:op="fuse"><value>true</value></prop>
  <prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value></prop>
  <prop oor:name="SecureURL" oor:op="fuse"><value/></prop>
 </item>
 <item oor:path="/org.openoffice.Office.Writer/Content/Update">
  <prop oor:name="Link" oor:op="fuse"><value>2</value></prop>
 </item>
</oor:items>`;
const xml=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));

async function prepareProfile(temp,executable,env,platform){
  const profile=path.join(temp,'profile');
  await mkdir(path.join(profile,'user'),{recursive:true});
  await writeFile(path.join(profile,'user/registrymodifications.xcu'),PROFILE);
  const childEnv={...env};
  if(platform==='darwin'){
    const cache=path.join(temp,'font-cache');await mkdir(cache);
    const bundledFonts=path.resolve(path.dirname(executable),'../Resources/fonts/truetype');
    const dirs=['/System/Library/Fonts','/Library/Fonts',path.join(env.HOME||os.homedir(),'Library/Fonts'),bundledFonts];
    const fontFile=path.join(temp,'fonts.conf');
    await writeFile(fontFile,`<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig>
${dirs.map(dir=>`<dir>${xml(dir)}</dir>`).join('\n')}
<cachedir>${xml(cache)}</cachedir>
<alias><family>SimSun</family><prefer><family>Songti SC</family><family>STHeiti</family></prefer></alias>
<alias><family>宋体</family><prefer><family>Songti SC</family><family>STHeiti</family></prefer></alias>
<alias><family>Microsoft YaHei</family><prefer><family>PingFang SC</family><family>STHeiti</family></prefer></alias>
<alias><family>微软雅黑</family><prefer><family>PingFang SC</family><family>STHeiti</family></prefer></alias>
</fontconfig>`);
    childEnv.FONTCONFIG_FILE=fontFile;
  }
  return {profile,childEnv};
}

function killConversion(child){
  if(!child.pid)return;
  if(process.platform==='win32'){
    const taskkill=path.join(process.env.SystemRoot||'C:\\Windows','System32','taskkill.exe');
    const killer=spawn(taskkill,['/pid',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore',shell:false});
    killer.on('error',()=>child.kill('SIGKILL'));
    killer.unref();
  }else{
    try{process.kill(-child.pid,'SIGKILL');}catch{try{child.kill('SIGKILL');}catch{}}
  }
}

function runConverter(executable,args,{env,cwd,timeoutMs,spawnImpl=spawn}){
  return new Promise((resolve,reject)=>{
    let child,error,output='',size=0,timer;
    const stop=reason=>{if(error)return;error=reason;killConversion(child);};
    try{child=spawnImpl(executable,args,{env,cwd,windowsHide:true,shell:false,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});}
    catch(cause){reject(failure('CONVERTER_START_FAILED',`无法启动 LibreOffice：${cause.message}`));return;}
    const collect=chunk=>{
      size+=Buffer.byteLength(chunk);
      if(size>65536){stop(failure('CONVERTER_OUTPUT_LIMIT','LibreOffice 输出异常，转换已停止。'));return;}
      output+=chunk.toString('utf8');
    };
    child.stdout.on('data',collect);child.stderr.on('data',collect);
    child.once('error',cause=>{error=failure('CONVERTER_START_FAILED',`无法启动 LibreOffice：${cause.message}`);});
    child.once('close',(code,signal)=>{
      clearTimeout(timer);
      if(error){reject(error);return;}
      if(code!==0){reject(failure('CONVERSION_FAILED',`Word 转换失败（${signal||code}）。${output.trim().slice(-1000)}`));return;}
      resolve(output);
    });
    timer=setTimeout(()=>stop(failure('CONVERSION_TIMEOUT','Word 转换超时，已停止转换。请检查文件是否加密、损坏或过于复杂。')),timeoutMs);
    timer.unref?.();
  });
}

/** Converts a local Word snapshot; the source file is never changed. */
export async function convertWord(inputPath,{executable,timeoutMs=120000,env=process.env,platform=process.platform,spawnImpl}={}){
  if(typeof inputPath!=='string'||inputPath.includes('\0'))throw failure('INVALID_WORD_FILE','请选择本机 Word 文件。');
  const extension=path.extname(inputPath).toLowerCase();
  if(!['.doc','.docx'].includes(extension))throw failure('UNSUPPORTED_WORD_TYPE','仅支持 .doc 和 .docx Word 文档。');
  const info=await stat(inputPath).catch(()=>null);
  if(!info?.isFile())throw failure('INVALID_WORD_FILE','Word 文件不存在或不是普通文件。');
  if(info.size>MAX_WORD_BYTES)throw failure('WORD_TOO_LARGE','Word 文档不能超过 50 MB。');
  const input=await readFile(inputPath).catch(()=>{throw failure('WORD_READ_FAILED','无法读取 Word 文档，请检查文件访问权限。');});
  if(input.length>MAX_WORD_BYTES)throw failure('WORD_TOO_LARGE','Word 文档不能超过 50 MB。');
  const valid=extension==='.doc'?input.subarray(0,8).equals(OLE_MAGIC):
    input.subarray(0,4).equals(Buffer.from([0x50,0x4b,0x03,0x04]))&&input.includes(Buffer.from('[Content_Types].xml'))&&input.includes(Buffer.from('word/document.xml'));
  if(!valid)throw failure('INVALID_WORD_FILE','文件格式与 Word 扩展名不符，或文件已加密。请在 Word 中另存为未加密的 .docx 后重试。');
  if(!Number.isFinite(timeoutMs)||timeoutMs<1||timeoutMs>600000)throw failure('INVALID_TIMEOUT','转换超时时间无效。');
  const converter=await findConverter({configuredPath:executable,env,platform});
  if(!converter.available)throw failure('CONVERTER_NOT_FOUND',converter.reason);
  const temp=await mkdtemp(path.join(os.tmpdir(),'paper-pdf-word-'));
  try{
    const source=path.join(temp,`document${extension}`),out=path.join(temp,'output');
    await mkdir(out);await writeFile(source,input);
    const {profile,childEnv}=await prepareProfile(temp,converter.executable,env,platform);
    const log=await runConverter(converter.executable,[`-env:UserInstallation=${pathToFileURL(profile).href}`,'--headless','--nologo','--nodefault','--nofirststartwizard','--norestore','--convert-to','pdf:writer_pdf_Export','--outdir',out,source],{env:childEnv,cwd:temp,timeoutMs,spawnImpl});
    const target=path.join(out,'document.pdf');
    const result=await stat(target).catch(()=>null);
    if(!result?.isFile())throw failure('CONVERSION_FAILED',`LibreOffice 未生成 PDF。文件可能加密、损坏或不受支持。${log.trim().slice(-500)}`);
    if(result.size>MAX_PDF_BYTES)throw failure('PDF_TOO_LARGE','转换后的 PDF 超过 100 MB，无法导入。');
    const pdf=await readFile(target);
    if(!pdf.subarray(0,5).equals(Buffer.from('%PDF-')))throw failure('INVALID_PDF_OUTPUT','LibreOffice 返回了无效 PDF。');
    return {bytes:Uint8Array.from(pdf),filename:path.basename(inputPath,path.extname(inputPath))+'.pdf'};
  }finally{
    await rm(temp,{recursive:true,force:true,maxRetries:3,retryDelay:100});
  }
}
