import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {resolveAsset,CSP} from '../desktop/assets.mjs';
test('desktop protocol serves only public editor assets',()=>{
  assert.equal(resolveAsset('paper://app/src/app.js','/app'),join('/app','src','app.js'));
  for(const url of ['paper://other/index.html','paper://app/desktop/preload.cjs','paper://app/package.json','paper://app/.release-keys/key.pem','paper://app/%2e%2e/desktop/main.mjs','file:///etc/passwd'])assert.equal(resolveAsset(url,'/app'),null);
  assert.equal(CSP.includes("'unsafe-eval'"),false);
});
