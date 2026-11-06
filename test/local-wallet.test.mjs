import test from 'node:test';
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {startLocalWallet} from '../scripts/local-wallet.mjs';
import {readAccount} from '../ui/account-state.js';
import {translateText} from '../ui/i18n-copy.js';

async function session(lab) {
  const origin=new URL(lab.url).origin;
  const page=await fetch(lab.url);
  assert.equal(page.status,200);
  const html=await page.text();
  const id=html.match(/name="aurven-local-session" content="([a-f0-9]{32})"/)?.[1];
  assert.ok(id);
  const details=await (await fetch(origin+'/local/session.json')).json();
  assert.deepEqual(Object.keys(details).sort(),['account','endpoint','recipient']);
  const pair=(root,headers={})=>fetch(origin+'/local/pair',{method:'POST',body:root,
    headers:{Origin:origin,'Content-Type':'text/plain','X-Aurven-Session':id,...headers}});
  return {origin,id,details,pair,read:()=>readAccount({...details,chainId:31337})};
}

test('the launcher isolates sessions and racing or repeated pairing cannot replace the chosen root',async t=>{
  const one=await startLocalWallet();t.after(()=>one.close());
  const a=await session(one);
  const before=await a.read();
  assert.equal(before.root,'0x'+'00'.repeat(16));assert.equal(before.balanceWei,'1000000000000000000');
  const roots=['0x'+'77'.repeat(16),'0x'+'88'.repeat(16)];
  const results=await Promise.all(roots.map(root=>a.pair(root)));
  assert.deepEqual(results.map(r=>r.status).sort(),[204,409]);
  const winner=roots[results.findIndex(r=>r.status===204)];
  assert.deepEqual((await Promise.all([a.pair(winner),a.pair(winner)])).map(r=>r.status),[204,204]);
  const after=await a.read();assert.equal(after.root,winner);assert.equal(after.next,0);
  assert.equal(after.balanceWei,before.balanceWei);
  const two=await startLocalWallet();t.after(()=>two.close());
  const b=await session(two);
  assert.notEqual(a.id,b.id);assert.notEqual(a.details.account,b.details.account);
  assert.equal((await b.pair(winner,{'X-Aurven-Session':a.id})).status,403);
  assert.equal((await b.read()).root,before.root);
});

test('local setup rejects foreign requests, malformed roots and private files; stopping closes both ports',async t=>{
  const lab=await startLocalWallet();t.after(()=>lab.close());
  const {origin,details,pair,read}=await session(lab);
  const root='0x'+'ab'.repeat(16);
  for (const headers of [{Origin:'https://example.org'},{Origin:''},{'X-Aurven-Session':'invalid'}]) {
    assert.equal((await pair(root,headers)).status,403);
  }
  assert.equal((await pair(root,{'Content-Type':'application/json'})).status,415);
  assert.equal((await pair('0x'+'00'.repeat(16))).status,400);
  assert.equal((await pair('unsafe')).status,400);
  assert.equal((await pair('x'.repeat(35))).status,413);
  const wrongHost=await new Promise((resolve,reject)=>{
    const req=request(origin+'/local/session.json',{headers:{host:'example.org'}},res=>{res.resume();resolve(res.statusCode);});
    req.on('error',reject);req.end();
  });
  assert.equal(wrongHost,403);
  for (const file of ['/.git/config','/.env','/demo/local-demo.json','/src/BscTestAccount.sol','/scripts/local-wallet.mjs'])
    assert.equal((await fetch(origin+file)).status,404,file);
  for (const file of ['/wallet.html','/vault-ui.js','/assets/aurven-mark-web.png','/local/setup.js','/vendor/three/addons/controls/OrbitControls.js'])
    assert.equal((await fetch(origin+file)).status,200,file);
  const setup=await (await fetch(origin+'/local/setup.js')).text();
  for (const [,label] of setup.matchAll(/textContent='([^']+)'/g)) assert.doesNotMatch(translateText(label,'en'),/[\u3400-\u9fff]/);
  assert.equal((await read()).root,'0x'+'00'.repeat(16));
  await lab.close();
  await assert.rejects(fetch(origin+'/local/session.json'));
  await assert.rejects(fetch(details.endpoint));
});
