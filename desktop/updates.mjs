import {createHash, createPublicKey, randomUUID, verify} from 'node:crypto';
import {open, rename, unlink} from 'node:fs/promises';
import {basename, dirname, join} from 'node:path';

// Release protocol follows service-console: signed JSON first, package hash second.
export const REPOSITORY = 'yzbf-lin/paper-pdf';
export const MAX_PACKAGE_BYTES = 512 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const RELEASES = `https://github.com/${REPOSITORY}/releases`;
const DOWNLOAD_HOSTS = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);

export function parseVersion(value) {
  if(typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
    throw new Error('更新版本号必须使用 X.Y.Z 格式');
  }
  const parts = value.split('.').map(Number);
  if(!parts.every(Number.isSafeInteger))throw new Error('更新版本号超出范围');
  return parts;
}

function compareVersions(left, right) {
  const a = parseVersion(left), b = parseVersion(right);
  for(let i=0;i<3;i++)if(a[i]!==b[i])return a[i]>b[i]?1:-1;
  return 0;
}

function platformKey(platform, arch) {
  if(platform==='darwin' && arch==='arm64')return 'darwin-arm64';
  if(platform==='win32' && arch==='x64')return 'windows-x86_64';
  return `${platform}-${arch}`;
}

function checkedAsset(value, version) {
  if(!value || typeof value!=='object' || Array.isArray(value))throw new Error('更新安装包信息无效');
  const {filename, url, sha256, size} = value;
  if(typeof filename!=='string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,180}\.zip$/.test(filename) || filename.includes('..')) {
    throw new Error('更新安装包文件名无效');
  }
  if(typeof sha256!=='string' || !/^[a-f0-9]{64}$/.test(sha256))throw new Error('更新安装包校验值无效');
  if(!Number.isSafeInteger(size) || size<=0 || size>MAX_PACKAGE_BYTES)throw new Error('更新安装包大小无效或超过 512 MB');
  if(!version) {
    const match = typeof url==='string' && url.match(/^https:\/\/github\.com\/yzbf-lin\/paper-pdf\/releases\/download\/v([^/]+)\/[^/]+$/);
    if(!match)throw new Error('更新安装包地址不可信');
    version = match[1];
    parseVersion(version);
  }
  if(url!==`${RELEASES}/download/v${version}/${filename}`)throw new Error('更新安装包地址与版本不匹配');
  if(!filename.startsWith(`Paper-PDF-v${version}-`))throw new Error('更新安装包名称与版本不匹配');
  return Object.freeze({filename,url,sha256,size});
}

export function verifyManifest(rawBytes, signatureBase64, publicKey, {
  currentVersion, platform=process.platform, arch=process.arch
}={}) {
  parseVersion(currentVersion);
  if(!(rawBytes instanceof Uint8Array) || rawBytes.byteLength===0 || rawBytes.byteLength>MAX_MANIFEST_BYTES) {
    throw new Error('更新清单为空或过大');
  }
  const signature = typeof signatureBase64==='string' ? signatureBase64.trim() : '';
  if(!/^[A-Za-z0-9+/]{86}==$/.test(signature))throw new Error('更新清单签名格式无效');
  const signatureBytes = Buffer.from(signature,'base64');
  if(signatureBytes.toString('base64')!==signature)throw new Error('更新清单签名格式无效');
  let key;
  try { key = createPublicKey(publicKey); }
  catch { throw new Error('内置更新公钥无效'); }
  if(key.asymmetricKeyType!=='ed25519')throw new Error('内置更新公钥必须是 Ed25519');
  if(!verify(null,rawBytes,key,signatureBytes))throw new Error('更新清单签名验证失败');
  let data;
  try { data = JSON.parse(Buffer.from(rawBytes).toString('utf8')); }
  catch { throw new Error('更新清单不是有效 JSON'); }
  if(!data || data.schema!==1)throw new Error('不支持此更新清单格式');
  parseVersion(data.version);
  if(data.release_url!==`${RELEASES}/tag/v${data.version}`)throw new Error('更新发布页地址不可信');
  if(typeof data.published_at!=='string' || !Number.isFinite(Date.parse(data.published_at)))throw new Error('更新发布日期无效');
  if(typeof data.notes!=='string' || data.notes.length>8000)throw new Error('更新说明无效或过长');
  if(!data.platforms || typeof data.platforms!=='object' || Array.isArray(data.platforms))throw new Error('更新平台列表无效');
  const assets = Object.fromEntries(Object.entries(data.platforms).map(([key,value])=>[key,checkedAsset(value,data.version)]));
  const result = {version:data.version,currentVersion,releaseUrl:data.release_url,notes:data.notes};
  if(compareVersions(data.version,currentVersion)<=0)return {...result,status:'up_to_date'};
  const asset = assets[platformKey(platform,arch)];
  return asset ? {...result,status:'available',asset} : {...result,status:'unsupported'};
}

