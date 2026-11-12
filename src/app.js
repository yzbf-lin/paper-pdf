import {strokePath,hitsStroke,History,validateInk} from './ink.js';
import {exportPdf,download,toBase64,fromBase64} from './pdf.js';

const $=id=>document.getElementById(id);
const svgNS='http://www.w3.org/2000/svg';
const state={pdf:null,bytes:null,name:'',metadata:[],ink:[],page:0,zoom:1,fit:true,
  tool:'pen',color:'#202b35',width:1.6,penOnly:false,history:new History(),revision:0,savedRevision:0,
  rendering:false,busy:false,space:false};
let gesture=null, renderTask=null, renderId=0, toastTimer=null, resizeTimer=null, opening=false;
const layer=$('ink-layer'), viewport=$('viewport');

function toast(message,error=false) {
  clearTimeout(toastTimer);$('toast').textContent=message;$('toast').classList.toggle('error',error);$('toast').hidden=false;
  toastTimer=setTimeout(()=>$('toast').hidden=true,error?9000:4500);
}
function busy(value,message='正在处理…') {
  state.busy=value;$('busy-text').textContent=message;$('busy').hidden=!value;updateControls();
}
function confirmAction(title,message) {
  const d=$('confirm-dialog');$('confirm-title').textContent=title;$('confirm-message').textContent=message;d.returnValue='';d.showModal();
  return new Promise(resolve=>d.addEventListener('close',()=>resolve(d.returnValue==='confirm'),{once:true}));
}
function markChanged() {
  state.revision++;$('save-state').textContent='有新笔迹 · 请保存草稿或导出 PDF';updateControls();updatePageList();
}
function updateControls() {
  const ready=!!state.pdf&&!state.busy;
  for(const id of ['save-draft','export-pdf','zoom-out','zoom-in','zoom-value','fit-width'])$(id).disabled=!ready;
  $('undo').disabled=!ready||!state.history.undoStack.length;
  $('redo').disabled=!ready||!state.history.redoStack.length;
  $('clear-page').disabled=!ready||!state.ink[state.page]?.length;
  $('zoom-value').textContent=`${Math.round(state.zoom*100)}%`;
  if($('prev-page')){$('prev-page').disabled=!ready||state.page===0;$('next-page').disabled=!ready||state.page===state.metadata.length-1;}
  $('page-status').textContent=state.pdf?`第 ${state.page+1} / ${state.metadata.length} 页 · ${state.ink[state.page].length} 笔`:'尚未打开文件';
}
function setTool(tool) {
  if(gesture)finishGesture(true);
  state.tool=tool;
  document.querySelectorAll('[data-tool]').forEach(b=>{if(b.tagName==='BUTTON'){b.classList.toggle('active',b.dataset.tool===tool);b.setAttribute('aria-pressed',String(b.dataset.tool===tool));}});
  updateCursor();
  $('tool-help').textContent={pen:'直接在纸面书写；按住空格可临时移动。',eraser:'橡皮会擦除碰到的整笔；原 PDF 内容保持不变。',pan:'拖动纸面查看；点击「手写」继续答题。'}[tool];
}
function updateCursor(){layer.dataset.tool=state.space?'pan':state.tool;}
function updatePageList() {
  const buttons=$('page-list').querySelectorAll('.page-item');
  buttons.forEach((b,i)=>{
    b.classList.toggle('active',i===state.page);b.setAttribute('aria-current',i===state.page?'page':'false');
    b.querySelector('.page-meta').textContent=state.ink[i].length?`${state.ink[i].length} 笔手写`:'未书写';
    b.querySelector('.has-ink').hidden=!state.ink[i].length;
  });updateControls();
}
function buildPageList() {
  $('page-list').replaceChildren();$('page-count').textContent=`${state.metadata.length} 页`;
  state.metadata.forEach((_,i)=>{
    const b=document.createElement('button');b.className='page-item';b.setAttribute('aria-label',`第 ${i+1} 页`);
    const n=document.createElement('span');n.className='page-number';n.textContent=String(i+1);
    const t=document.createElement('span');t.textContent=`第 ${i+1} 页`;
    const m=document.createElement('small');m.className='page-meta';t.append(m);
    const dot=document.createElement('span');dot.className='has-ink';dot.hidden=true;
    b.append(n,t,dot);b.addEventListener('click',()=>goPage(i));$('page-list').append(b);
  });updatePageList();
}
function svgStroke(stroke) {
  let el;
  if(stroke.points.length===1){el=document.createElementNS(svgNS,'circle');el.setAttribute('cx',stroke.points[0].x);el.setAttribute('cy',stroke.points[0].y);el.setAttribute('r',stroke.width/2);el.setAttribute('fill',stroke.color);}
  else {el=document.createElementNS(svgNS,'path');el.setAttribute('d',strokePath(stroke.points));el.setAttribute('fill','none');el.setAttribute('stroke',stroke.color);el.setAttribute('stroke-width',stroke.width);el.setAttribute('stroke-linecap','round');el.setAttribute('stroke-linejoin','round');}
  return el;
}
function paintInk() {
  $('strokes').replaceChildren(...(state.ink[state.page]||[]).map(svgStroke));
}
function paintPreview() {
  $('preview').replaceChildren();if(gesture?.kind==='pen')$('preview').append(svgStroke(gesture.stroke));
}
function pointAt(event) {
  const r=layer.getBoundingClientRect(),m=state.metadata[state.page];
  return {x:Math.max(0,Math.min(m.width,(event.clientX-r.left)*m.width/r.width)),y:Math.max(0,Math.min(m.height,(event.clientY-r.top)*m.height/r.height))};
}
function eraseAt(point) {
  const radius=8/state.zoom;
  state.ink[state.page]=state.ink[state.page].filter(s=>!hitsStroke(point,s,radius));paintInk();
}
layer.addEventListener('pointerdown',event=>{
  if(!state.pdf||state.rendering||state.busy||gesture||event.button!==0)return;
  const kind=state.space?'pan':state.tool;
  if(kind!=='pan'&&state.penOnly&&event.pointerType!=='pen')return;
  event.preventDefault();layer.setPointerCapture(event.pointerId);
  if(kind==='pan'){gesture={kind,id:event.pointerId,x:event.clientX,y:event.clientY,left:viewport.scrollLeft,top:viewport.scrollTop};return;}
  const p=pointAt(event);
  gesture={kind,id:event.pointerId,before:state.ink[state.page],page:state.page};
  if(kind==='pen'){gesture.stroke={color:state.color,width:state.width,points:[p]};paintPreview();}
  else eraseAt(p);
});
layer.addEventListener('pointermove',event=>{
  if(!gesture||gesture.id!==event.pointerId)return;
  event.preventDefault();
  if(gesture.kind==='pan'){viewport.scrollLeft=gesture.left-(event.clientX-gesture.x);viewport.scrollTop=gesture.top-(event.clientY-gesture.y);return;}
  const events=event.getCoalescedEvents?.();
  for(const e of events?.length?events:[event]){
    const p=pointAt(e);
    if(gesture.kind==='eraser')eraseAt(p);
    else {const prev=gesture.stroke.points.at(-1);if(Math.hypot(p.x-prev.x,p.y-prev.y)>.12)gesture.stroke.points.push(p);}
  }
  if(gesture.kind==='pen')paintPreview();
});
layer.addEventListener('pointerup',event=>{
  if(gesture?.id!==event.pointerId)return;
  if(gesture.kind==='pen'){
    const p=pointAt(event),prev=gesture.stroke.points.at(-1);
    if(Math.hypot(p.x-prev.x,p.y-prev.y)>.12)gesture.stroke.points.push(p);
  }
  finishGesture(false);
});
layer.addEventListener('pointercancel',event=>{if(gesture?.id===event.pointerId)finishGesture(true);});
layer.addEventListener('lostpointercapture',event=>{if(gesture?.id===event.pointerId)finishGesture(true);});
function finishGesture(cancel) {
  if(!gesture)return;
  const g=gesture;gesture=null;
  if(layer.hasPointerCapture(g.id))layer.releasePointerCapture(g.id);
  if(g.kind==='pan')return;
  if(cancel)state.ink[g.page]=g.before;
  else {
    if(g.kind==='pen')state.ink[g.page]=[...g.before,g.stroke];
    if(g.kind==='pen'||state.ink[g.page].length!==g.before.length){state.history.push(g.page,g.before,state.ink[g.page]);markChanged();}
  }
  $('preview').replaceChildren();paintInk();
}

