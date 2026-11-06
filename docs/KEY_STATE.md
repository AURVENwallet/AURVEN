# Key trees, reservations and recovery

The original encrypted browser vault can sign on BSC testnet from one browser profile. The reusable account panel creates a three-wei test account, supports separate one-wei transfers and rotates its active signing tree. The disposable trial and local simulation have separate workflows. Independent recovery authorization remains open.

## Reusable account signing

Creation uses a transient identity tree to authorize the initial active root inside the chain-97 setup constructor. Each active tree is derived from the encrypted master seed, chain, account address, epoch and a fresh public seed. A worker rebuilds the tree and compares its root to the live account. Before any signature leaves the worker, the vault takes the cross-tab writer lock, rechecks the account and commits the exact leaf and digest to encrypted storage. The vault requires two chain-97 endpoints to confirm the reviewed state immediately before committing a reservation and again before releasing signed calldata. A failed check after commitment keeps the leaf consumed. The UI independently reconstructs each proof and binds it to the intended action before requesting payment.

For an ordinary transfer, leaf selection advances beyond all locally recorded uses for that tree and respects the on-chain counter. Rotation uses leaf 960 or later. A failed signing or wallet request leaves the reservation consumed. After rotation a new root can begin at leaf 0. The deployed account rejects its current root as a successor but keeps no registry of earlier roots. A successful rejection under a new root demonstrates rejection at that point in time.

