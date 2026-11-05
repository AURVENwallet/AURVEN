import {execFileSync} from 'node:child_process';
import {readFileSync,lstatSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';

const paths=execFileSync('git',['ls-files','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
assert.ok(paths.length,'No tracked files to check');
const prohibited=/(^|\/)(?:\.env(?:\..*)?|demo-runs|out|cache|broadcast|node_modules)(\/|$)|^ui\/demo\/|(?:\.pem|\.key|\.p12|\.pfx|\.keystore|\.wallet|\.log)$/i;
for(const path of paths){
  assert.ok(!prohibited.test(path),'Local or sensitive path is tracked: '+path);
  assert.ok(!lstatSync(path).isSymbolicLink(),'Review symlinks before publishing: '+path);
}
for(const page of ['index','flow','lab','wallet']){
  const html=readFileSync('ui/'+page+'.html','utf8');
  const policy=html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1];
  assert.ok(policy,'Missing page policy: '+page);
  const script=policy.split(';').find(rule=>rule.trim().startsWith('script-src'));
  assert.ok(script && !script.includes('unsafe-inline') && !script.includes('unsafe-eval'),'Unsafe script policy: '+page);
  for(const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)){
    if(/\bsrc=/.test(match[1]))continue;
    assert.match(match[1],/type="importmap"/);
    const digest=createHash('sha256').update(match[2]).digest('base64');
    assert.ok(script.includes("'sha256-"+digest+"'"),'Import map hash mismatch: '+page);
  }
  assert.doesNotMatch(html,/\son(?:click|load|error|submit|change)\s*=/i,'Inline event handler: '+page);
}
console.log('PASS: '+paths.length+' tracked files; local data excluded; four page policies verified.');
