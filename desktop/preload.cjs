const {contextBridge,ipcRenderer}=require('electron');
const call=async(channel,...args)=>{
  const result=await ipcRenderer.invoke(channel,...args);
  if(result?.error){const e=new Error(result.error);e.code=result.code;throw e;}
  return result;
};
contextBridge.exposeInMainWorld('paperDesktop',{
  info:()=>call('paper:info'),
  importWord:()=>call('paper:word'),
  configureConverter:()=>call('paper:converter'),
  checkUpdate:()=>call('paper:update-check'),
  downloadUpdate:()=>call('paper:update-download'),
  openRelease:()=>call('paper:release'),
  saveFile:(bytes,name,type)=>call('paper:save',bytes,name,type),
  onCommand:callback=>{const listener=(_event,command)=>callback(command);ipcRenderer.on('paper:command',listener);return()=>ipcRenderer.removeListener('paper:command',listener);}
});
