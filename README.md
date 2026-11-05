# AURVEN

<img src="ui/assets/aurven-mark-web.png" alt="AURVEN" width="72">

- **Website:** [aurven.site](https://aurven.site)
- **Project token:** [Token details and tax use](https://aurven.site/token.html) · [Buy on Four.meme](https://four.meme/zh-TW/token/0x8614876e509c18d7be305a39a4a8d9e69c5effff)
- **BNB Smart Chain CA:** `0x8614876e509c18d7be305a39a4a8d9e69c5effff`

Experimental hash-signature smart accounts for BSC, with a Chinese / English interface, interactive 3D fund-flow simulation, public proof verification and a disposable local wallet demo.

**Local and testnet research only. Do not use with real assets. No independent security audit or validated quantum-security claim.** See [security checks and limitations](SECURITY.md).

## Quick start

Requires Node.js 22+, Python 3 and Foundry 1.8.1. Solidity 0.8.33 is pinned in foundry.toml. The static website has no package-install or frontend build step.

```sh
git clone https://github.com/AURVENwallet/AURVEN.git
cd AURVEN
forge test
node scripts/check-runtime-pin.mjs
node --test test/*.test.mjs
python -m http.server 8937 --bind 127.0.0.1 --directory ui
```

Open http://127.0.0.1:8937/ . Use the **Chinese / EN** language selector in the header; the choice persists between pages and reloads. Switching languages preserves form input, proof results and simulation progress. Exported protocol data stays language-independent. The browser does not store signing seeds.

For the local wallet demo, start a separate local chain, then run the demo in another terminal:

```sh
anvil --host 127.0.0.1 --port 8950 --chain-id 31337 --block-time 5
```

```sh
node scripts/local-demo.mjs
```

The demo creates fresh disposable keys and a new account on your own machine. Open Test Wallet and choose **Load local demo**. Generated keys, journals, receipts and build output are excluded from Git. A fresh clone has no demo record until this script completes. Never expose Anvil to the internet. Host only `ui/`, not the repository root.

## Engineering record

The sections below document successive implementation stages. Test counts and pending work in a stage describe that stage; see [SECURITY.md](SECURITY.md) for the release-check summary and known limitations.

## Latest wallet milestone: complete local flow (2026-11-05)

Using disposable public test keys, the local Anvil demo completed actual contract transactions: create an account → bootstrap its first active key tree → fund it with local test coins → sign a transfer → rotate the key tree → transfer with the new keys. The website can load this account, read its current balance, key epoch and remaining transaction leaves, expand six transaction records, copy its address, and export verified receipts and new unsigned transaction drafts. Editing transaction details invalidates an existing draft. Switching the account, network or RPC clears the associated demo state.

The local demo script performs signing and broadcasting. The browser currently reads account state, verifies receipts and prepares drafts. Browser-based encrypted key storage, the signing interface, recovery and transfers on the public BSC testnet remain incomplete.

### Run the local demo

Start Anvil at 127.0.0.1:8950 with chain ID 31337 and the web server as described below. Run these commands in the project directory:

```sh
forge build
node scripts/pin-contract.mjs
node scripts/local-demo.mjs
node --test test/client.test.mjs test/flow.test.mjs test/wallet-core.test.mjs
```

Open http://127.0.0.1:8937/wallet.html and select **Load local demo**. The script connects only to the local Anvil instance, checks the chain ID and client type before each submission, and accepts neither external RPC endpoints nor real private keys. Each run generates fresh seeds, a new account and separate journals; it does not reuse leaf indices from an earlier run. Each of the three complete 1024-leaf trees took approximately 13 seconds to build on the development machine, excluding block-confirmation time.

`demo-runs/<runId>/PUBLIC-TEST-KEYS.json` contains plaintext, public, disposable test keys that must never hold real assets. `reservations.jsonl` is written and synchronized to disk before a signature is returned. `report.json` stores the run results, while `ui/demo/local-demo.json` stores the latest public demo record. Previous run directories are retained. After the local chain is restarted or reset, the website will not treat stale records as valid receipts; rerun the demo to generate matching records. Serve only the `ui/` directory as the website root.

### Verified results and boundaries

- Recorded demo account: `0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0`, balance 0.985 local test coins, epoch 2, next 1, with 959 ordinary transaction leaves remaining. A new run changes the account address.
- All six local transactions succeeded. Account creation, bootstrap, funding, transfer, rotation and transfer with the new keys used 1,289,035 / 193,282 / 21,067 / 230,650 / 176,296 / 205,971 gas respectively. Total usage was 2,116,301 gas, with a local fee of 0.002116301014814107 test coins. These figures are neither BSC network fee quotes nor worst-case bounds.
- The contract rejected all four negative cases as expected: a tampered proof, a changed recipient, repeated execution and an old signature after rotation. Both transfers included checks of the account and recipient balance changes.
- At this stage, 28 Node tests passed: 13 client tests, 7 fund-flow tests and 8 signing-state and receipt tests. Signing-state checks cover withholding signatures until reservation completes, rejecting concurrent reuse, rejecting a leaf within the process after reservation failure, and derivation-domain separation. Receipt checks cover execution failure, reorganization, address mismatches and fee mismatches.
- The website checks each transaction, successful receipt and containing block, and reads account state only for the pinned runtime code hash. Browser checks covered loading, copying, expanding records, both export types, regenerating drafts and invalidation after edits. The six exported receipts and the draft account address were checked again.
- This stage did not change Solidity code or cryptographic parameters. The record of 43 passing Solidity tests comes from the earlier contract regression checks. No mainnet or public-testnet deployment was performed.

### Module additions and next acceptance targets

`ui/lib/evmwots.js` adds a dedicated slot 8 for BSC testnet chain 97 without renumbering existing networks. `ui/test-wallet-core.js` provides test-identity derivation, active-tree derivation separated by chain ID / account address / epoch, and a persistence callback before signing. `scripts/local-demo.mjs` deploys BscTestAccount directly. `ui/local-demo.js` validates the demo manifest, actual receipts and blocks; `ui/transfer-ui.js` connects webpage state and exports.

This stage covers the local creation and derivation portion of P0-A and the complete local transfer flow in P0-C. Chain 97's derivation slot is configured and has passed domain-separation tests, but it has not been exercised on the public testnet. P0-B currently covers only pre-signing journaling and concurrency protection in a disposable, single-process demo. The journal is not yet a recoverable wallet database, and the script does not resume old key runs. Browser encryption, cross-tab single-writer locking, crash recovery, pending-transaction handling and a stop-signing policy for old backups must be completed before browser signing and BSC testnet integration. Passing tests does not replace independent security auditing or cryptographic-strength evaluation.

The following sections retain earlier review and implementation records. Where historical descriptions say a feature is pending, use the milestone above as the later wallet-flow status.

## Review scope

The review covers network configuration, signing and verification paths, account state and local regression checks. The following records describe module responsibilities, technical limitations and the development plan.

## Networks and module mapping

| Module | Responsibility and current limitations |
| --- | --- |
| src/BscTestAccount.sol | Allows construction only on BSC testnet 97 and local chain 31337. The local demo creates accounts through direct deployment. |
| ui/lib/evmwots.js, keccak.js, sha256.js | Off-chain derivation, signing and proof encoding. EVM verification chains use Keccak; key derivation uses SHA-256. |
| src/Wots.sol | Solidity verifier. Elements are 16 bytes, with 16 message digits and 2 checksum digits, up to 255 steps per chain, tree height 10 and 1024 leaves per root. A complete proof is 448 bytes. |
| src/KeyLabAccount.sol, KeyLabFactory.sol | Account digests bind chainId, the account's own address, epoch, leaf index, deadline and call contents. Operations use separate domain tags. KeyLabFactory creates KeyLabAccount and cannot create BscTestAccount. |
| ui/test-wallet-core.js, scripts/local-demo.mjs | Disposable test keys, pre-signing journals and the local account flow. Recoverable browser key storage is not yet implemented. |
| test/ | Contract regression checks, signature-vector interoperability, client state and receipt checks. Integration between multisig and BscTestAccount still needs acceptance testing. |

## BSC architecture and risks

The offline signer generates dedicated test seeds → atomically reserves a leaf and persists it → computes the digest using the actual account address and chain ID → returns the proof and requested calls → a relayer without the signing seed simulates and submits them → Solidity reconstructs and checks the root → advances the leaf counter before executing calls. A conventional relayer EOA pays gas. Hash signatures protect account authorization; underlying consensus and relaying still use BSC mechanisms.

BscTestAccount allows construction only on chains 97 and 31337; this restriction applies only to that entry point. The local flow deploys this contract directly. An account at epoch 0 must first sign a rekey operation. Ordinary transactions use 960 leaves, with the remaining 64 reserved for rotation. Every rotation must use a fresh key tree. Historical-root detection and stop-signing rules after recovery still need implementation in the production client.

| Priority | Failure mode and controls |
| --- | --- |
| Blocking | Signing two digests with one leaf exposes hash-chain material. Persist leaf consumption before signing. After a failure, reorganization or timeout, only rebroadcast the same signature or move to a new leaf. Limit the first version to one signing device, and stop signing when an old backup is restored. |
| Blocking | The quantum-security bounds of the custom stateful scheme and its 128-bit truncation require analysis. Interoperability tests cannot establish post-quantum strength. |
| High | A malicious RPC, incorrect chain ID or encoding mismatch can produce incorrect behavior. Display the recipient, amount and chain ID before signing, read state independently, and add negative cases for cross-chain replay, changed targets and expiry. |
| High | Proof-verification gas varies with the digest, and the original test gas limit is broad. Measure verification costs from actual transaction receipts, including worst-case inputs. Whole-test Solidity gas figures include signature-generation costs. |
| High | Seed exposure or leaf exhaustion can lead to loss of control or lockout. Keep only static pages, public data and a rate-limited relayer on the server; keep seeds offline. Test rotation, recovery and power-loss scenarios. |
| Medium | RPC rate limits, faucet outages and service abuse can interrupt progress. Limit requests, simulate before submission, and continue local testing when resources are unavailable. |

## Zero-budget execution order and acceptance criteria

1. **Local baseline — complete.** Install the open-source Foundry toolchain and run `forge test` in this directory. The first run downloads solc 0.8.33. All 43 tests passed, including pre-signed execution, tampering and replay rejection, chain 97 acceptance and chain 56 rejection.
2. **Client.** Pin the JavaScript signing implementation and calculate digests using the actual deployed account address. Use public test seeds to generate bootstrap, transfer and rotation vectors for chains 97 and 31337. Verify them through the account and reject cross-domain replay.
3. **State storage.** Implement a single-writer leaf journal and interruption recovery. Test concurrent signature requests, power loss after persistence and transaction reverts. The acceptance criterion is that one leaf never signs two different digests.
4. **Local integration.** Run a single Anvil instance and Node client on the existing 6-core, 8 GB server. Deploy the test account directly and exercise bootstrap, simulated transfers, a second rotation and replay rejection. Measure tree-generation time, peak memory, calldata size and transaction gas. Do not run a BSC full node on this server.
5. **Testnet.** Verify that the RPC reports chainId 97, use a separate temporary fee-paying account and free tBNB, simulate before deployment, and record compiler settings, actual code hash, account address and receipts. Complete small test-coin transfers, tampered-proof rejection, expiry rejection and old-signature rejection after rotation. If the faucet is unavailable, retain local acceptance results and do not buy tokens for testing.
6. **Domain and hosting.** Once the preceding flow passes, the domain can serve a read-only demo. The first phase requires no additional cash spending, assuming the existing server and domain remain available. Public-testnet deployment, an online signer and independent security auditing are later work.

## Account reading and transaction drafts (2026-11-05)

### Completed additions

- The browser verifies a public signature vector and displays 11 nodes, with step-by-step playback, byte-difference highlighting and record downloads.
- The BSC black-and-gold interface supports dragging, exploded views, camera changes and zoom.
- Offline transfer drafts support amounts precise to the wei, digest calculation, invalidation after edits and export.
- Read-only RPC synchronization checks chain ID 97 / 31337, the pinned deployed runtime code hash, and balance / epoch / next / pubSeed / root at the same block. It checks the block hash again at the end of the read.
- In on-chain mode, every new draft refreshes state and sets a ten-minute deadline using block time. If epoch is 0 or next reaches 960, the UI requests rotation and refuses to generate a draft. Offline mode remains available and clearly labels manually entered state.
- Drafts record their source, snapshot and `leafReserved=false`. A future signing interface must revalidate state and reserve the leaf atomically; a draft is not a completed reservation.
- Added 13 client regression tests covering canonical amount input, digest-field binding, mainnet rejection, reserved-leaf rejection, network errors, wrong code versions, stale nodes, reorganizations and bootstrap-required state.
- Deployed the project's test account on local Anvil, read actual contract state, and confirmed that the JavaScript digest matches Solidity's `execDigest`. This account is only a state-reading sample with fixed public parameters, at epoch 0.
- All 43 Solidity regression tests passed again. Multisig and factory integration with the BscTestAccount entry point remains incomplete.

### Feature status and development plan

| Capability | Status at this stage | Next work |
| --- | --- | --- |
| Solidity WOTS verification and single-signature account | Contract regression checks pass; BscTestAccount restricts construction to test networks | Parameter-security evaluation, actual BSC gas measurements and compatibility validation |
| Network and key derivation | Reading and drafts support 97 / 31337; 97 uses dedicated slot 8 | Public-testnet interoperability, derivation versioning and migration rules |
| Account creation and bootstrap | Disposable local demo completes direct deployment and bootstrap | Browser creation flow and BSC testnet deployment |
| Seed generation, mnemonics and recovery | Local demo generates disposable public test seeds; browser custody remains pending | Encrypted storage, unlock and lock behavior, backup validation |
| One-time key reservation | Local demo persists before signing and guards against concurrency within one process; webpage drafts do not reserve leaves | Cross-tab single-writer locking, crash and recovery tests |
| Device handover and recovery reuse protection | Pending | One device in the first version, mandatory rotation after recovery, stale-copy detection |
| Account state and network checks | Fixed-block reads from one RPC, with runtime checks | Comparison against a second source, retries, continued refresh and error reporting |
| Transaction signing, fees and broadcasting | Local script completes signing, simulation and broadcasting; webpage checks actual receipts | Browser signing interface, BSC fee policy and public-testnet acceptance |
| Pending transactions and cancellation | Pending | Rebroadcast the same signature, handle timeouts, manage transaction nonces and leaf indices separately |
| Asset views and tokens | Native-coin balance reads, transaction drafts and the local transfer flow | BEP-20 balances, transfers and a receive page |
| Multisig | Contracts and 18 multisig tests exist | Update owner-code-hash acceptance, verify BscTestAccount compatibility and add a UI |
| Browser extension and USB | Current deliverable is a local webpage | Evaluate packaging after the core wallet flow passes acceptance |
| Swap / DApp | Pending | BSC routing, approval checks and a DApp connection design |
| Publishing and operations | Local preview server | Static-resource deployment, RPC quotas, version pinning, updates and rollback |
| Security evaluation | Initial source review and regression checks; independent audit pending | Independent security audit and cryptographic-strength evaluation |

### Identified technical limitations

1. CHAIN_SLOTS originally lacked 97. This stage assigns it dedicated slot 8 and verifies derivation separation. The complete local signing flow passed; public BSC testnet execution remains unverified.
2. KeyLabFactory creates KeyLabAccount. BscTestAccount has different runtime and creation bytecode, so the factory's address prediction and embedded evmcode.js cannot deploy BscTestAccount.
3. Multisig restricts owners using ACCOUNT_CODEHASH. The new subclass must be explicitly incorporated into the multisig design; existing passing multisig tests do not establish compatibility.
4. The on-chain `next` value reflects only leaves used on-chain. A leaf whose signature has been produced but not included on-chain must be protected by local persistent records. Balance and state reads cannot replace those records.
5. The 3D blocks in the verification view are an interactive illustration. Per-layer hash data comes from actual verification calculations, but the geometry does not represent the complete 1024-leaf tree.
6. The compiler configuration has a broad `gas_limit`, and some tests generate signatures inside the test function. Test gas figures must not be treated as actual transfer fees.

### Acceptance-driven next steps

| Order | Deliverable | Acceptance criteria |
| --- | --- | --- |
| P0-A | BSC-testnet-specific derivation and account creation | Use public test seeds for domain-separated derivation, deployment and bootstrap; reject incorrect chain / address / epoch |
| P0-B | Encrypted storage and leaf journal | A leaf never signs a second digest across two concurrent tabs, power loss before signing, broadcast timeout or restoration of an old file |
| P0-C | Complete local transfer | Reproduce creation → bootstrap → balance read → signing → simulation → broadcast → receipt → rotation |
| P1 | Free BSC testnet MVP | Complete the same flow on chain 97 and record actual gas and deployed runtime; continue local acceptance if the free faucet is unavailable |
| P2 | Asset and recovery experience | Receive page, BEP-20 test tokens, history, automatic locking and device handover |
| P3 | Multisig and extension packaging | New account code-hash compatibility, threshold and cancellation tests, followed by extension / USB versions |

Continue using the existing server and domain, Foundry, Node and free testing resources. Reading from a single RPC relies on that endpoint's honesty. A pinned code hash checks only the code that endpoint returns; comparison against an independent source remains unimplemented. The browser page currently stores no seeds and has no transaction-signing or broadcasting interface.

### Reproduce locally

Run in the project directory:

```sh
forge build
node scripts/pin-contract.mjs
node --test test/client.test.mjs
forge test
python -m http.server 8937 --bind 127.0.0.1 --directory ui
```

Start the local chain separately:

```sh
anvil --host 127.0.0.1 --port 8950 --chain-id 31337 --block-time 5
```

Create the state-reading sample only on that local chain:

```sh
forge create src/BscTestAccount.sol:BscTestAccount --rpc-url http://127.0.0.1:8950 --unlocked --from 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 --broadcast --constructor-args 0x11111111111111111111111111111111 0x22222222222222222222222222222222
```

Copy the deployed address, select Anvil in the UI, enter the address and http://127.0.0.1:8950, then select **Sync account state**. The expected state is **Bootstrap required**. Run the read-only interoperability check:

```sh
node scripts/check-local.mjs <deployed-address>
```

After changing Solidity code, compiler settings or optimizer configuration, rerun pin-contract.mjs and deploy the corresponding new bytecode. The local sample address recorded at this stage is 0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512; its fixed parameters are for local state reading only.

Verification visualization: `rootFromProof` in ui/lib/evmwots.js provides an optional `onLevel` callback to return intermediate nodes and drive the verification-path display.

## Key Lab protocol naming migration

The delivery directory was renamed to bsc-key-lab. Contract and test types use KeyLabAccount, KeyLabFactory, KeyLabMultisig and KeyLabMultisigFactory. Execution, rotation, factory salts and key-derivation domains consistently use the keylab prefix.

The multisig owner check is calculated automatically from the compiled KeyLabAccount runtime. Embedded client creation bytecode, the pinned account runtime, Solidity interoperability fixtures and browser public vectors were regenerated. All 43 contract tests and 13 client tests passed. The browser accepted the original vector proof and rejected its tampered variant.

After migration, use newly deployed accounts and newly generated signature data. The local sample address at this stage is 0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512. This account remains a public state-reading sample at epoch 0.

Complete regeneration order:

```sh
forge build
node scripts/generate-code.mjs
node scripts/pin-contract.mjs
node scripts/generate-fixtures.mjs 0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f
forge test
node --test test/client.test.mjs
```

generate-fixtures writes both contract interoperability data and browser public-proof samples. It generates three complete 1024-leaf trees and takes approximately one minute on a typical desktop.

## Website version two: precision vault (2026-11-05)

The website now has five independent static pages: index.html for Overview, flow.html for Fund Flow, lab.html for Proof Lab, wallet.html for Test Wallet and token.html for Project Token. The token page displays the contract address, a Four.meme purchase link and the project's explanation that token-tax revenue supports development and testing. The main navigation provides a direct GitHub link. Navigation changes the URL; pages support direct access, reload, back and forward.

The homepage uses graphite black and BSC gold, with an explorable vault, an authorization journey, a one-time-key explanation, development progress and frequently asked questions. The fund-flow page shows the signer, smart account, recipient, gas-paying account and network-execution node. The Proof Lab uses 11 three-dimensional nodes for the computed leaf and its 10-level verification path.

Scenes are generated from local geometry, materials and lighting using the pinned local Three.js 0.187.0 dependency, with no external CDN requests at runtime. Frames, crystals, verification layers, gates and paths are actual 3D meshes. Controls support pointer dragging, keyboard camera changes, zoom, object focus, exploded views, staged playback, timeline scrubbing, result branches, simulated amounts and playback speed. On mobile, playback controls sit below the scene and the explanatory panel has its own layout.

Fund flow is entirely a local browser simulation, with fixed starting demo balances and a 0.0001 BNB fee. flow-state.js is the single state source for the scene and balances: rejected verification does not transfer principal, fees are shown separately, and scrubbing backward can restore starting balances. Actual account state is read only on the Test Wallet page. The 3D simulation does not sign or broadcast transactions.

Reduced-motion mode advances in steps. Static scenes render on demand, and playback stops when the page is left. If 3D initialization fails, static explanations remain available, along with proof calculations and forms. Fallback and reduced-motion branches are implemented; browser acceptance at this stage did not simulate GPU failures or change the operating system's motion settings.

Main interface files:

- ui/v2.css: shared visual styles and responsive layout.
- ui/vault-scene.js: 3D scenes for the homepage vault, fund flow and verification path.
- ui/flow-state.js, ui/flow.js: deterministic simulation state and interaction controls.
- ui/app.js: actual public-proof verification and path display.
- ui/transfer-ui.js: account synchronization and drafts; restores the correct state source and read-only fields after history navigation.

Start the preview from the project directory:

```sh
python -m http.server 8937 --bind 127.0.0.1 --directory ui
```

Open http://127.0.0.1:8937/ . Use an HTTP server; opening the HTML file directly is unsuitable for loading these modules.

Validation at this stage: 18 Node tests passed, comprising the original 13 client tests and 5 new fund-flow state tests. Browser checks covered 3D dragging, opening and closing the homepage vault, continuous playback, successful transfer, invalid-proof rejection, original and tampered public proofs, offline draft creation and local account reading. The four pages available at that stage were checked on desktop and at a 390px viewport, with no horizontal overflow observed. Navigation, back, forward, reload and page-resource checks passed.

This stage did not change contracts or cryptographic parameters. The previously recorded 43 Solidity checks belong to earlier contract acceptance. All interfaces remain development prototypes. Complete signing, persistent leaf reservation, broadcasting and public BSC testnet transfers remained follow-up work at this UI stage.

The fund-flow page also includes six directed connections: the signer delivers authorization to the gas-paying account; that account submits the transaction and pays fees separately; the network executes the smart-account contract; the account transfers principal to the recipient; and the network returns the execution receipt to the payer. The network node represents execution of the same transaction, not a receiving address. Authorization and calls use dashed silver lines, principal uses solid gold, fees use solid copper, and receipts use dashed blue-gray lines. Clicking a node highlights its direct connections and explains what each carries. The topology is defined in ui/flow-topology.js. After timing and receipt checks were added, all 7 fund-flow state tests passed.

## AURVEN branding and metallic controls (2026-11-05)

The four pages available at this stage were renamed consistently to AURVEN, including page titles, headers and footers. The selected folded-ribbon A mark uses a small transparent version with complete edges and a more visible dark-gray inner face. The asset is ui/assets/aurven-mark-web.png. The navigation mark no longer uses enlarged background cropping or blend modes.

ui/aurven-materials.css gives primary actions and selected states a gold metallic surface, and secondary actions a black-and-gold surface. It covers navigation, playback, zoom, 3D nodes, steps, verification levels, selectors, inputs, sliders and expandable explanations. Controls preserve keyboard-focus, disabled and read-only states. ui/aurven-materials.js updates reflections only when the pointer moves over a button; it runs no continuous animation. Reduced-motion settings disable tracking reflections and movement effects. Mobile fund-flow framing and label positions were adjusted to avoid overlapping the title and description.

Local resource-reference checks for all four pages and relevant JavaScript syntax checks passed at this stage. Browser checks on desktop and at 390px found no horizontal overflow. Opening and closing the vault, module selection, playback completion, keyboard scrubbing, acceptance of original proofs, rejection of tampered proofs, state-source switching, read-only fields, offline draft generation and export-button availability behaved as expected. These control styles retained the existing account and cryptographic behavior. No public-network signing, broadcasting or asset operations were performed during this UI stage.
