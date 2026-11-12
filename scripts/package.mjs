import {cp,lstat,mkdir,readFile,readdir,rm,stat,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {dirname,extname,isAbsolute,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {packager} from '@electron/packager';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const targets={darwin:{arch:'arm64',label:'macOS-arm64',icon:'icon.icns'},win32:{arch:'x64',label:'Windows-x64',icon:'icon.ico'}};
const topFiles=['index.html','style.css','LICENSE','README.md'];
const upstreamFiles=['upstream/LICENSE','upstream/UPSTREAM-ORIGIN.json'];

function permittedFile(relative) {
  if(topFiles.includes(relative)||upstreamFiles.includes(relative))return true;
  const parts=relative.split('/');
  if(parts.some(part=>part.startsWith('.')||['node_modules','tests','test-results'].includes(part)))return false;
  if(relative.startsWith('src/'))return ['.js','.mjs','.cjs','.css','.html','.svg'].includes(extname(relative));
  if(relative.startsWith('vendor/'))return ['.js','.json','.txt'].includes(extname(relative));
  if(relative==='desktop/update-public.pem')return true;
  if(relative.startsWith('desktop/icons/'))return ['.icns','.ico','.png','.svg'].includes(extname(relative));
  if(relative.startsWith('desktop/'))return ['.js','.mjs','.cjs','.json'].includes(extname(relative));
  return false;
}

async function copyAllowedTree(relative,stage,files) {
  const source=join(root,relative),info=await lstat(source);
  if(info.isSymbolicLink())throw new Error(`打包源码不允许符号链接：${relative}`);
  if(info.isDirectory()) {
    if(relative.split('/').some(part=>part.startsWith('.')||['node_modules','tests','test-results'].includes(part)))return;
    for(const entry of await readdir(source))await copyAllowedTree(`${relative}/${entry}`,stage,files);
  }else if(info.isFile()&&permittedFile(relative)) {
    await mkdir(dirname(join(stage,relative)),{recursive:true});
    await cp(source,join(stage,relative));files.push(relative);
  }
}

export async function stageApplication({platform=process.platform,arch=process.arch}={}) {
  const target=targets[platform];
  if(!target||target.arch!==arch)throw new Error('仅支持 darwin/arm64 与 win32/x64');
  const metadata=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
  if(!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(metadata.version))throw new Error('版本必须是 X.Y.Z');
  if(metadata.main!=='desktop/main.mjs')throw new Error('桌面入口应为 desktop/main.mjs');
  const stage=join(root,'build',`stage-${platform}-${arch}`);
  await rm(stage,{recursive:true,force:true});await mkdir(stage,{recursive:true});
  const files=[];
  for(const relative of [...topFiles,'src','vendor','desktop',...upstreamFiles])await copyAllowedTree(relative,stage,files);
  for(const required of ['desktop/main.mjs','desktop/preload.cjs','desktop/update-public.pem',`desktop/icons/${target.icon}`]){
    if(!files.includes(required))throw new Error(`缺少桌面打包文件：${required}`);
  }
  // The staging package has no development dependencies or local npm configuration.
  const packageData=Object.fromEntries(['name','version','main','type','license'].map(key=>[key,metadata[key]]));
  await writeFile(join(stage,'package.json'),JSON.stringify(packageData,null,2)+'\n');
  files.push('package.json');files.sort();
  await writeFile(join(root,'build',`stage-files-${platform}-${arch}.json`),JSON.stringify(files,null,2)+'\n');
  return {metadata,stage,files,target,platform,arch};
}

export async function buildApplication(options={}) {
  const prepared=await stageApplication(options),{metadata,stage,target,platform,arch}=prepared;
  if(platform!==process.platform)throw new Error('请在对应操作系统上打包，macOS签名和Windows压缩需要原生工具');
  const electronZipDir=process.env.PAPER_PDF_ELECTRON_ZIP_DIR;
  if(electronZipDir&&(!isAbsolute(electronZipDir)||!(await stat(electronZipDir)).isDirectory()))throw new Error('PAPER_PDF_ELECTRON_ZIP_DIR 必须是存在的绝对目录');
  const directories=await packager({
    dir:stage,out:join(root,'build'),name:'Paper PDF',executableName:'Paper PDF',
    appBundleId:'com.yzbf.paperpdf',appVersion:metadata.version,buildVersion:metadata.version,
    electronVersion:metadata.devDependencies.electron,platform,arch,asar:true,prune:false,overwrite:true,
    icon:join(root,'desktop','icons',target.icon),
    ...(electronZipDir?{electronZipDir}:{}),
  });
  if(directories.length!==1)throw new Error(`预期一个桌面产物，实际 ${directories.length}`);
  const directory=directories[0],release=join(root,'release');await mkdir(release,{recursive:true});
  const archive=join(release,`Paper-PDF-v${metadata.version}-${target.label}.zip`);
  const run=(command,args,options={})=>execFileSync(command,args,{stdio:'inherit',...options});
  if(platform==='darwin') {
    const app=join(directory,'Paper PDF.app');
    run('codesign',['--force','--deep','--sign','-',app]);
    run('codesign',['--verify','--deep','--strict',app]);
    const info=join(app,'Contents','Info.plist');
    for(const [key,expected] of [['CFBundleIdentifier','com.yzbf.paperpdf'],['CFBundleShortVersionString',metadata.version]]){
      const actual=execFileSync('/usr/libexec/PlistBuddy',['-c',`Print :${key}`,info],{encoding:'utf8'}).trim();
      if(actual!==expected)throw new Error(`应用 ${key} 不匹配：${actual}`);
    }
    await rm(archive,{force:true});
    run('ditto',['-c','-k','--sequesterRsrc','--keepParent',app,archive]);
  }else{
    await stat(join(directory,'Paper PDF.exe'));
    run('powershell.exe',['-NoProfile','-NonInteractive','-Command',
      "$ErrorActionPreference='Stop'; Compress-Archive -LiteralPath $env:PAPER_PDF_PACKAGE_PATH -DestinationPath $env:PAPER_PDF_ARCHIVE_PATH -Force"],{
      env:{...process.env,PAPER_PDF_PACKAGE_PATH:directory,PAPER_PDF_ARCHIVE_PATH:archive},
    });
  }
  const size=(await stat(archive)).size;
  if(size<=0)throw new Error('打包结果为空');
  console.log(JSON.stringify({version:metadata.version,platform,arch,application:directory,archive,size,stagedFiles:prepared.files.length},null,2));
  return {directory,archive,version:metadata.version,platform,arch};
}

async function main(){
  const args=process.argv.slice(2),options={};let stageOnly=false;
  for(let i=0;i<args.length;i++) {
    if(args[i]==='--help'){console.log('node scripts/package.mjs [--platform darwin|win32] [--arch arm64|x64] [--stage-only]');return;}
    if(args[i]==='--stage-only'){stageOnly=true;continue;}
    if(!['--platform','--arch'].includes(args[i])||!args[i+1])throw new Error('未知或缺少打包参数');
    options[args[i].slice(2)]=args[++i];
  }
  if(stageOnly){const {stage,files}=await stageApplication(options);console.log(JSON.stringify({stage,files},null,2));}
  else await buildApplication(options);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
