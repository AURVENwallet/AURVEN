import {readAccount} from './account-state.js';
import {accountCodeHash} from './contract-pin.js';
export const LOCAL_DEMO_RPC='http://127.0.0.1:8950';
export const DEMO_STAGES=Object.freeze([
  ['create','创建智能账户'],['bootstrap','首次换根'],['fund','注入本地测试币'],
  ['transfer','签名转账'],['rotate','再次换根'],['transfer-after-rotation','新密钥转账']
]);
const address=/^0x[0-9a-f]{40}$/i,hash=/^0x[0-9a-f]{64}$/i,quantity=/^0x[0-9a-f]+$/i;
const uint=value=>typeof value==='string'&&/^(0|[1-9][0-9]{0,77})$/.test(value)&&BigInt(value)<2n**256n;
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
export function validateDemoReport(report){
  if(!report||report.format!=='aurven-local-demo-v1'||report.chainId!==31337||report.publicTestKeys!==true||
    !/^[0-9a-f]{32}$/.test(report.runId)||!address.test(report.account)||!address.test(report.payer)||
    !address.test(report.recipient)||report.codeHash!==accountCodeHash||
    !Array.isArray(report.steps)||report.steps.length!==DEMO_STAGES.length){
    throw new Error('演示记录格式或网络无效');
  }
  const hashes=new Set();
  report.steps.forEach((step,i)=>{
    if(!step||step.stage!==DEMO_STAGES[i][0]||!hash.test(step.hash)||hashes.has(step.hash.toLowerCase())||
      !hash.test(step.blockHash)||!quantity.test(step.blockNumber)||!equal(step.from,report.payer)||
      (i===0?(step.to!==null||!equal(step.contractAddress,report.account)):!equal(step.to,report.account))||
      !['valueWei','gasUsed','gasPriceWei','feeWei'].every(key=>uint(step[key]))||
      BigInt(step.feeWei)!==BigInt(step.gasUsed)*BigInt(step.gasPriceWei)){
      throw new Error('演示交易记录不完整或已被修改');
    }
    hashes.add(step.hash.toLowerCase());
  });
  return report;
}
export function validateDemoReceipt(step,receipt,transaction,block,report){
  if(!receipt||!transaction||!block||receipt.status!=='0x1'||
    !equal(receipt.transactionHash,step.hash)||!equal(transaction.hash,step.hash)||
    !equal(receipt.blockHash,step.blockHash)||!equal(transaction.blockHash,step.blockHash)||!equal(block.hash,step.blockHash)||
    receipt.blockNumber!==step.blockNumber||transaction.blockNumber!==step.blockNumber||block.number!==step.blockNumber||
    !equal(receipt.from,report.payer)||!equal(transaction.from,report.payer)||
    (step.stage==='create'?(transaction.to!==null||receipt.to!==null||!equal(receipt.contractAddress,report.account)):
      (!equal(transaction.to,report.account)||!equal(receipt.to,report.account)))||
    !quantity.test(receipt.gasUsed)||!quantity.test(receipt.effectiveGasPrice)||!quantity.test(transaction.value)||
    !quantity.test(block.timestamp)||!Number.isSafeInteger(Number(BigInt(block.timestamp)))||
    BigInt(receipt.gasUsed).toString()!==step.gasUsed||BigInt(receipt.effectiveGasPrice).toString()!==step.gasPriceWei||
    BigInt(transaction.value).toString()!==step.valueWei){
    throw new Error('交易回执与演示记录不符，本地链可能已重启或重组');
  }
  return {...step,timestamp:Number(BigInt(block.timestamp)),verified:true};
}
export async function fetchDemoReport(signal){
  const response=await fetch('./demo/local-demo.json',{cache:'no-store',credentials:'omit',signal});
  if(!response.ok)throw new Error('本机尚无演示记录，请先运行项目的本地体验脚本');
  const text=await response.text();
  if(text.length>64000)throw new Error('演示记录超过大小限制');
  return validateDemoReport(JSON.parse(text));
}
export async function verifyLocalDemo(report,signal){
  validateDemoReport(report);
  let id=0;
  async function rpc(method,params=[]){
    const requestId=++id;
    const response=await fetch(LOCAL_DEMO_RPC,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:requestId,method,params}),credentials:'omit',redirect:'error',
      signal:AbortSignal.any([AbortSignal.timeout(12000),...(signal?[signal]:[])])});
    const result=await response.json();
    if(!response.ok||result.id!==requestId||result.jsonrpc!=='2.0'||result.error||result.result===undefined){
      throw new Error('无法核对本地交易回执');
    }
    return result.result;
  }
  if(await rpc('eth_chainId')!=='0x7a69'||!/anvil/i.test(await rpc('web3_clientVersion'))){
    throw new Error('演示账户仅支持本机 Anvil 测试链');
  }
  const state=await readAccount({endpoint:LOCAL_DEMO_RPC,account:report.account,chainId:31337,signal});
  const receipts=await Promise.all(report.steps.map(async step=>{
    const [receipt,tx,block]=await Promise.all([
      rpc('eth_getTransactionReceipt',[step.hash]),rpc('eth_getTransactionByHash',[step.hash]),
      rpc('eth_getBlockByNumber',[step.blockNumber,false])
    ]);
    return validateDemoReceipt(step,receipt,tx,block,report);
  }));
  return {report,state,receipts,verifiedAt:new Date().toISOString()};
}