The public action record stores the expected payer, nonce and calldata hash before opening the external wallet. Reloading the original browser profile can recover a mined payment by hash or nonce. Receipt checks run with the vault locked and update only public history. The reusable panel records an agreed transaction status only after two RPC endpoints report matching evidence at a shared block. A provisional or conflicting result is stored alongside the earlier status. Receipt checks never touch the encrypted leaf journal. They track the original payer nonce across replacements and retain the previous inclusion for reorganization checks. The encrypted leaf reservation survives dropped, replaced, reverted and orphaned transactions. Losing or rolling back the profile can lose off-chain signing history. Restored backups stay read-only. See the [five public receipts and replay check](MAINNET_READINESS.md#reusable-browser-account).

## BSC mainnet rehearsal keys

The read-only rehearsal generates a fresh 32-byte master and 16-byte wallet ID for each run. The Node-only derivation uses separate versioned SHA-256 labels for the identity secret seed, identity public seed and active secret seed. Each input binds the chain ID (56), explicit factory address and wallet ID. The active secret seed also binds the predicted account address, epoch and a fresh 16-byte public seed. The identity and active Merkle trees each contain 1,024 WOTS leaves. Only the identity public seed, roots and proofs are needed in the contract call. Tests compare fixed derivation vectors and confirm that the same inputs produce different secret seeds under the existing chain-97 policy.

The chain-56 factory accepts bootstrap leaf 9. After atomic creation, epoch 1 starts at active leaf 0. The rehearsal encodes its activation and first transfer once, clears the fixture secret seeds and gives both nodes identical calldata. The testnet vault retains its separate derivation and network checks. A future mainnet signer needs durable reservations before producing either proof. An expired activation requires a fresh identity or an independently reviewed recovery path. Signing changed terms with the previous identity leaf could expose one-time key material.

A master seed and public chain history alone cannot reveal a proof produced on a lost device but never submitted. This factory adds no recovery authority. Restoring signing rights after total device loss requires a separately provisioned recovery method and corresponding on-chain verification. Until that design is tested, a restored backup remains read-only in the public wallet.

## Tree structure

Each active key tree is a binary Merkle tree of height 10: 1,024 leaves, 512 parents, then 256, 128, 64, 32, 16, 8, 4, 2 and one root. A leaf commits to the public key of one stateful Winternitz-style one-time signature. Each signature contains 18 chains of 16-byte elements: 16 message chains and two checksum chains, with base 256. A proof contains 288 signature bytes plus ten 16-byte Merkle siblings (160 bytes), totaling 448 bytes before transaction encoding.

The account stores the active public seed, root, epoch and next permitted leaf index. Verification reconstructs the leaf and its path to the stored root. Ordinary execution uses the first 960 leaves; the last 64 are reserved for key-tree rotation. A rotation must introduce a fresh, independently derived tree. The initial epoch-zero identity tree authorizes the first active tree.

The implementation uses SHA-256 derivation and truncated Keccak operations. These custom parameters are not a claim of conformance to standardized LMS or XMSS, nor a validated post-quantum security level. See [NIST SP 800-208](https://csrc.nist.gov/pubs/sp/800/208/final) for standardized stateful hash-based schemes and their state-management context.

## A leaf is consumed before signing

1. Prepare the complete signing context and digest.
2. Acquire the origin-local exclusive Web Lock.
3. Read and authenticate the latest encrypted journal.
4. Reject a previously reserved `(public seed, root, leaf)` tuple, even if the account, epoch or digest changes.
5. Append the reservation and commit it with an IndexedDB read/write transaction requesting strict durability. Compare-and-swap rejects an unexpected record change.
6. Only after transaction completion may the signing caller produce or return a proof.

`TestSigningSession` and the vault reservation callback are exercised together with a real disposable proof in tests. The website now also connects encrypted test seeds to a verification-only worker through `signProofMessage`; see the separate self-check domain below. It does not authorize account transactions. A transaction-signing caller must derive its tree and reservation context from the same validated key; the generic journal alone cannot authenticate arbitrary caller-supplied trees.

## Browser signature self-check

The wallet page generates a full 1,024-leaf verification tree in a same-origin module worker. It clones the encrypted envelope and non-extractable unlock key to that worker, which authenticates the envelope and derives dedicated keys under `aurven/test-wallet/verification/sk/v1` and `aurven/test-wallet/verification/pub/v1`, including network and wallet identity. These domains differ from both identity and transaction tree derivation. The public root and seed are returned; private signing material is not returned to the UI. A worker keeps computation off the page thread; it is not a security boundary against malicious same-origin scripts or a compromised browser.

Messages are bounded to 280 Unicode characters and hashed under `aurven/local-proof/message/v1`, binding the chain, wallet ID, public seed, root, leaf and fresh challenge. The worker recomputes this digest and rejects a context that does not match its authenticated tree; it has no raw-digest or transaction-signing command. The main service independently verifies both the returned context and proof before exposing a result.

The self-check API takes the next index from the latest authenticated journal while holding the exclusive write lock. It records that reservation with a strict compare-and-swap transaction **before sending the worker a sign command**. Its journal rows use the zero address and epoch zero as verification-only markers, never as a deployed account. The dedicated verification tree has 1,024 self-check leaves; the 960/64 transaction/rotation split applies to account transaction trees, not this separate tree. The vault-wide 1,024-entry cap still applies.

Canceling generation or locking the vault terminates its worker and rejects pending requests. Canceling before a delayed storage read completes cannot launch a late worker. A failure after reservation leaves that index consumed. Reloading requires rebuilding the same verification tree and reads the durable journal to continue at a later leaf. A worker also rejects repeated leaves in memory. Read-only imports cannot build or use a signing worker.

The exported `aurven-local-proof-v1` JSON includes the message, public identity, challenge, leaf, digest and 448-byte proof. It contains no private seed and can be checked with `verifyLocalProof` in `ui/local-proof.js`. Messages should contain no private information if a proof will be shared. This self-consistent proof does not establish an account's ownership or authorization, and no RPC call, account deployment, calldata construction or transaction broadcast is part of this flow.

Once a reservation is committed, cancellation, a locked tab, failed signing, a reverted transaction, RPC timeout or missing receipt must not reclaim the leaf. It is acceptable to waste a leaf. It is not acceptable to sign another digest with it. The existing contract can accept a later unused leaf; the future signing UI must reconcile the authenticated local journal with chain state before choosing one.

## Local account key-root comparison

`TestVault.checkAccountKeys` reads and authenticates the current encrypted vault, checks a pinned account snapshot on that vault's test network and sends the encrypted envelope plus non-extractable unlock key to a separate module worker. At epoch zero the worker derives `testIdentitySeeds` from the vault seed, chain and wallet ID. At later epochs it derives `testActiveSeeds` from the seed, chain, account address, epoch and on-chain public seed. It rebuilds all 1,024 leaves and returns only the wallet ID, network, account, epoch, public seed and root. Its message protocol has no signing operation. Temporary typed-array secret buffers are cleared on return, but JavaScript memory zeroization is not guaranteed.

The service validates the worker's exact output shape and context, then reads the pinned account again. Any epoch, seed, root or next-leaf change invalidates the attempt. The result includes the second snapshot's block and time. Cancellation or lock aborts RPC work, terminates the worker and invalidates late responses. The service does not modify the encrypted envelope or journal and does not persist a trusted account binding. UI input changes also clear the result; it survives neither locking nor page reload.

A matching result establishes only that this local calculation reproduced the root reported by that RPC. It is not an externally verifiable ownership proof, an independent network consensus or a guarantee that the usage journal is fresh. It never grants transaction-signing permission. Restored read-only backups may be checked, but remain blocked from every signing/reservation operation. Before a future transaction signature, the signing workflow must repeat fresh account/context checks and durably reserve its selected leaf. It must not use this displayed result as a signing authorization.

## Read-only account activity

The activity panel associates a chain ID and account address only after the existing reader checks the deployed runtime pin and a consistent account-state snapshot. This is a watch-only association. The activity tracker itself does not compare that account's root with a tree derived from the encrypted vault and must not be treated as proof of key ownership. The separate local root-check panel does not upgrade a saved watch-only association.

`aurven-readonly-activity-v1` is a separate IndexedDB database for public metadata. It holds at most eight accounts, with 96 transaction hashes per account. Each account row and its transaction records are updated atomically. Checks assign a unique request token; a late response can update a row only if its token is still current. A reload never silently resumes an interrupted check or treats saved observations as fresh. RPC URLs, which may contain provider credentials in a path or query, remain in session memory and are omitted from exports.

The checker compares chain IDs, account/transaction association, transaction and receipt block hashes, canonical block membership, and the original head's hash after reading. Account creation is associated only when its receipt names the watched contract. Status zero means reverted; no receipt is pending, missing or unavailable depending on the accompanying transaction and prior evidence. A previous successful result does not remain a current success if a later check is uncertain or fails. A re-included transaction can show a different block explicitly. `Executed` events identify observed epochs and leaves; they are not a complete history of signatures created off-chain. One RPC can still fabricate a consistent view, and a confirmation count is not finality.

There is no vault import, leaf reservation or signing command in the tracker. Missing, reverted, canceled or reorganized observations cannot remove an encrypted journal entry. Public reports contain addresses, hashes, snapshot roots and observed activity, but no passwords, private seeds or RPC URLs. They are linkable public metadata, not encrypted backups; this version has no report-import or synchronization function. Clearing the browser's site data removes the records.

For browser storage checks, copy `test/browser/activity-checks.html` and `test/browser/activity-checks.js` into ignored `ui/demo/`, then open `/demo/activity-checks.html` on the loopback preview and choose **Run activity checks**. The harness uses its own disposable database and does not access the vault or any RPC.

## Encryption and browser boundaries

- Fresh 32-byte random seed, random 16-byte vault identifier and salt; only chain IDs 97 and 31337.
- PBKDF2-HMAC-SHA-256 with 600,000 iterations derives a non-extractable AES-256-GCM key. New passwords require at least 12 characters. This is a browser-native prototype choice, not an independent security assessment.
- A fresh 12-byte IV is generated for every encryption; a 128-bit authentication tag protects the encrypted seed and journal. Format, network, identity, revision, mode and KDF parameters are authenticated as additional data.
- Inputs have fixed field schemas, fixed KDF cost and a 1 MiB backup limit. This version stops after 1,024 journal entries across the vault; it does not prune entries or support indefinite rotation.
- Unlock keys remain in memory. The UI locks on navigation, backgrounding or two minutes without activity. Password fields are cleared after operations. JavaScript cannot guarantee complete memory zeroization.
- Strict transaction completion reduces the storage-loss window; it is not proof that every browser, OS or disk survives power failure. A compromised origin, extension, browser or OS can still steal an unlocked key or alter the client. This feature has no server upload or synchronization endpoint.

## Multiple tabs versus multiple devices

Tabs sharing the same origin, browser storage partition and database cooperate through Web Locks, with transactional compare-and-swap as a second guard. Different browsers, profiles, devices and origins do not share this lock or journal. HTTPS and HTTP, different ports and different hostnames also have separate storage.

The first-version operating rule is one signing device per tree. Do not clone a browser profile or unlock independent active copies for signing. Simultaneous multi-device signing would need a separately designed, trusted coordination mechanism or disjoint key authority with enforced allocation; neither exists here.

The [local two-profile drill](../README.md#rehearse-a-device-handover) implements the first handover from epoch 1 to epoch 2 on the launcher's disposable Anvil account. The receiver derives a fresh tree from its own master seed, account, chain, next epoch and random public seed. It checks that its journal is empty and that its seed cannot reconstruct the source tree. The encrypted vault saves the receiving request before displaying it. Both sides fingerprint a fixed-order encoding of the request with the first 128 bits of Keccak-256. The user must compare this fingerprint through an independent trusted channel.

The source matches its current root and commits leaf 960 and the rotation digest to its encrypted journal before its worker signs. It permits one rotation attempt per source tree in this drill. The receiver finds the matching Rekeyed event, checks canonical inclusion and one later block, verifies the actual transaction input and old-tree proof against its saved offer, and reconstructs its own new root. Draft review, reservation and simulation on the new tree repeat receipt checks. Rolling back the local chain invalidates the handover evidence. A full rollback of a browser profile can still erase off-chain history. Public testnet handover needs a confirmation policy, independent sources and interruption/reorganization drills.

## Why importing a backup cannot resume signing

Encryption proves integrity and protects confidentiality. It does not prove freshness. A backup from yesterday may omit a signature made today, including one that was never broadcast. The chain's next-leaf index cannot reveal every off-chain signature. Simply selecting `max(backup index, chain index)` is insufficient.

Every import therefore becomes an authenticated `recovery-readonly` vault. It can be inspected and exported, but `reserveLeaf` rejects it. There is no enable-signing switch, and editing the mode invalidates authentication. Imports cannot overwrite an existing vault. Re-exporting an imported vault does not lift the restriction.

The original device can open a saved encrypted file under the vault's writer lock and compare its authenticated seed and full ordered journal with the current vault. The check reports matching records, an older prefix (including a missing simulation-attempt flag), or a divergent history. A higher revision alone cannot establish which signatures were produced. The comparison only describes the local records at the time of the check.

An unlocked chain-97 backup lists distinct candidate addresses from its authenticated reservations and omits the local message self-check address. A reservation can precede a failed deployment. An early backup can contain no addresses. The user can enter a saved address manually. On request the browser reads pinned account code, balance and key state from two testnet endpoints at a shared block. It rebuilds the root locally and repeats the observations before displaying the result. The journal check looks for the most recently consumed on-chain leaf in that specific tree. A matching record cannot account for unpublished signatures. Restoring on a new device leaves the original device able to sign.

The live vault object detects a revision lower than one it has already authenticated, including across lock/unlock. **This does not detect a complete browser-profile rollback followed by an application restart.** Browser-local counters cannot provide that guarantee without an independent freshness anchor. Do not describe this release as rollback-proof or crash-recoverable wallet custody.

If the trusted original device and latest journal are lost, safe recovery requires an independent, prearranged authority that can rotate the account without reusing the possibly consumed tree. The current account has no such recovery authority. Importing a file does not restore control of the account.

## Verification and remaining work

Node tests exercise encryption, tampering, import bounds, lock deadlines, concurrent requests, persistent reservations across sessions, storage errors, compare-and-swap conflicts, observed rollback, read-only imports and proof release ordering. The browser harness additionally exercises actual IndexedDB strict transactions and Web Locks, reopening storage and imported read-only state. It does not simulate physical power loss or prove resistance to a malicious browser.

To run browser checks, copy `test/browser/vault-checks.html` and `test/browser/vault-checks.js` into ignored `ui/demo/`, serve only `ui/` over loopback, then open `/demo/vault-checks.html` and click **Run storage checks**. The harness uses unique disposable database names and never opens the primary wallet database. Remove only these two copied files when done; retain any unrelated local demo files.

The self-check uses worker-based generation and validates the message and key context. The account root checker reconstructs identity and active trees for read-only comparison. For local simulation the browser also revalidates the account and journal before releasing a signature. The disposable public-testnet CLI saves the exact signed transactions before sending and resumes by hash. The reusable browser flow stores its signing journal and recovers mined payments after reload. Recovery across RPC outages and deep forks, historical-root enforcement, physical power-loss drills, device handover, independent recovery and specialist review remain open. See the [release gates and mined receipts](MAINNET_READINESS.md).
