import {accountRpc} from './account-state.js';
import {validateReviewDraft} from './draft-preflight.js';
import {EvmTreeKey, encodeExecute, rootFromProof, PROOF_LEN} from './lib/evmwots.js';
import {fromHex} from './local-proof.js';
import {testActiveSeeds} from './test-wallet-core.js';
import {decryptPayload, fail, hex} from './vault-crypto.js';

export function localSimulationEndpoint(endpoint, chainId) {
  if (chainId !== 31337) return null;
  let url;
  try { url = new URL(endpoint); } catch { return null; }
  if (url.protocol !== 'http:' || !['127.0.0.1','[::1]','localhost'].includes(url.hostname) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
  return url.href;
}

export function reservedRow(journal, draft) {
  const tree = journal.filter(row => row.root === draft.snapshot.root.slice(2) && row.pubSeed === draft.snapshot.pubSeed.slice(2));
  const row = tree.find(row => row.leaf === draft.leaf);
  if (!row || row.digest !== draft.digest || row.chainId !== 31337 || draft.chainId !== 31337 ||
      row.epoch !== draft.epoch || row.account !== draft.account.toLowerCase()) fail('SIGN_RESERVATION');
  if (tree.some(entry => entry.leaf > draft.leaf)) fail('DRAFT_LEAF');
  return row;
}

// This worker only accepts the authenticated, already-spent reservation for one transfer.
export async function signLocalTransfer({record,key,draft}, generate = EvmTreeKey.generate) {
  validateReviewDraft(draft);
  if (record.chainId !== 31337 || record.mode !== 'active') fail('SIGN_LOCAL');
  const payload = await decryptPayload(record,key);
  if (reservedRow(payload.journal,draft).simulationAttempt !== true) fail('SIGN_RESERVATION');
  const master = fromHex(payload.seed);
  let skSeed;
  try {
    const seeds = testActiveSeeds(master,31337,draft.account.toLowerCase(),draft.epoch,fromHex(draft.snapshot.pubSeed.slice(2)));
    skSeed = seeds.skSeed;
    const tree = generate(skSeed,seeds.pubSeed);
    if (hex(tree.root) !== draft.snapshot.root.slice(2)) fail('DRAFT_KEYS');
    return tree.sign(draft.leaf,fromHex(draft.digest));
  } finally { master.fill(0); skSeed?.fill(0); }
}

export async function simulateLocalProof(endpoint, draft, state, proof, signal) {
  if (!localSimulationEndpoint(endpoint,draft.chainId)) fail('SIGN_LOCAL');
  if (!(proof instanceof Uint8Array) || proof.length !== PROOF_LEN ||
      hex(rootFromProof(fromHex(state.pubSeed.slice(2)),draft.leaf,fromHex(draft.digest),proof)) !== state.root.slice(2)) fail('PROOF_VERIFY');
  const calls = [{to:draft.recipient,value:BigInt(draft.valueWei),data:new Uint8Array()}];
  const data = encodeExecute(calls,draft.leaf,draft.deadline,draft.salt,fromHex(draft.randomizer),proof);
  const rpc = accountRpc(endpoint,signal);
  if (await rpc('eth_chainId') !== '0x7a69') fail('SIGN_LOCAL');
  if (!/^anvil(?:\/|\b)/i.test(await rpc('web3_clientVersion'))) fail('SIGN_LOCAL');
  let result;
  try {
    result = await rpc('eth_call',[{to:draft.account,data:'0x'+hex(data)},{blockHash:state.blockHash,requireCanonical:true}]);
  } catch { fail(signal?.aborted ? 'CANCELED' : 'SIMULATION'); }
  if (result !== '0x') fail('SIMULATION');
  return {leaf:draft.leaf,digest:draft.digest,blockNumber:state.blockNumber,blockHash:state.blockHash};
}
