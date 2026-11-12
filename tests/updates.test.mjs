import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {MAX_PACKAGE_BYTES,REPOSITORY,verifyManifest,checkForUpdate,downloadVerified} from '../desktop/updates.mjs';
import {buildManifest} from '../scripts/release-manifest.mjs';

const pair=generateKeyPairSync('ed25519');
const privateKey=pair.privateKey.export({type:'pkcs8',format:'pem'});
const publicKey=pair.publicKey.export({type:'spki',format:'pem'});
const archive=Buffer.from('Synthetic test ZIP payload; integrity checking is format-independent.');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const release=`https://github.com/${REPOSITORY}/releases`;
const options={currentVersion:'0.1.0',platform:'darwin',arch:'arm64'};
function asset(version='0.2.0',suffix='macOS-arm64') {
  const filename=`Paper-PDF-v${version}-${suffix}.zip`;
  return {filename,url:`${release}/download/v${version}/${filename}`,sha256:hash(archive),size:archive.length};
}
function fixture(version='0.2.0') {
  return {schema:1,version,release_url:`${release}/tag/v${version}`,published_at:'2026-11-12T00:00:00Z',notes:'测试更新',platforms:{'darwin-arm64':asset(version),'windows-x86_64':asset(version,'Windows-x64')}};
}
function signed(data) {
  const raw=Buffer.isBuffer(data)?data:Buffer.from(JSON.stringify(data)+'\n');
  return [raw,sign(null,raw,privateKey).toString('base64')];
}
function verify(data,custom=options) { return verifyManifest(...signed(data),publicKey,custom); }
async function temporary(t) {
  const dir=await mkdtemp(join(tmpdir(),'paper-pdf-updates-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));return dir;
}

test('signed manifest selects macOS/Windows assets and compares numeric stable versions',()=>{
  const data=fixture('0.10.0');
  const mac=verify(data,{...options,currentVersion:'0.9.9'});
  assert.equal(mac.status,'available');assert.equal(mac.asset.filename,'Paper-PDF-v0.10.0-macOS-arm64.zip');
  const win=verify(data,{...options,platform:'win32',arch:'x64'});
  assert.equal(win.asset.filename,'Paper-PDF-v0.10.0-Windows-x64.zip');
  assert.equal(verify(data,{...options,currentVersion:'0.10.0'}).status,'up_to_date');
  assert.equal(verify(data,{...options,currentVersion:'1.0.0'}).status,'up_to_date');
  assert.equal(verify(data,{...options,platform:'linux',arch:'x64'}).status,'unsupported');
  const missing=fixture();delete missing.platforms['darwin-arm64'];
  assert.equal(verify(missing).status,'unsupported');
});

test('signature verification rejects modified raw bytes before parsing JSON or trusting URLs',()=>{
  const [raw,signature]=signed(fixture());
  const tampered=Buffer.from(raw);tampered[0]=33;
  assert.throws(()=>verifyManifest(tampered,signature,publicKey,options),/签名验证失败/);
  assert.throws(()=>verifyManifest(raw,signature.replace(/.$/,'!'),publicKey,options),/签名格式/);
  const different=generateKeyPairSync('ed25519').publicKey.export({format:'pem',type:'spki'});
  assert.throws(()=>verifyManifest(raw,signature,different,options),/签名验证失败/);
  assert.throws(()=>verify(Buffer.from('{bad-json')),/JSON/);
  assert.throws(()=>verifyManifest(Buffer.alloc(65537),signature,publicKey,options),/过大/);
});

test('signed but invalid manifest versions, metadata, platform fields and release URLs are rejected',()=>{
  for(const version of ['01.0.0','1.2','v1.0.0','1.0.0-beta','1.0.0+build','9007199254740992.0.0']) {
    assert.throws(()=>verify(fixture(version)),/版本号/);
  }
  assert.throws(()=>verify(fixture(),{...options,currentVersion:'broken'}),/版本号/);
  for(const change of [
    {schema:2},{release_url:'https://github.com/evil/paper-pdf/releases/tag/v0.2.0'},
    {release_url:`${release}/tag/v0.2.0?next=evil`},{published_at:'never'},
    {notes:'x'.repeat(8001)},{platforms:[]}
  ])assert.throws(()=>verify({...fixture(),...change}));
});

test('signed assets reject path traversal, wrong hashes, excessive sizes and URL/version escapes',()=>{
  for(const change of [
    {filename:'../escape.zip'}, {filename:'C:\\escape.zip'}, {filename:'folder/escape.zip'},
    {sha256:'not-a-hash'}, {size:0}, {size:-1}, {size:MAX_PACKAGE_BYTES+1}, {size:1.5},
    {url:'http://github.com/yzbf-lin/paper-pdf/releases/download/v0.2.0/file.zip'},
    {url:`https://github.com.evil.test/${REPOSITORY}/releases/download/v0.2.0/file.zip`},
    {url:asset('0.3.0').url}, {filename:'Paper-PDF-v0.1.0-macOS-arm64.zip'},
    {url:asset().url+'?redirect=https://evil.test'}, {url:asset().url+'#fragment'}
  ]) {
    const data=fixture();data.platforms['darwin-arm64']={...asset(),...change};
    assert.throws(()=>verify(data));
  }
});

test('online check follows trusted redirects and validates the exact signed payload',async()=>{
  const [raw,signature]=signed(fixture()),requests=[];
  const fetchImpl=async(url,init)=>{
    requests.push(url);assert.equal(init.redirect,'manual');assert.equal(init.method,'GET');
    if(url.includes('/latest/download/'))return new Response(null,{status:302,headers:{location:url.replace('/latest/download/','/download/v0.2.0/')}});
    if(url.endsWith('.sig'))return new Response(signature+'\n');
    return new Response(raw);
  };
  const result=await checkForUpdate({publicKey,...options,fetchImpl});
  assert.equal(result.status,'available');assert.equal(requests.length,4);
});

test('online check rejects hostile redirects, HTTP failures, network failures and oversized responses',async()=>{
  for(const location of ['http://github.com/test','https://evil.test/asset','https://github.com:444/asset','https://user:pass@github.com/asset']) {
    await assert.rejects(checkForUpdate({publicKey,...options,fetchImpl:async()=>new Response(null,{status:302,headers:{location}})}),/不可信/);
  }
  await assert.rejects(checkForUpdate({publicKey,...options,fetchImpl:async()=>new Response('',{status:404})}),/HTTP 404/);
  await assert.rejects(checkForUpdate({publicKey,...options,fetchImpl:async()=>{throw new Error('offline');}}),/offline/);
  await assert.rejects(checkForUpdate({publicKey,...options,fetchImpl:async()=>new Response('x'.repeat(65537))}),/大小限制/);
  await assert.rejects(checkForUpdate({publicKey,...options,fetchImpl:async()=>new Response('small',{headers:{'content-length':'999999'}})}),/大小限制/);
});

test('online check cancels a stalled request after its deadline',async()=>{
  const fetchImpl=(url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));
  await assert.rejects(checkForUpdate({publicKey,...options,fetchImpl,timeoutMs:10}),/超时/);
});

test('verified download writes the package only after size and hash match',async(t)=>{
  const dir=await temporary(t),destination=join(dir,'update.zip');
  await writeFile(destination,'previous file');
  let requests=0;
  const fetchImpl=async(url)=>{
    requests++;
    if(requests===1)return new Response(null,{status:302,headers:{location:'https://release-assets.githubusercontent.com/test/download?token=public-fixture'}});
    return new Response(archive,{headers:{'content-length':String(archive.length)}});
  };
  const result=await downloadVerified(asset(),destination,{fetchImpl});
  assert.deepEqual(await readFile(destination),archive);
  assert.deepEqual(result,{path:destination,size:archive.length,sha256:hash(archive)});
  assert.deepEqual(await readdir(dir),['update.zip']);
});

test('failed downloads preserve an existing file and clean partial package files',async(t)=>{
  const dir=await temporary(t),destination=join(dir,'update.zip');
  await writeFile(destination,'existing');
  for(const bytes of [Buffer.from('short'),Buffer.alloc(archive.length,1),Buffer.alloc(archive.length+1,1)]) {
    await assert.rejects(downloadVerified(asset(),destination,{fetchImpl:async()=>new Response(bytes)}),/大小|校验失败/);
    assert.equal(await readFile(destination,'utf8'),'existing');
    assert.deepEqual(await readdir(dir),['update.zip']);
  }
  await assert.rejects(downloadVerified(asset(),destination,{fetchImpl:async()=>{throw new Error('offline');}}),/offline/);
  await assert.rejects(downloadVerified(asset(),destination,{fetchImpl:async()=>new Response(null,{status:302,headers:{location:'https://evil.test/asset'}})}),/不可信/);
  assert.deepEqual(await readdir(dir),['update.zip']);
});

test('streamed packages preserve chunk order and interrupted streams leave no partial download',async(t)=>{
  const dir=await temporary(t),destination=join(dir,'update.zip');
  const stream=()=>new ReadableStream({start(controller){
    controller.enqueue(archive.subarray(0,9));controller.enqueue(archive.subarray(9,31));
    controller.enqueue(archive.subarray(31));controller.close();
  }});
  await downloadVerified(asset(),destination,{fetchImpl:async()=>new Response(stream())});
  assert.deepEqual(await readFile(destination),archive);
  const stalled=(url,{signal})=>Promise.resolve(new Response(new ReadableStream({start(controller){
    controller.enqueue(archive.subarray(0,9));
    signal.addEventListener('abort',()=>controller.error(new Error('aborted')),{once:true});
  }})));
  await assert.rejects(downloadVerified(asset(),destination,{fetchImpl:stalled,timeoutMs:10}),/超时/);
  assert.deepEqual(await readFile(destination),archive);
  assert.deepEqual(await readdir(dir),['update.zip']);
});

test('release generator signs both real artifact bytes and emits matching checksums',async(t)=>{
  const releaseDir=await temporary(t),version='0.1.0';
  for(const suffix of ['macOS-arm64','Windows-x64'])await writeFile(join(releaseDir,`Paper-PDF-v${version}-${suffix}.zip`),archive);
  const manifest=await buildManifest({version,releaseDir,privateKey,publicKey,notes:'First release',publishedAt:'2026-11-12T00:00:00Z'});
  assert.equal(Object.keys(manifest.platforms).length,2);
  const raw=await readFile(join(releaseDir,'latest-update.json'));
  const signature=await readFile(join(releaseDir,'latest-update.json.sig'),'utf8');
  assert.equal(verifyManifest(raw,signature,publicKey,{...options,currentVersion:'0.0.9'}).status,'available');
  const sums=await readFile(join(releaseDir,'SHA256SUMS.txt'),'utf8');
  for(const line of sums.trim().split('\n')) {
    const [expected,name]=line.split('  ');assert.equal(hash(await readFile(join(releaseDir,name))),expected);
  }
  const wrong=generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'});
  await assert.rejects(buildManifest({version,releaseDir,privateKey,publicKey:wrong}),/不匹配/);
});
