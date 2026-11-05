# Key trees, reservations and recovery

This describes the current experimental implementation, not an audited security guarantee. Browser signing and independent recovery authorization are not implemented. Use only disposable local/testnet keys.

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

`TestSigningSession` and the new vault reservation callback are exercised together with a real disposable proof in tests. The website does not yet connect its encrypted seed to that signer. The browser panel only creates, unlocks, locks, exports and imports test vaults. A caller must derive the tree and reservation context from the same validated key; the journal cannot authenticate arbitrary caller-supplied trees by itself.

Once a reservation is committed, cancellation, a locked tab, failed signing, a reverted transaction, RPC timeout or missing receipt must not reclaim the leaf. It is acceptable to waste a leaf. It is not acceptable to sign another digest with it. The existing contract can accept a later unused leaf; the future signing UI must reconcile the authenticated local journal with chain state before choosing one.

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

A supported future device handover must be authorized by a device with trusted current key state, rotate the on-chain account to a fresh tree controlled by the new device, and verify confirmation before the new device signs. The old tree is then retired. This handover workflow is not yet implemented.

## Why importing a backup cannot resume signing

Encryption proves integrity and protects confidentiality. It does not prove freshness. A backup from yesterday may omit a signature made today, including one that was never broadcast. The chain's next-leaf index cannot reveal every off-chain signature. Simply selecting `max(backup index, chain index)` is insufficient.

Every import therefore becomes an authenticated `recovery-readonly` vault. It can be inspected and exported, but `reserveLeaf` rejects it. There is no enable-signing switch, and editing the mode invalidates authentication. Imports cannot overwrite an existing vault. Re-exporting an imported vault does not lift the restriction.

The live vault object detects a revision lower than one it has already authenticated, including across lock/unlock. **This does not detect a complete browser-profile rollback followed by an application restart.** Browser-local counters cannot provide that guarantee without an independent freshness anchor. Do not describe this release as rollback-proof or crash-recoverable wallet custody.

If the trusted original device and latest journal are lost, safe recovery requires an independent, prearranged authority that can rotate the account without reusing the possibly consumed tree. The current account has no such recovery authority. Importing a file does not restore control of the account.

## Verification and remaining work

Node tests exercise encryption, tampering, import bounds, lock deadlines, concurrent requests, persistent reservations across sessions, storage errors, compare-and-swap conflicts, observed rollback, read-only imports and proof release ordering. The browser harness additionally exercises actual IndexedDB strict transactions and Web Locks, reopening storage and imported read-only state. It does not simulate physical power loss or prove resistance to a malicious browser.

To run browser checks, copy `test/browser/vault-checks.html` and `test/browser/vault-checks.js` into ignored `ui/demo/`, serve only `ui/` over loopback, then open `/demo/vault-checks.html` and click **Run storage checks**. The harness uses unique disposable database names and never opens the primary wallet database. Remove only these two copied files when done; retain any unrelated local demo files.

Remaining gates before browser signing include worker-isolated tree generation, validated key/context binding, pending-transaction reconciliation, historical-root rejection, defined power-loss and device-handover behavior, independent recovery design, public-testnet gas validation and specialist cryptographic/security review.
