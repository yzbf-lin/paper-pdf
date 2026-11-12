/* Adapted from ShizukuIchi/pdf-editor src/utils/PDF.js (MIT).
 * Keeps original PDF pages and draws vector ink; replaces pageHeight-y with the
 * inverse PDF.js viewport transform to support rotated and cropped pages.
 */
import {strokePath,toPdf} from './ink.js';

export async function exportPdf(originalBytes, pages, metadata) {
  const lib=window.PDFLib;
  const doc=await lib.PDFDocument.load(originalBytes.slice(), {updateMetadata:false});
  if(doc.getPageCount()!==pages.length)throw new Error('原始 PDF 页数不一致');
  for(let i=0;i<pages.length;i++) {
    const page=doc.getPage(i), transform=metadata[i].transform;
    const unit=Math.hypot(transform[0],transform[1]);
    for(const stroke of pages[i]) {
      const color=lib.rgb(...[1,3,5].map(n=>parseInt(stroke.color.slice(n,n+2),16)/255));
      if(stroke.points.length===1) {
        const p=toPdf(stroke.points[0],transform);
        page.drawCircle({x:p.x,y:p.y,size:stroke.width/(2*unit),color,borderWidth:0});
      } else {
        const path=strokePath(stroke.points,p=>{const q=toPdf(p,transform);return {x:q.x,y:-q.y};});
        page.pushOperators(lib.pushGraphicsState(),lib.setLineCap(lib.LineCapStyle.Round),lib.setLineJoin(lib.LineJoinStyle.Round));
        page.drawSvgPath(path,{x:0,y:0,borderWidth:stroke.width/unit,borderColor:color});
        page.pushOperators(lib.popGraphicsState());
      }
    }
  }
  return doc.save({addDefaultPage:false});
}
export async function download(data,name,type) {
  if(window.paperDesktop){
    const bytes=data instanceof Uint8Array?data:new TextEncoder().encode(data);
    return window.paperDesktop.saveFile(bytes,name,type);
  }
  const url=URL.createObjectURL(new Blob([data],{type}));
  const a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),30000);
  return true;
}
export function toBase64(bytes) {
  let s='';for(let i=0;i<bytes.length;i+=32768)s+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(s);
}
export function fromBase64(text) {
  if(typeof text!=='string'||text.length>150000000)throw new Error('草稿原文件无效或超过100 MB');
  return Uint8Array.from(atob(text),c=>c.charCodeAt(0));
}
