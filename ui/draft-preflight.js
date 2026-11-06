import {execHasher} from './lib/evmwots.js';
import {fail, hex} from './vault-crypto.js';
import {fromHex} from './local-proof.js';
import {accountCodeHash} from './contract-pin.js';

// Only the single native-coin transfer format produced by the wallet is supported.
const fields = 'format stateSource chainId account recipient valueWei epoch leaf deadline salt randomizer digest snapshot leafReserved'.split(' ').sort();
const address = /^0x[0-9a-f]{40}$/i;
const word16 = /^[0-9a-f]{32}$/;
const uint256 = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value) && BigInt(value) < 2n ** 256n;

export function validateReviewDraft(draft) {
  if (!draft || draft.format !== 'bsc-key-lab-unsigned-transfer-v2' || draft.stateSource !== 'rpc-snapshot') fail('DRAFT_SOURCE');
  if (Object.keys(draft).sort().join('|') !== fields.join('|') || draft.leafReserved !== false ||
      ![97,31337].includes(draft.chainId) || typeof draft.account !== 'string' || !address.test(draft.account) ||
      typeof draft.recipient !== 'string' || !address.test(draft.recipient) || /^0x0{40}$/i.test(draft.recipient) ||
      !uint256(draft.valueWei) || draft.valueWei === '0' || !Number.isInteger(draft.epoch) || draft.epoch < 1 || draft.epoch > 4294967295 ||
      !Number.isInteger(draft.leaf) || draft.leaf < 0 || draft.leaf >= 960 || !Number.isSafeInteger(draft.deadline) || draft.deadline <= 0 ||
      draft.salt !== 0 || typeof draft.randomizer !== 'string' || !word16.test(draft.randomizer) ||
      typeof draft.digest !== 'string' || !word16.test(draft.digest)) fail('DRAFT_FORMAT');
  const original = draft.snapshot;
  if (!original || original.codeHash !== accountCodeHash || original.chainId !== draft.chainId ||
      typeof original.account !== 'string' || original.account.toLowerCase() !== draft.account.toLowerCase() ||
      original.epoch !== draft.epoch || original.next !== draft.leaf ||
      !/^0x[0-9a-f]{32}$/.test(original.root) || !/^0x[0-9a-f]{32}$/.test(original.pubSeed) ||
      !/^0x[0-9a-f]{64}$/.test(original.blockHash) || !/^0x[0-9a-f]{1,64}$/.test(original.blockNumber)) fail('DRAFT_FORMAT');
  const calls = [{to: draft.recipient, value: BigInt(draft.valueWei), data: new Uint8Array()}];
  const digest = execHasher(fromHex(draft.randomizer),draft.chainId,draft.account,draft.epoch,draft.leaf,draft.deadline,calls)(0);
  if (hex(digest) !== draft.digest) fail('DRAFT_DIGEST');
}

export function compareDraftState(draft, state, binding, journal) {
  const original = draft.snapshot;
  if (!binding?.matched || binding.chainId !== draft.chainId || binding.account !== draft.account.toLowerCase() ||
      binding.snapshot.epoch !== state.epoch || binding.derivedRoot !== state.root || binding.derivedPubSeed !== state.pubSeed) fail('DRAFT_KEYS');
  const head = BigInt(state.blockNumber);
  const inconsistentBlock = [original,binding.snapshot].some(snapshot =>
    head < BigInt(snapshot.blockNumber) || (head === BigInt(snapshot.blockNumber) && state.blockHash !== snapshot.blockHash));
  if (inconsistentBlock || original.root !== state.root || original.pubSeed !== state.pubSeed ||
      draft.epoch !== state.epoch || draft.leaf !== state.next) fail('DRAFT_STALE');
  if (draft.deadline <= state.timestamp || draft.deadline > state.timestamp + 3600) fail('DRAFT_DEADLINE');
  if (!uint256(state.balanceWei) || BigInt(state.balanceWei) < BigInt(draft.valueWei)) fail('DRAFT_BALANCE');
  // The local journal may be ahead even when an RPC has never seen the signature.
  if (journal.some(row => row.pubSeed === state.pubSeed.slice(2) && row.root === state.root.slice(2) && row.leaf >= draft.leaf)) fail('DRAFT_LEAF');
}
