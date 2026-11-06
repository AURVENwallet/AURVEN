# Security status

AURVEN is an experimental local/testnet prototype. This repository is not an independently audited wallet. Source checks and passing tests do not establish cryptographic security or suitability for real assets.

The checks below are a pre-publication record, not a production security certification or proof of post-quantum strength.

## Release checks

| Check | Result / scope |
| --- | --- |
| Solidity tests | 43 passed, including chain restrictions, tampering, replay, expiry, rotation, interoperability and multisig behavior. |
| Client and UI tests | 121 tests as of 2026-11-06. Coverage includes account snapshots, transfer validation, flow simulation, signing reservations, receipt validation, localization, the encrypted vault, verification-only worker signing, offline proof verification, read-only transaction tracking, account key-root comparison, unsigned draft review, durable reservations, loopback signed simulation, gas benchmarking and CLI recovery from a lost submission reply. Compile contracts before running client tests. |
| Public testnet pilot | Two official BSC testnet endpoints agreed on four mined CLI receipts covering deployment, initial key activation, funding and execution of a one-wei native transfer. Active-to-active key rotation has a public gas estimate and still needs a mined public receipt. See the [measurement and readiness record](docs/MAINNET_READINESS.md). |
| Reproducible source | A clean staged-source copy builds and passes contract tests. Solidity source bytes are preserved by .gitattributes because metadata contributes to the pinned runtime hash. |
| Runtime pin | Compiled BscTestAccount checked against ui/contract-pin.js. |
| Secret scan | Gitleaks 8.30.1 scanned the public source snapshot with redacted output; no findings in that scan. Tool archive SHA-256 was checked against the official release checksums. |
| Dependency advisory query | An OSV query for npm three@0.187.0 returned no matching advisories on 2026-11-05. |
| Browser checks | Chinese / English navigation, dynamic results, local receipts and form-state retention checked. Vault acceptance includes six actual IndexedDB / Web Locks checks, creation, wrong-password rejection, encrypted download, read-only import and locked reload. Signature self-check acceptance covers a full worker-generated tree, actual signatures, tamper rejection, public proof export, cancellation, resumed leaf indices and mobile layout. Activity acceptance adds four IndexedDB checks, six real local-chain receipts, saved-history reload, RPC URL non-persistence, public export and mobile layout. Account-key acceptance checks an actual Anvil root match from a restored read-only vault, unchanged usage counts, cancellation and locked-result clearing. Three browser localization checks cover textarea hints without changing message values. |
| Page policy | CSP restricts scripts to local files and the exact import-map hash, without unsafe-inline or unsafe-eval for scripts; objects, base URLs and native form submissions are blocked. RPC connections remain available to HTTPS endpoints and explicit loopback HTTP addresses. |
| Publication boundary | Runtime keys, leaf journals, local receipts, environment files, logs, dependency caches and build artifacts are excluded. Public deterministic test vectors remain intentionally available for reproduction. |

