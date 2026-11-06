import {accountRpc} from './account-state.js';

export const primaryTestnet='https://bsc-testnet.bnbchain.org';
export const secondaryTestnet='https://bsc-testnet-dataseed.bnbchain.org';

export function testnetClients(primary,secondary,signal) {
  if (!secondary || new URL(primary).origin===new URL(secondary).origin) throw new Error('NET_SOURCES');
  return [accountRpc(primary,signal),accountRpc(secondary,signal)];
}
async function headAt(rpc,tag) {
  const head=await rpc('eth_getBlockByNumber',[tag,false]);
  const quantity=/^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/i;
  if (!head || !quantity.test(head.number) || (!['latest','finalized'].includes(tag) && head.number!==tag) ||
      !/^0x[0-9a-f]{64}$/i.test(head.hash) || !quantity.test(head.timestamp) ||
      Math.abs(Date.now()/1000-Number(BigInt(head.timestamp)))>=120) throw new Error('NET_UNVERIFIED');
  return head;
}
export async function readTestnetHead(rpc,tag) {
  if (!['latest','finalized'].includes(tag)) throw new Error('NET_UNVERIFIED');
  if (await rpc('eth_chainId')!=='0x61') throw new Error('TRIAL_CHAIN');
  return headAt(rpc,tag);
}
export const latestTestnetHead=rpc=>readTestnetHead(rpc,'latest');
export async function alignedTestnetHeads(clients,tag='latest') {
  const heads=await Promise.allSettled(clients.map(rpc=>readTestnetHead(rpc,tag)));
  const latest=heads.map(entry=>entry.status==='fulfilled'?entry.value:null);
  const aligned=[...latest];
  let conflict=false;
  if (latest.every(Boolean)) {
    const lower=BigInt(latest[0].number)<=BigInt(latest[1].number)?0:1;
    const higher=1-lower;
    if (latest[higher].number!==latest[lower].number) {
      try {aligned[higher]=await headAt(clients[higher],latest[lower].number);} catch {aligned[higher]=null;}
    }
    if (aligned[higher]) conflict=aligned[0].hash.toLowerCase()!==aligned[1].hash.toLowerCase() ||
      BigInt(aligned[0].timestamp)!==BigInt(aligned[1].timestamp);
  }
  return {latest,aligned,conflict};
}
