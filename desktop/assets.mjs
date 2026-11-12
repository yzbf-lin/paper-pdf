import path from 'node:path';

const files=new Set(['/index.html','/style.css','/src/bootstrap.js','/src/app.js','/src/ink.js','/src/pdf.js',
  '/vendor/pdf.min.js','/vendor/pdf.worker.min.js','/vendor/pdf-lib.min.js']);
export function resolveAsset(url,root){
  const u=new URL(url);
  if(u.protocol!=='paper:'||u.hostname!=='app'||u.port||u.username||u.password)return null;
  const p=decodeURIComponent(u.pathname==='/'?'/index.html':u.pathname);
  if(!files.has(p))return null;
  return path.join(root,p.slice(1));
}
export const CSP="default-src 'none'; script-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self' blob: data:; connect-src 'self' blob: data:; worker-src 'self' blob:; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";