function checkedNetworkURL(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('更新下载地址无效'); }
  if(url.protocol!=='https:' || !DOWNLOAD_HOSTS.has(url.hostname) || url.port || url.username || url.password || url.hash) {
    throw new Error('更新下载地址不可信');
  }
  return url;
}

async function fetchTrusted(url, {fetchImpl,signal}) {
  let current = checkedNetworkURL(url);
  for(let redirects=0;redirects<=5;redirects++) {
    const response = await fetchImpl(current.href,{
      method:'GET',redirect:'manual',signal,cache:'no-store',
      headers:{'User-Agent':'Paper-PDF-Updater','Accept':'application/octet-stream'}
    });
    if([301,302,303,307,308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if(!location)throw new Error('更新下载重定向无效');
      current = checkedNetworkURL(new URL(location,current).href);
      continue;
    }
    if(!response.ok) {
      await response.body?.cancel();
      throw new Error(`更新服务暂不可用（HTTP ${response.status}）`);
    }
    return response;
  }
  throw new Error('更新下载重定向次数过多');
}

function declaredSize(response) {
  const value = response.headers.get('content-length');
  if(value===null)return null;
  if(!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))throw new Error('更新响应大小无效');
  return Number(value);
}

async function readLimited(response, limit) {
  if((declaredSize(response)??0)>limit) {
    await response.body?.cancel();throw new Error('更新响应超过大小限制');
  }
  if(!response.body)throw new Error('更新响应为空');
  const chunks=[];let size=0;
  for await(const chunk of response.body) {
    size+=chunk.byteLength;
    if(size>limit)throw new Error('更新响应超过大小限制');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks,size);
}

export async function checkForUpdate({publicKey,currentVersion,platform=process.platform,arch=process.arch,fetchImpl=globalThis.fetch,timeoutMs=15000}={}) {
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(),timeoutMs);
  try {
    const [raw,signature] = await Promise.all([
      fetchTrusted(`${RELEASES}/latest/download/latest-update.json`,{fetchImpl,signal:controller.signal}).then(r=>readLimited(r,MAX_MANIFEST_BYTES)),
      fetchTrusted(`${RELEASES}/latest/download/latest-update.json.sig`,{fetchImpl,signal:controller.signal}).then(r=>readLimited(r,1024))
    ]);
    return verifyManifest(raw,signature.toString('utf8'),publicKey,{currentVersion,platform,arch});
  } catch(error) {
    if(controller.signal.aborted)throw new Error('检查更新超时，请稍后重试');
    throw error;
  } finally { clearTimeout(timer);controller.abort(); }
}

export async function downloadVerified(value, destination, {fetchImpl=globalThis.fetch,timeoutMs=10*60*1000}={}) {
  const asset = checkedAsset(value);
  if(typeof destination!=='string' || !destination || basename(destination)==='.')throw new Error('请选择有效保存位置');
  const temporary = join(dirname(destination),`.paper-pdf-update-${randomUUID()}.tmp`);
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(),timeoutMs);
  let file;
  try {
    const response = await fetchTrusted(asset.url,{fetchImpl,signal:controller.signal});
    if((declaredSize(response)??0)>asset.size) {
      await response.body?.cancel();throw new Error('更新安装包大小与清单不符');
    }
    if(!response.body)throw new Error('更新安装包为空');
    file = await open(temporary,'wx',0o600);
    const hash = createHash('sha256');let size=0;
    for await(const chunk of response.body) {
      size+=chunk.byteLength;
      if(size>asset.size)throw new Error('更新安装包大小与清单不符');
      hash.update(chunk);await file.writeFile(chunk);
    }
    if(size!==asset.size)throw new Error('更新安装包大小与清单不符');
    const sha256=hash.digest('hex');
    if(sha256!==asset.sha256)throw new Error('更新安装包校验失败，请重新下载');
    await file.sync();await file.close();file=null;
    await rename(temporary,destination);
    return {path:destination,size,sha256};
  } catch(error) {
    if(controller.signal.aborted)throw new Error('下载更新超时，请稍后重试');
    throw error;
  } finally {
    clearTimeout(timer);controller.abort();await file?.close();
    await unlink(temporary).catch(()=>{});
  }
}
