import {app,BrowserWindow,Menu,dialog,ipcMain,protocol,shell,session} from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {resolveAsset,CSP} from './assets.mjs';
import {findConverter,convertWord} from './convert.mjs';
import {checkForUpdate,downloadVerified} from './updates.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.dirname(here),releaseUrl='https://github.com/yzbf-lin/paper-pdf/releases/latest';
const officeUrl='https://www.libreoffice.org/download/download-libreoffice/';
app.setName('Paper PDF');
protocol.registerSchemesAsPrivileged([{scheme:'paper',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}]);
let win,preferences={},latest=null,checking=null,downloading=false,converting=false;
const settingsPath=()=>path.join(app.getPath('userData'),'settings.json');
const command=name=>win?.webContents.send('paper:command',name);
const checked=(name,fn)=>ipcMain.handle(name,async(event,...args)=>{
  if(event.sender!==win?.webContents||event.senderFrame!==event.sender.mainFrame||event.senderFrame.url!=='paper://app/index.html')throw new Error('不允许的页面请求');
  try{return await fn(...args);}catch(e){return {error:e.message,code:e.code||'FAILED'};}
});

async function chooseConverter(){
  const result=await dialog.showOpenDialog(win,{title:'选择 LibreOffice 应用或 soffice 程序',properties:['openFile'],defaultPath:process.platform==='darwin'?'/Applications':undefined});
  if(result.canceled)return null;
  const info=await findConverter({configuredPath:result.filePaths[0]});
  if(!info.available)throw new Error('所选位置没有可用的 LibreOffice 转换程序。');
  preferences.converterPath=info.executable;
  await fs.writeFile(settingsPath(),JSON.stringify(preferences,null,2),{mode:0o600});
  return {available:true};
}
async function getConverter(){
  let found=await findConverter({configuredPath:preferences.converterPath});
  if(found.available)return found.executable;
  const {response}=await dialog.showMessageBox(win,{type:'info',title:'Word 转 PDF',message:'需要本机 LibreOffice 转换 Word 文档',detail:'安装 LibreOffice 后即可离线转换 .doc 和 .docx。也可以选择已经安装的 LibreOffice；原文件不会被改写。',buttons:['选择已安装程序','打开官方下载页','取消'],defaultId:0,cancelId:2});
  if(response===1){await shell.openExternal(officeUrl);return null;}
  if(response!==0||!await chooseConverter())return null;
  found=await findConverter({configuredPath:preferences.converterPath});
  return found.executable;
}
async function importWord(){
  if(converting)throw new Error('已有文档正在转换，请稍候。');
  converting=true;
  try{
    const result=await dialog.showOpenDialog(win,{title:'导入 Word，转换为 PDF 后编辑',properties:['openFile'],filters:[{name:'Word 文档',extensions:['doc','docx']}]});
    if(result.canceled)return null;
    const executable=await getConverter();if(!executable)return null;
    return await convertWord(result.filePaths[0],{executable});
  }finally{converting=false;}
}
async function checkUpdate(){
  if(checking)return checking;
  checking=(async()=>{
    const publicKey=await fs.readFile(path.join(here,'update-public.pem'),'utf8');
    latest=await checkForUpdate({publicKey,currentVersion:app.getVersion(),platform:process.platform,arch:process.arch});
    return latest;
  })();
  try{return await checking;}finally{checking=null;}
}
async function downloadUpdate(){
  if(downloading)throw new Error('正在下载新版，请稍候。');
  if(latest?.status!=='available'||!latest.asset)throw new Error('请先检查更新。');
  downloading=true;
  try{
    const result=await dialog.showSaveDialog(win,{title:'保存新版桌面包',defaultPath:path.join(app.getPath('downloads'),latest.asset.filename),filters:[{name:'ZIP 安装包',extensions:['zip']}]});
    if(result.canceled)return null;
    await downloadVerified(latest.asset,result.filePath);
    shell.showItemInFolder(result.filePath);
    return {saved:true,filename:path.basename(result.filePath)};
  }finally{downloading=false;}
}
async function saveFile(bytes,name,type){
  if(!(bytes instanceof Uint8Array)||bytes.length>170000000||!['application/pdf','application/json'].includes(type))throw new Error('保存内容无效或过大。');
  const extension=type==='application/pdf'?'pdf':'pdfink';
  const clean=path.basename(String(name)).replace(/[\\/:*?"<>|\x00-\x1f]/g,'_').slice(0,160).replace(/\.(pdf|pdfink)$/i,'')+'.'+extension;
  const result=await dialog.showSaveDialog(win,{title:extension==='pdf'?'导出 PDF':'保存可编辑草稿',defaultPath:path.join(app.getPath('documents'),clean),filters:[{name:extension==='pdf'?'PDF 文档':'纸上可编辑草稿',extensions:[extension]}]});
  if(result.canceled)return false;
  const temporary=path.join(path.dirname(result.filePath),`.paper-pdf-${randomUUID()}.tmp`);
  try{await fs.writeFile(temporary,bytes,{mode:0o600,flag:'wx'});await fs.rename(temporary,result.filePath);}
  finally{await fs.unlink(temporary).catch(()=>{});}
  return true;
}
function createWindow(){
  win=new BrowserWindow({width:1440,height:1000,minWidth:800,minHeight:600,title:'纸上 · Paper PDF',backgroundColor:'#f6f8f2',icon:path.join(here,'icons/icon.png'),webPreferences:{preload:path.join(here,'preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,spellcheck:false}});
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',(e,url)=>{if(url!=='paper://app/index.html')e.preventDefault();});
  win.webContents.on('will-attach-webview',e=>e.preventDefault());
  win.webContents.on('will-prevent-unload',event=>{
    const response=dialog.showMessageBoxSync(win,{type:'question',buttons:['继续编辑','放弃并关闭'],defaultId:0,cancelId:0,title:'尚有未保存的笔迹',message:'关闭会丢失当前未保存的修改。'});
    if(response===1)event.preventDefault();
  });
  win.loadURL('paper://app/index.html');
  win.on('closed',()=>{win=null;});
}
if(!app.requestSingleInstanceLock())app.quit();
else{
  app.on('second-instance',()=>{if(win?.isMinimized())win.restore();win?.focus();});
  app.whenReady().then(async()=>{
  try{const value=JSON.parse(await fs.readFile(settingsPath(),'utf8'));if(value&&typeof value.converterPath==='string')preferences={converterPath:value.converterPath};}catch{}
  protocol.handle('paper',async request=>{
    let target;try{target=resolveAsset(request.url,root);}catch{}
    if(!target||request.method!=='GET')return new Response('Not found',{status:404});
    const type=target.endsWith('.html')?'text/html':target.endsWith('.css')?'text/css':'text/javascript';
    return new Response(await fs.readFile(target),{headers:{'Content-Type':type+'; charset=utf-8','Content-Security-Policy':CSP,'X-Content-Type-Options':'nosniff','Cache-Control':'no-store'}});
  });
  session.defaultSession.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
  session.defaultSession.setPermissionCheckHandler(()=>false);
  session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*','file://*/*']},(_details,callback)=>callback({cancel:true}));
  checked('paper:info',()=>({version:app.getVersion(),platform:process.platform,arch:process.arch,packaged:app.isPackaged}));
  checked('paper:word',importWord);checked('paper:converter',chooseConverter);
  checked('paper:update-check',checkUpdate);checked('paper:update-download',downloadUpdate);
  checked('paper:release',()=>shell.openExternal(releaseUrl));checked('paper:save',saveFile);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform==='darwin'?[{label:'Paper PDF',submenu:[{role:'about'},{type:'separator'},{label:'检查更新…',click:()=>command('update')},{type:'separator'},{role:'hide'},{role:'hideOthers'},{role:'unhide'},{type:'separator'},{role:'quit'}]}]:[]),
    {label:'文件',submenu:[{label:'打开 PDF…',accelerator:'CmdOrCtrl+O',click:()=>command('open')},{label:'导入 Word…',click:()=>command('word')},{label:'打开草稿…',click:()=>command('draft')},{label:'保存草稿…',accelerator:'CmdOrCtrl+S',click:()=>command('save')},{label:'导出 PDF…',click:()=>command('export')},{type:'separator'},{role:process.platform==='darwin'?'close':'quit'}]},
    {label:'编辑',submenu:[{label:'撤销',accelerator:'CmdOrCtrl+Z',click:()=>command('undo')},{label:'重做',accelerator:'CmdOrCtrl+Shift+Z',click:()=>command('redo')},{type:'separator'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},
    {label:'帮助',submenu:[{label:'检查更新…',click:()=>command('update')},{label:'配置 Word 转换程序…',click:()=>command('converter')},{label:'版本下载与说明',click:()=>shell.openExternal(releaseUrl)}]}
  ]));
  createWindow();app.on('activate',()=>{if(!win)createWindow();});
  app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit();});
  }).catch(error=>{dialog.showErrorBox('纸上启动失败',error.message);app.exit(1);});
}