async function renderPage(resetScroll=false) {
  if(!state.pdf)return;
  finishGesture(true);const seq=++renderId;
  renderTask?.cancel();state.rendering=true;$('paper').setAttribute('aria-busy','true');
  try {
    const page=await state.pdf.getPage(state.page+1);if(seq!==renderId)return;
    const m=state.metadata[state.page];
    if(state.fit)state.zoom=Math.max(.2,Math.min(2,(viewport.clientWidth-(innerWidth<=640?26:74))/m.width));
    const w=m.width*state.zoom,h=m.height*state.zoom;
    $('paper').style.width=`${w}px`;$('paper').style.height=`${h}px`;
    layer.setAttribute('viewBox',`0 0 ${m.width} ${m.height}`);
    const canvas=$('pdf-canvas');
    const ratio=Math.min(window.devicePixelRatio||1,2,6000/Math.max(w,h));
    canvas.width=Math.ceil(w*ratio);canvas.height=Math.ceil(h*ratio);
    const view=page.getViewport({scale:state.zoom});
    paintInk();updateControls();
    renderTask=page.render({canvasContext:canvas.getContext('2d'),viewport:view,transform:ratio===1?null:[ratio,0,0,ratio,0,0]});
    await renderTask.promise;
    if(seq===renderId){state.rendering=false;$('paper').setAttribute('aria-busy','false');renderTask=null;if(resetScroll){viewport.scrollTop=0;viewport.scrollLeft=0;}}
  }catch(error){if(error.name!=='RenderingCancelledException'&&seq===renderId){toast(`页面显示失败：${error.message}`,true);state.rendering=false;$('paper').setAttribute('aria-busy','false');}}
}
async function goPage(index) {
  if(!state.pdf||state.busy||index<0||index>=state.metadata.length||index===state.page)return;
  finishGesture(true);state.page=index;updatePageList();await renderPage(true);
}
function zoomBy(factor){if(!state.pdf)return;state.fit=false;state.zoom=Math.max(.2,Math.min(4,state.zoom*factor));renderPage();}
async function historyAction(redo=false) {
  if(state.busy||gesture)return;
  const a=redo?state.history.redo():state.history.undo();if(!a)return;
  state.ink[a.page]=redo?a.after:a.before;
  const changedPage=state.page!==a.page;state.page=a.page;
  markChanged();paintInk();if(changedPage)await renderPage(true);
}
async function openFile(file,isDraft=false) {
  if(!file||state.busy||opening)return;
  if(file.size>150000000){toast('文件过大，请使用100 MB以内的 PDF 或对应草稿。',true);return;}
  opening=true;
  try {
  if(state.revision!==state.savedRevision&&!await confirmAction('打开另一份文件？','当前笔迹尚未保存。请先取消并保存草稿，或继续放弃当前未保存的修改。'))return;
  finishGesture(true);busy(true,isDraft?'正在恢复草稿…':'正在打开 PDF…');
  let candidate=null;
  try {
    let bytes,ink,name,draft;
    if(isDraft){
      draft=JSON.parse(await file.text());
      if(draft.format!=='local-pdf-handwriting'||draft.version!==1||typeof draft.filename!=='string')throw new Error('不是有效的纸上草稿');
      bytes=fromBase64(draft.pdf);name=draft.filename;
    }else{bytes=new Uint8Array(await file.arrayBuffer());name=file.name;}
    if(bytes.length>100000000)throw new Error('原始 PDF 超过100 MB，请先拆分文件');
    if(!new TextDecoder('latin1').decode(bytes.subarray(0,1024)).includes('%PDF-'))throw new Error('文件不是有效的 PDF');
    candidate=await window.pdfjsLib.getDocument({data:bytes.slice(),isEvalSupported:false,disableAutoFetch:true}).promise;
    const metadata=[];
    for(let i=1;i<=candidate.numPages;i++){
      const p=await candidate.getPage(i),v=p.getViewport({scale:1});
      metadata.push({width:v.width,height:v.height,transform:[...v.transform]});
    }
    ink=isDraft?validateInk(draft.ink,metadata):metadata.map(()=>[]);
    // Only replace the current document after parsing and validating the entire draft.
    renderId++;renderTask?.cancel();renderTask=null;
    const previous=state.pdf;
    state.pdf=candidate;state.bytes=bytes;state.name=name;state.metadata=metadata;state.ink=ink;state.page=0;
    state.history=new History();state.revision=0;state.savedRevision=0;state.fit=true;
    $('file-name').textContent=name;$('file-name').title=name;
    $('save-state').textContent=isDraft?'草稿已恢复 · 可继续编辑笔迹':'文件已打开 · 原件不会被改写';
    $('welcome').hidden=true;$('paper-wrap').hidden=false;
    buildPageList();await renderPage(true);previous?.destroy();
    toast(isDraft?'草稿已恢复，可以继续答题。':'已打开 PDF，在纸面直接书写即可。');
    return true;
  }catch(error){
    if(candidate&&candidate!==state.pdf)candidate.destroy();
    toast(error.name==='PasswordException'?'暂不支持加密 PDF，请先用密码解锁并保存副本。':`打开失败：${error.message}`,true);
  }finally{busy(false);}
  }finally{opening=false;}
}
function baseName(){return state.name.replace(/\.pdf$/i,'').replace(/[\\/:*?"<>|]/g,'_')||'答卷';}
async function saveDraft() {
  if(!state.pdf||state.busy)return;finishGesture(false);busy(true,'正在保存可编辑草稿…');
  try{
    const data={format:'local-pdf-handwriting',version:1,filename:state.name,pdf:toBase64(state.bytes),ink:state.ink};
    if(!await download(JSON.stringify(data),`${baseName()}.pdfink`,'application/json'))return;
    state.savedRevision=state.revision;$('save-state').textContent='已保存草稿 · 下次打开草稿即可继续';toast('草稿已保存，包含原 PDF 和可编辑笔迹。');
  }catch(error){toast(`保存草稿失败：${error.message}`,true);}finally{busy(false);}
}
async function savePdf() {
  if(!state.pdf||state.busy)return;finishGesture(false);busy(true,'正在将手写笔迹写入 PDF…');
  try{
    const bytes=await exportPdf(state.bytes,state.ink,state.metadata);
    if(!await download(bytes,`${baseName()}_手写答卷.pdf`,'application/pdf'))return;
    state.savedRevision=state.revision;$('save-state').textContent='已导出 PDF · 继续编辑请另存草稿';toast('答卷已导出。若要日后擦除或修改笔迹，请再保存草稿。');
  }catch(error){toast(`导出失败：${error.message}`,true);}finally{busy(false);}
}

$('open-pdf').addEventListener('click',()=>$('pdf-file').click());
$('welcome-open').addEventListener('click',()=>$('pdf-file').click());
$('open-draft').addEventListener('click',()=>$('draft-file').click());
$('pdf-file').addEventListener('change',e=>{openFile(e.target.files[0]);e.target.value='';});
$('draft-file').addEventListener('change',e=>{openFile(e.target.files[0],true);e.target.value='';});
$('save-draft').addEventListener('click',saveDraft);$('export-pdf').addEventListener('click',savePdf);
document.querySelectorAll('button[data-tool]').forEach(b=>b.addEventListener('click',()=>setTool(b.dataset.tool)));
document.querySelectorAll('[data-color]').forEach(b=>b.addEventListener('click',()=>{
  state.color=b.dataset.color;document.querySelectorAll('[data-color]').forEach(n=>{n.classList.toggle('active',n===b);n.setAttribute('aria-pressed',String(n===b));});
}));
$('pen-width').addEventListener('input',e=>{state.width=Number(e.target.value);$('width-value').textContent=state.width.toFixed(1);});
$('pen-only').addEventListener('change',e=>{state.penOnly=e.target.checked;toast(state.penOnly?'仅接受手写笔；手指和鼠标不会留下笔迹。':'允许鼠标、手指和手写笔书写。');});
$('undo').addEventListener('click',()=>historyAction());$('redo').addEventListener('click',()=>historyAction(true));
$('zoom-in').addEventListener('click',()=>zoomBy(1.2));$('zoom-out').addEventListener('click',()=>zoomBy(1/1.2));
for(const id of ['fit-width','zoom-value'])$(id).addEventListener('click',()=>{state.fit=true;renderPage();});
$('clear-page').addEventListener('click',async()=>{
  if(!state.ink[state.page]?.length||!await confirmAction('清空这一页的笔迹？','只清除当前页面新增的手写内容，原 PDF 保留。清空后仍可撤销。'))return;
  state.history.push(state.page,state.ink[state.page],[]);state.ink[state.page]=[];markChanged();paintInk();
});
document.addEventListener('keydown',e=>{
  if(e.target.matches('input,textarea,select')||document.querySelector('dialog[open]')||state.busy)return;
  const mod=e.ctrlKey||e.metaKey;
  if(mod&&e.key.toLowerCase()==='z'){e.preventDefault();historyAction(e.shiftKey);}
  else if(mod&&e.key.toLowerCase()==='y'){e.preventDefault();historyAction(true);}
  else if(mod&&e.key.toLowerCase()==='s'){e.preventDefault();saveDraft();}
  else if(e.code==='Space'){e.preventDefault();state.space=true;updateCursor();}
  else if(!mod&&['p','e','h'].includes(e.key.toLowerCase()))setTool({p:'pen',e:'eraser',h:'pan'}[e.key.toLowerCase()]);
  else if(e.key==='ArrowRight'||e.key==='PageDown'){e.preventDefault();goPage(state.page+1);}
  else if(e.key==='ArrowLeft'||e.key==='PageUp'){e.preventDefault();goPage(state.page-1);}
});
document.addEventListener('keyup',e=>{if(e.code==='Space'){state.space=false;updateCursor();}});
window.addEventListener('blur',()=>{state.space=false;updateCursor();finishGesture(true);});
window.addEventListener('beforeunload',e=>{if(state.revision!==state.savedRevision){e.preventDefault();e.returnValue='';}});
window.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{if(state.fit&&!state.busy)renderPage();},150);});
let dragDepth=0;
document.addEventListener('dragenter',e=>{if(e.dataTransfer?.types.includes('Files')){e.preventDefault();dragDepth++;$('drop-overlay').hidden=false;}});
document.addEventListener('dragover',e=>{if(e.dataTransfer?.types.includes('Files')){e.preventDefault();e.dataTransfer.dropEffect='copy';}});
document.addEventListener('dragleave',()=>{if(--dragDepth<=0){dragDepth=0;$('drop-overlay').hidden=true;}});
document.addEventListener('drop',e=>{e.preventDefault();dragDepth=0;$('drop-overlay').hidden=true;const f=e.dataTransfer.files[0];if(f)openFile(f,/\.(json|pdfink)$/i.test(f.name));});

