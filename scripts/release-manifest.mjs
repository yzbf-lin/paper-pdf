import {createHash,createPrivateKey,createPublicKey,sign} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {readFile,stat,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {MAX_PACKAGE_BYTES,REPOSITORY,parseVersion,verifyManifest} from '../desktop/updates.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');

async function fileHash(path) {
  const hash=createHash('sha256');
  for await(const chunk of createReadStream(path))hash.update(chunk);
  return hash.digest('hex');
}

export async function buildManifest({version,releaseDir,privateKey,publicKey,notes='',publishedAt=new Date().toISOString()}) {
  parseVersion(version);
  const signingKey=createPrivateKey(privateKey),expectedKey=createPublicKey(publicKey);
  if(signingKey.asymmetricKeyType!=='ed25519' || expectedKey.asymmetricKeyType!=='ed25519')throw new Error('更新签名需要 Ed25519 密钥');
  const keyBytes=key=>key.export({format:'der',type:'spki'});
  if(!keyBytes(createPublicKey(signingKey)).equals(keyBytes(expectedKey)))throw new Error('发布私钥与应用内置公钥不匹配');
  const platforms={};
  for(const [platform,suffix] of [['darwin-arm64','macOS-arm64'],['windows-x86_64','Windows-x64']]) {
    const filename=`Paper-PDF-v${version}-${suffix}.zip`,path=resolve(releaseDir,filename),info=await stat(path);
    if(!info.isFile() || info.size<=0 || info.size>MAX_PACKAGE_BYTES)throw new Error(`发布文件无效或超过 512 MB：${filename}`);
    platforms[platform]={filename,url:`https://github.com/${REPOSITORY}/releases/download/v${version}/${filename}`,sha256:await fileHash(path),size:info.size};
  }
  const manifest={schema:1,version,release_url:`https://github.com/${REPOSITORY}/releases/tag/v${version}`,published_at:publishedAt,notes,platforms};
  const raw=Buffer.from(JSON.stringify(manifest,null,2)+'\n');
  const signature=sign(null,raw,signingKey).toString('base64');
  // Use the exact client validator before making release files available.
  verifyManifest(raw,signature,publicKey,{currentVersion:version,platform:'darwin',arch:'arm64'});
  await writeFile(resolve(releaseDir,'latest-update.json'),raw);
  await writeFile(resolve(releaseDir,'latest-update.json.sig'),signature+'\n');
  const checksums=[];
  for(const asset of Object.values(platforms))checksums.push(`${asset.sha256}  ${asset.filename}`);
  for(const name of ['latest-update.json','latest-update.json.sig'])checksums.push(`${await fileHash(resolve(releaseDir,name))}  ${name}`);
  await writeFile(resolve(releaseDir,'SHA256SUMS.txt'),checksums.join('\n')+'\n');
  return manifest;
}

async function main() {
  const args=process.argv.slice(2),options={};
  for(let i=0;i<args.length;i+=2) {
    if(!['--release-dir','--public-key','--notes-file','--tag'].includes(args[i]) || !args[i+1])throw new Error('用法：release-manifest.mjs [--release-dir DIR] [--public-key PEM] [--notes-file FILE] [--tag vX.Y.Z]');
    options[args[i]]=args[i+1];
  }
  const {version}=JSON.parse(await readFile(resolve(root,'package.json'),'utf8'));
  parseVersion(version);
  const tag=options['--tag']||(process.env.GITHUB_REF_TYPE==='tag'?process.env.GITHUB_REF_NAME:undefined);
  if(tag && tag!==`v${version}`)throw new Error('发布标签与 package.json 版本不一致');
  const encoded=process.env.PAPER_PDF_UPDATE_PRIVATE_KEY_B64?.trim();
  if(!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))throw new Error('缺少有效 PAPER_PDF_UPDATE_PRIVATE_KEY_B64');
  const privateKey=Buffer.from(encoded,'base64');
  if(privateKey.toString('base64')!==encoded)throw new Error('发布私钥 Base64 无效');
  const publicKey=await readFile(resolve(options['--public-key']||resolve(root,'desktop/update-public.pem')),'utf8');
  const notes=options['--notes-file']?await readFile(resolve(options['--notes-file']),'utf8'):'';
  const manifest=await buildManifest({version,releaseDir:resolve(options['--release-dir']||resolve(root,'release')),privateKey,publicKey,notes});
  console.log(`Created signed update manifest for v${manifest.version}: ${Object.keys(manifest.platforms).join(', ')}`);
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  main().catch(error=>{console.error(error.message);process.exitCode=1;});
}
