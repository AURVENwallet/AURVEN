import {readFileSync,statSync} from 'node:fs';
import {verifyLocalProof} from '../ui/local-proof.js';
try{
  if(process.argv.length!==3)throw new Error('Usage: node scripts/verify-local-proof.mjs <public-proof.json>');
  const path=process.argv[2];
  const info=statSync(path);
  if(!info.isFile()||info.size>16384)throw new Error('Proof must be a file no larger than 16 KiB.');
  const report=JSON.parse(readFileSync(path,'utf8'));
  if(!verifyLocalProof(report))throw new Error('Proof verification failed.');
  console.log(JSON.stringify({valid:true,purpose:report.purpose,chainId:report.chainId,leaf:report.leaf,root:report.root}));
  console.log('Verification-only proof. This does not establish account ownership or authorize a transaction.');
}catch(error){
  console.error(error.code?'Invalid or unreadable proof: '+error.code:error.message);
  process.exitCode=1;
}