async function importWord(){
  if(!window.paperDesktop||state.busy||opening)return;
  finishGesture(true);busy(true,'正在本机转换 Word，请稍候…');
  let result;
  try{result=await window.paperDesktop.importWord();}
  catch(e){toast(e.message,true);}
  finally{busy(false);}
  if(result){
    if(await openFile(new File([result.bytes],result.filename,{type:'application/pdf'})))toast('Word 已转成 PDF。请检查分页、表格和字体，再开始手写。');
  }
}
async function showUpdates(manual=true){
  if(!window.paperDesktop)return;
  const d=$('update-dialog');
  if(manual){$('update-status').textContent='正在检查新版本…';$('update-notes').textContent='';$('update-download').hidden=true;$('update-release').hidden=true;if(!d.open)d.showModal();}
  try{
    const result=await window.paperDesktop.checkUpdate();
    const available=result.status==='available';
    $('check-update').textContent=available?`发现 v${result.version}`:'检查更新';
    if(manual){
      $('update-status').textContent=available?`可更新至 v${result.version}（当前 v${result.currentVersion}）`:result.status==='unsupported'?`发现 v${result.version}，此平台请查看发布页。`:`已是最新版本 v${result.currentVersion}`;
      $('update-notes').textContent=available?`${result.notes||''}\n下载后请保存当前草稿，退出工具再替换应用。`:'';
      $('update-download').hidden=!available;$('update-release').hidden=result.status==='up_to_date';
    }else if(available)toast(`发现新版本 v${result.version}，点击「检查更新」下载。`);
  }catch(e){if(manual){$('update-status').textContent=`检查更新失败：${e.message}`;$('update-release').hidden=false;}}
}
if(window.paperDesktop){
  $('import-word').hidden=false;$('check-update').hidden=false;$('app-version').hidden=false;
  window.paperDesktop.info().then(info=>$('app-version').textContent=`桌面版 v${info.version}`).catch(()=>{});
  $('import-word').addEventListener('click',importWord);
  $('check-update').addEventListener('click',()=>showUpdates());
  $('update-close').addEventListener('click',()=>$('update-dialog').close());
  $('update-release').addEventListener('click',()=>window.paperDesktop.openRelease().catch(e=>toast(e.message,true)));
  $('update-download').addEventListener('click',async()=>{
    $('update-download').disabled=true;$('update-status').textContent='正在下载并校验新版安装包…';
    try{const saved=await window.paperDesktop.downloadUpdate();$('update-status').textContent=saved?'已下载并通过校验。保存草稿后退出工具，再安装新版。':'已取消下载。';}
    catch(e){$('update-status').textContent=`下载失败：${e.message}`;}
    finally{$('update-download').disabled=false;}
  });
  window.paperDesktop.onCommand(cmd=>{
    if(cmd==='update')showUpdates();
    else if(cmd==='converter')window.paperDesktop.configureConverter().then(r=>{if(r)toast('Word 转换程序已配置。');}).catch(e=>toast(e.message,true));
    else if(cmd==='word')importWord();
    else if(!state.busy&&!opening){({open:()=>$('pdf-file').click(),draft:()=>$('draft-file').click(),save:saveDraft,export:savePdf,undo:()=>historyAction(),redo:()=>historyAction(true)})[cmd]?.();}
  });
  setTimeout(()=>showUpdates(false),3500);
}

// Page navigation remains usable on small screens where the sidebar is hidden.
const nav=document.createElement('div');nav.className='page-navigation';
const prev=document.createElement('button');prev.id='prev-page';prev.textContent='‹';prev.setAttribute('aria-label','上一页');prev.disabled=true;prev.addEventListener('click',()=>goPage(state.page-1));
const next=document.createElement('button');next.id='next-page';next.textContent='›';next.setAttribute('aria-label','下一页');next.disabled=true;next.addEventListener('click',()=>goPage(state.page+1));
const statusNode=$('page-status');statusNode.replaceWith(nav);nav.append(prev,statusNode,next);
setTool('pen');updateControls();
try {
  if(!window.pdfjsLib||!window.PDFLib)throw new Error('本地 PDF 组件缺失');
  const r=await fetch('/vendor/pdf.worker.min.js');if(!r.ok)throw new Error('本地 PDF worker 缺失');
  window.pdfjsLib.GlobalWorkerOptions.workerSrc=URL.createObjectURL(new Blob(['var regeneratorRuntime;\n',await r.arrayBuffer()],{type:'application/javascript'}));
  document.documentElement.dataset.ready='true';
}catch(error){toast(`启动失败：${error.message}。请使用启动脚本打开本工具。`,true);}
