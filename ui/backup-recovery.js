import {readAccountAt} from './account-state.js';
import {keyStateEqual} from './account-key-check.js';
import {alignedTestnetHeads, primaryTestnet, secondaryTestnet, testnetClients} from './testnet-heads.js';
import {fail} from './vault-crypto.js';

// Both journals have already passed authenticated decryption and schema validation.
export function compareBackupJournal(saved, current) {
  const fields = ['chainId', 'account', 'epoch', 'pubSeed', 'root', 'leaf', 'digest', 'handoverOut'];
  if (saved.length > current.length) return 'different';
  let older = saved.length < current.length;
  for (const [index, row] of saved.entries()) {
    const local = current[index];
    if (fields.some(field => row[field] !== local[field]) ||
        ['binding','salt','rnd'].some(field=>row.commitment?.[field]!==local.commitment?.[field]) ||
        (row.simulationAttempt && !local.simulationAttempt)) return 'different';
    if (row.simulationAttempt !== local.simulationAttempt) older = true;
  }
  return older ? 'older' : 'matches';
}

export async function readRecoveryAccount({account, signal, tag='latest'}) {
  const timeout = AbortSignal.timeout(30000);
  const clients = testnetClients(primaryTestnet, secondaryTestnet, signal ? AbortSignal.any([signal, timeout]) : timeout);
  const {aligned, conflict} = await alignedTestnetHeads(clients,tag);
  if (conflict) fail('RECOVERY_CONFLICT');
  if (!aligned.every(Boolean)) fail('RECOVERY_NODES');
  let snapshots;
  try {
    snapshots = await Promise.all(clients.map((rpc, index) => readAccountAt(rpc, account, 97, aligned[index])));
  } catch {
    fail('RECOVERY_ACCOUNT');
  }
  const [first, second] = snapshots;
  if (!keyStateEqual(first, second) || first.balanceWei !== second.balanceWei ||
      first.blockHash !== second.blockHash || first.blockNumber !== second.blockNumber) fail('RECOVERY_CONFLICT');
  return first;
}

export function recoveryJournalReview(journal, snapshot) {
  const rows = journal.filter(row => row.account === snapshot.account && row.epoch === snapshot.epoch &&
    '0x' + row.pubSeed === snapshot.pubSeed && '0x' + row.root === snapshot.root);
  return {currentTreeReservations: rows.length, lastChainLeafRecorded: snapshot.next === 0 ? null :
    rows.some(row => row.leaf === snapshot.next - 1)};
}
