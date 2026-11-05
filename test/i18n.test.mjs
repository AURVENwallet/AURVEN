import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {translateText,normalizeLanguage} from '../ui/i18n-copy.js';

test('all four pages expose language controls and English static copy',()=>{
  for(const name of ['index','flow','lab','wallet']){
    const html=readFileSync(new URL('../ui/'+name+'.html',import.meta.url),'utf8');
    assert.match(html,/data-language="zh-CN"/);assert.match(html,/data-language="en"/);
    assert.match(html,/src="\.\/i18n.js\?v=1"/);
    const markup=html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'')
      .replace(/<div class="language-switch"[^>]*>[\s\S]*?<\/div>/g,'');
    const fields=[...markup.matchAll(/>([^<>]+)</g)].map(m=>m[1]);
    fields.push(...[...markup.matchAll(/(?:aria-label|placeholder|content|title|alt)="([^"]*)"/g)].map(m=>m[1]));
    for(const field of fields)assert.doesNotMatch(translateText(field,'en'),/[\u3400-\u9fff]/,name+': '+field);
  }
});

test('dynamic statuses and receipt numbers translate without changing data',()=>{
  const address='0x2222222222222222222222222222222222222222';
  assert.equal(translateText('账户地址已复制 · '+address,'en'),'Address copied · '+address);
  assert.equal(translateText('区块 2473 · Gas 1289035 · 费用 0.001289035009023245','en'),
    'Block 2473 · Gas 1289035 · Fee 0.001289035009023245');
  assert.equal(translateText('第 7 层 · 路径节点','en'),'Level 7 · Path node');
  assert.equal(translateText('验证拒绝 · 本金未转移','en'),'Rejected · No funds transferred');
  assert.equal(translateText('RPC 未返回有效结果（eth_call）','en'),'RPC returned no valid result (eth_call)');
});

test('Chinese and protocol data stay unchanged; unknown preferences fall back',()=>{
  const state='账户状态已同步 · 可以生成草稿';
  assert.equal(translateText(state,'zh-CN'),state);
  const data='keylab/evm/v1 0xabcdef 31337 0.000000000000000001';
  assert.equal(translateText(data,'en'),data);
  assert.equal(normalizeLanguage('en'),'en');
  for(const value of [null,'fr','en-US','<script>'])assert.equal(normalizeLanguage(value),'zh-CN');
});