Scanner: [Gitleaks 8.30.1](https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1). Dependency data: [OSV API](https://api.osv.dev/v1/query). The current automated workflow runs source checks, secret scanning, contract tests, runtime-pin verification and client tests. Workflow actions are pinned to commit IDs and receive read-only repository permissions.

## Known limitations

- **Disposable wallet launcher.** Each invocation starts its own loopback Anvil process, preview port and browser vault namespace. The pairing endpoint checks the Host, browser Origin and session header, accepts only a public 16-byte root, and pins the first valid root. Repeating a request for that root leaves the account counter and balance intact. The launcher uses Anvil administrative methods only for its disposable account. Other programs on the same machine can access local ports, so run it on a computer you control.

- **Local signed simulation.** The selected loopback HTTP node on chain 31337 receives an executable authorization while the transfer is valid. The wallet uses a hash-pinned canonical-block read-only call. A node controlled by someone else could retain and submit the authorization. Success describes the simulated block. It does not produce a transaction receipt. The encrypted journal records the attempt before proof generation, and the page cannot resume a signing attempt from a backup, after reload, or after locking. Vaults containing attempt markers need a reader that understands this journal field.

- **Draft review and reservation.** A review applies to the observed block and active local journal. Reserving consumes the current session's review, rechecks account state and commits the exact digest under a Web Lock using strict IndexedDB compare-and-swap. The local simulator reads fresh account state before and after proof generation and durably marks the signing attempt before invoking its worker. An exported reservation flag cannot authorize signing. Chain reorganization and offline use by another device remain outside the local journal's view.

- **Cryptography:** the custom stateful WOTS/Merkle scheme uses 16-byte elements. Its parameters and quantum-security bounds require specialist evaluation. No security level is asserted here.
- **One-time keys:** a leaf must never sign two different digests. The disposable demo journals before returning signatures. The browser vault adds strict IndexedDB transactions, cross-tab Web Locks and compare-and-swap. Its verification-only message signer commits a reservation before sending the worker a sign command, validates the returned context and independently checks the proof. Account transaction proofs are released only to the selected loopback node for a local Anvil simulation. No vault entry is reclaimed after a failed or reverted transaction. Each demo script invocation still creates fresh keys rather than resuming an old run.
- **Self-check scope:** verification keys and message hashes use separate domains from account transaction keys. Public proofs expose their messages and are not account-ownership evidence or transaction approvals. Workers are terminated on lock/cancel, including pending operations, but do not isolate keys from malicious same-origin code. The worker receives a cloned unlock CryptoKey; non-extractability does not prevent code holding that key from using it. Automated checks cover failures and protocol races, not specialist cryptanalysis or physical power loss.
- **Recovery and devices:** every imported backup is read-only and cannot reserve leaves. The live vault object rejects previously observed revision rollback, including lock/unlock, but cannot detect full profile rollback after restart. Separate devices, browsers, profiles and origins do not share locks. Single-device use is required; device handover and independent recovery authorization are not implemented. On-chain state cannot reveal every signature produced off-chain. Pending-transaction recovery and historical-root rejection in a persistent signing client remain incomplete.
- **Browser custody:** AES-256-GCM and PBKDF2-HMAC-SHA-256 (600,000 iterations) protect stored test seeds and journals, with authenticated metadata. This has not been independently audited. Password strength matters; JavaScript cannot guarantee complete memory zeroization. Compromised origin scripts, extensions, browsers or operating systems can compromise an unlocked vault. Strict transaction completion is not a guarantee against physical power-loss on every system. Browser storage eviction, profile deletion or a lost password can remove access. Backups do not supply missing recovery authority. This version stops at 1,024 journal entries across a vault and does not prune records.
- **Network scope:** only BscTestAccount's constructor enforces chain 97 / 31337. The generic account and factory contracts do not impose that restriction. No mainnet deployment is supplied. Public BSC testnet execution and real network gas compatibility still need validation.
- **RPC trust:** runtime hashes and same-block checks detect inconsistent responses; a single malicious RPC can fabricate a consistent view. There is no independent second-source consensus.
- **Account key comparison:** a separate worker reconstructs the identity tree at epoch zero or the account-bound active tree at later epochs. The service validates public output context and re-reads the account after calculation. A match applies to that RPC snapshot and unlocked session only; it is not a publicly verifiable ownership proof, journal-freshness guarantee or signing permission. Read-only recovery remains read-only. No trusted account binding is persisted, and the local signing simulation performs its own fresh state checks.
- **Activity tracking:** saved account associations are read-only and do not prove key ownership. Transaction records are unauthenticated public metadata, stored separately from the encrypted vault. They must never authorize signing or reclaim a leaf. Results are cached until explicitly refreshed, and block confirmations from one RPC do not establish finality. Missing receipts remain uncertain. Old successful inclusion evidence is retained as historical evidence when a newer check fails. RPC URLs are not persisted or exported; an explicitly requested check still sends the account/transaction query to that provider. Report import, pending signed-payload recovery and rebroadcast are not implemented.
- **Rotation and multisig:** epoch-zero bootstrap intentionally bypasses the deadline check. The account rejects its current root, not every historical root. Multisig owner-code matching targets KeyLabAccount; BscTestAccount compatibility is not complete.
- **Resource limits:** contract tests use a broad gas limit and some generate proofs inside a test. Those totals are not transaction gas quotes or worst-case gas bounds. The activity checker limits each RPC response to 1 MiB and UI checks to 30 seconds per transaction, and checks records sequentially. Other existing RPC readers and provider rate limits still need production hardening.
- **Test material:** deterministic fixture seeds are public, and demo keys are disposable local material. Never fund these accounts on a real network. Never publish demo-runs, expose an unlocked Anvil node, or serve the repository root.

Key unfinished work includes cryptographic-parameter evaluation, browser signing with validated key/context binding, recovery and freshness guarantees across restart or devices, pending-transaction reconciliation, public-testnet validation, multisig compatibility, independent RPC comparison and an independent security audit. See [key-state design and boundaries](docs/KEY_STATE.md). Existing checks do not replace this work.

## Reproduce checks

```sh
forge test
node scripts/check-runtime-pin.mjs
node --test test/*.test.mjs
node scripts/check-public-files.mjs
gitleaks git . --redact --no-banner
```

Only serve the `ui/` directory. For future public hosting, also configure HTTPS and server response headers such as Content-Security-Policy frame-ancestors and X-Content-Type-Options; a static HTML meta policy cannot set every response-level protection.

## Reporting

Do not post seed phrases, private keys, credentials or live exploit details in public issues. For a non-sensitive bug, include the affected version, reproduction steps and expected result. For a security issue, request a private reporting channel from the repository maintainer before sharing sensitive details. A dedicated private-reporting channel is not configured by this release.
