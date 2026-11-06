# BSC wallet release readiness

Updated 2026-11-06. An encrypted browser vault created a reusable smart account on BSC testnet (chain 97), signed two transfers, rotated to a fresh active tree, and signed a third transfer from the same address. Two separate browser profiles also completed a public testnet handover and the receiver signed a one-wei transfer. A [local lost-device drill](KEY_STATE.md#lost-device-rehearsal) tested standby takeover and an orphaned recovery receipt. Public lost-device recovery, deep reorganization drills and independent security review remain open.

## BSC mainnet deployment rehearsal

On 2026-11-06 at 08:20:16 UTC the two BNB Chain endpoints listed below agreed on finalized block [131975685](https://bscscan.com/block/131975685), hash `0x65799fa2ef0d0e34055b6d03ac6aabd58d5c05952fcbbf7b2a6fbee2d6711b9e`. Both executed the compiled generic factory and account against that block using read-only RPC calls. The rehearsal requires no payer, wallet connection or private credentials. Real fees paid were **0 BNB**.

| Observation | Result at both endpoints |
| --- | --- |
| Factory creation | 1,593,325 gas estimated. Both nodes quoted 0.05 gwei, equivalent to 0.00007966625 BNB for the factory alone at that price. |
| Factory runtime hash | `0xf8ab4f37676498d1425e17f218b6096cbc23ece3fbd3ad0480039a044a28ec1a` |
| Account runtime hash | `0xfde1d7b52ce9867d45e45472c64e146e5dd3faa19aa05ed7339659b600f18144` |
| Successful calls | Factory creation, predicted-address account creation, activation, a one-wei transfer, rotation and a one-wei transfer using the new root. Final epoch 2, next leaf 1. |
| Rejected calls | Transfer before activation, replay of a consumed leaf, an authorization for chain 97 and a still-unexpired transfer signed by the retired root. |

Run from a clean checkout with the pinned Foundry and Node.js versions:

```sh
forge build
node scripts/mainnet-rehearsal.mjs
```

The script queries `bsc-dataseed.bnbchain.org` and `bsc-dataseed-public.bnbchain.org`. Each run selects a recent common finalized block and checks its hash before and after simulation. It compares the compiled creation code with the client pins, estimates standalone factory creation, then executes the account lifecycle inside a single temporary EVM call per node. The executor, three fixture wei and disposable test keys exist only for this simulation. The script accepts only read RPC methods and checks the fixture addresses for existing code, funds and nonces. A run creates no on-chain contract, transaction hash or fee obligation. Both endpoints may share infrastructure. [Official endpoint list](https://docs.bnbchain.org/bnb-smart-chain/developers/json_rpc/json-rpc-endpoint/).

### Atomic mainnet account setup

The rehearsal also runs the chain-56-only `BscMainnetFactory`. It predicts the CREATE2 address using the identity seed, identity root, factory address and pinned account creation code. A single nonpayable call creates the account and installs its first active root. Before creation the factory checks the expected address and a deadline at most one hour ahead. It exposes no separate creation entry. If proof verification fails, the EVM rolls back account creation. Any caller can relay an already valid authorization to install the exact root the owner signed. A later attempt at the same address reverts. Observing the intended active root is necessary before treating a lost submission reply as a failure.

Both official endpoints estimated and executed the compiled factory at the same finalized block. Each run built two complete 1,024-leaf trees from fresh disposable inputs before sampling the final block. The nodes first rejected a corrupted proof and checked that the account address still had no code. They then created and activated the predicted account, rejected duplicate creation, and executed a one-wei transfer authorized by active leaf 0. The funded fixture and its state disappeared at the end of the call. The script compared the created factory and account runtime hashes to the build and verified the factory's pinned creation and runtime hashes.

| Finalized block (UTC) | Deploy chain-56 factory | Create and activate one account | Real fee |
| --- | ---: | ---: | ---: |
| [131979141](https://bscscan.com/block/131979141), 2026-11-06 08:46:11 | 1,752,963 gas | 1,460,078 gas | 0 BNB |
| [131979509](https://bscscan.com/block/131979509), 2026-11-06 08:48:57 | 1,752,963 gas | 1,522,741 gas | 0 BNB |

At block 131979509 (`0x74d7299e67b0d0c8db372b2f8911b5fe9079311cbf0fd398057c5a8351f91373`) both endpoints quoted 0.05 gwei. The estimates cover two separate operations. A factory can serve multiple accounts and the verification cost varies with the proof. The factory runtime hash was `0x5c6acbf647dd904587d5d3511a42aea596a4ef23e9ae85b83e236b62ec356101`. One earlier attempt stopped when a node did not return an activation estimate. Missing evidence from either endpoint fails the run. Rerun the command above for fresh keys and a new block. The report's `atomicSetup` object describes this factory; top-level factory and rotation results refer to the original generic scenario.

The public wallet still uses chain 97. Production seed custody, persistent reservations on chain 56, independent recovery after device loss, and an independent review of the cryptography and contracts are open. [Key derivation and recovery limits](KEY_STATE.md#bsc-mainnet-rehearsal-keys).

## Reusable browser account

Open the [reusable account panel](https://aurven.site/wallet.html#managedAccount) and unlock an original chain-97 test vault in the same browser profile. Connect a separate test wallet with faucet tBNB to pay gas. Account creation deposits three wei. Each transfer of one wei, key rotation or top-up of three wei has its own fee preview and payer confirmation.

On 2026-11-06, Edge generated the hash-based authorizations for smart account [`0x1b1853d31d483dceae241b0dca77ec4997ddd49a`](https://testnet.bscscan.com/address/0x1b1853d31d483dceae241b0dca77ec4997ddd49a). A test provider backed by the dedicated faucet payer signed the outer transactions. Two official nodes verified the receipts. The payer received all three one-wei transfers.

| Action and signing leaf | Mined block | Gas used |
| --- | ---: | ---: |
| Create, activate epoch 1 and deposit 3 wei (bootstrap leaf 8) | [141083856](https://testnet.bscscan.com/tx/0x7ed70a1b90004fb20718860626b46b287c0ecc62eefb5f39ba4ac154efaf2475) | 1,546,083 |
| Transfer 1 wei (epoch 1, leaf 0) | [141083916](https://testnet.bscscan.com/tx/0x5c39e386b21d431e34491981e43fc950ed8f2ba9d0a90845108765469c01500d) | 182,397 |
| Transfer 1 wei (epoch 1, leaf 1) | [141083977](https://testnet.bscscan.com/tx/0xd4375fec221a613bbe4caddc53fc04b00c6eb64214d5e5b87913b3f3e556a953) | 203,416 |
| Rotate to epoch 2 (epoch 1, leaf 960) | [141084075](https://testnet.bscscan.com/tx/0x9df38d9e37eb01e9bcaedf6a207e69fdb58e5b052b0854d5fe5c5cb5df78b69e) | 197,131 |
| Transfer 1 wei (epoch 2, leaf 0) | [141084144](https://testnet.bscscan.com/tx/0xa8d63f807531fb2d545a5f09aac3871159000166a696aae82cacfb4930a27835) | 203,423 |

The payer reply to the second transfer was deliberately dropped. After reopening the page and unlocking the vault, the browser found the original transaction by payer and nonce. A read-only replay of its exact calldata returned `BadSignature` at block 141084082 under the new root. At that block the old approval was still within its deadline, leaf 1 was eligible and the account held one wei. The final transfer used leaf 0 of the new tree and left the account at epoch 2, next leaf 1, balance zero. The five transactions cost **0.000233245 tBNB** in total. The replay required no transaction or fee.

The browser stores up to eight account creations (including unresolved creations) and 32 public action records. At capacity it discards the oldest eligible settled action or expired preparation. It keeps confirmed account creations and unresolved wallet requests. Encrypted leaf reservations are stored separately and never pruned. Imported vaults are read-only. Retail wallet compatibility and recovery after losing the original device still require testing.

## Checking interrupted and replaced payments

Select an action in the reusable account's history and choose **Verify with both nodes**. A locked vault can check public records. The displayed block identifies when a result was last verified.

| What the node reports | What the wallet displays |
| --- | --- |
| A known transaction is pending, or its hash cannot be found and its nonce is unused | Pending and unseen have separate messages. An absent hash alone cannot establish that a payment was permanently dropped. |
| A canonical transaction consumes the same payer nonce with different calldata, value or destination | A link to that different transaction. An exposed, unexpired account authorization can still be submitted by another payer. |
| Another hash carries the same intended action and passes the receipt and contract checks | The included action with a link back to the original known hash. |
| The previously verified inclusion leaves the canonical chain | A reorganization notice. If the same transaction is later included at a new block, the panel reports the new inclusion. |
| A signed action remains unmined beyond its on-chain deadline | Authorization expired as of the checked block. A plain top-up has no on-chain expiry. A mined revert is reported separately. |
| A node is behind, lacks the required history, or changes its anchor block mid-check | The check fails. The last saved receipt stays labeled as a previous observation. |

On 2026-11-06 a disposable local Anvil chain reproduced a dropped transfer, nonce replacement, a fee change that preserved the action, removal of a mined block and re-inclusion. A mobile-width Edge session reopened its history with the vault locked. After an alternative transaction consumed the payer nonce, a newly approved transfer used leaf 1; the orphaned transfer had consumed leaf 0 locally. The recipient received exactly one wei. The client also rechecked the [existing chain-97 receipt at block 141083977](https://testnet.bscscan.com/tx/0xd4375fec221a613bbe4caddc53fc04b00c6eb64214d5e5b87913b3f3e556a953) against two public nodes. These checks issued no new public payment. The reusable account panel now queries two chain-97 endpoints for each receipt check.

### Two-node receipt checks

Open the [public receipt](https://aurven.site/wallet.html#publicReceipt) and select **Check public receipt** to query the two endpoints for a previously published one-wei transfer. It works without a payer or vault and does not add the example to personal history. A saved action uses the same reader.

Each endpoint must report chain 97 and a recent head. The reader compares the hash and timestamp at the lower of their two heights, then verifies the observation through each endpoint at that height. For a matching mined action it compares the transaction, inclusion block, gas and fee. For a different payment at the same nonce it compares the replacement hash and inclusion block. If the nonce is consumed before a node can return the indexed transaction or its receipt, the reader retries once using fresh heads. The checked height and the transaction's inclusion height can be different.

If only one endpoint completes the check, the panel identifies the responding source and displays its provisional result. A fork, conflicting transaction evidence, or an outage of both endpoints leaves the saved state intact. Refreshing after service returns reruns both checks. The current check and the earlier saved state remain distinguishable after reopening the page. A disputed account creation needs another matching check before the browser can use it.

Edge and automated tests exercised different head heights, constrained history, loss of either endpoint, conflicting blocks, both endpoints offline and recovery. The browser read the published transfer at block 141083977 with both endpoints. These drills used read-only requests. The endpoints may share infrastructure. Agreement provides an additional check on the reported chain view. The connected payer wallet handles submission. The supplemental live balance display and old-authorization simulation use the primary endpoint. [BNB Chain endpoint list](https://docs.bnbchain.org/bnb-smart-chain/developers/json_rpc/json-rpc-endpoint/).

### Two-node signing checks

The reusable account panel checks account creation, one-wei transfers, active key rotation and top-ups against both testnet endpoints. Each preview shows the shared block number. For an existing account it also shows the epoch and the on-chain next leaf. The encrypted local journal can require a higher signing leaf.

The nodes must agree on a block within 30 seconds of the local clock. At that block the wallet checks the account runtime against the compiled pin, the public seed, root, epoch, next leaf and balance. Creation checks the predicted setup and child addresses for existing code or a used nonce. Each endpoint must confirm the payer's nonce, pending nonce, ordinary wallet code and sufficient tBNB for the requested amount and fee limit. The transfer recipient must also be an ordinary address. The primary node supplies the gas price quote within the existing cap. When one node has a newer sampled head, its signing state must also match. Later checks confirm the original preview block is still on the reported chain.

The vault repeats these checks before preparing the proof, before committing the encrypted leaf reservation and before releasing the signed calldata. The browser checks again before opening the payer wallet. Failure before the reservation leaves the usage journal untouched. Failure after commitment keeps the leaf consumed. A change while the external wallet is awaiting the user's decision remains possible. The account contract checks authorization, deadline and the current signing state on execution.

On 2026-11-06 a mobile-width Edge drill used two endpoint routes backed by a disposable local chain. One simulated endpoint went offline before reservation, and then in a separate attempt after reservation. The payer received neither request. After recovery the next approved transfer used leaf 1 and delivered exactly one wei. Both public endpoints also completed read-only creation and rotation previews. The public sample account reported epoch 2 and next leaf 1. This release sent no new public transaction.

### Read-only backup recovery drill

Two isolated Edge profiles exercised device loss on a disposable local chain configured as chain 97. The first profile created a three-wei account and saved a backup. The second imported it and found the candidate address before making an account lookup. The first profile then spent one wei. Comparing its earlier file reported an older journal. Comparing a fresh export reported matching records.

Two endpoint routes served the same local chain. The restored profile rebuilt the matching active root, read two wei and identified leaf 0 as missing from the backup. Disconnecting one endpoint cleared the result. Reloading and unlocking kept the imported profile read-only. The local handover drill below covers a working original signer. Independent authorization after losing that signer remains open.

A separate read-only run queried the public BSC testnet sample account at block 141095378 from a newly restored, unrelated vault. Both endpoints returned epoch 2, next leaf 1 and zero wei. The local root comparison correctly reported a mismatch.

### Local two-profile handover

Two isolated Edge profiles exercised the local launcher on chain 31337. The original profile paired the account and signed a simulated transfer at epoch 1. The receiving profile generated its own epoch-2 root. An incorrect fingerprint consumed no source leaf. The original profile then submitted the rotation using leaf 960. After a reload, the receiver checked the retired-key proof, exact calldata, receipt, canonical inclusion and current root. Its first transfer simulation succeeded. Replaying the old, unexpired transfer at the same address returned `BadSignature`.

The drill requires one subsequent local block. Automated checks cover an altered or expired offer and a chain rollback. The chain-97 pilot below uses a separate finalized-receipt policy. Historical-root enforcement and independent lost-device recovery remain open. [Run the two-profile drill](../README.md#rehearse-a-device-handover).

### Recovering a rotation after a lost reply

The receiving browser can verify a portable public record on chain 97. Both BSC testnet endpoints must report fresh finalized heads and agree on the common block. The verifier checks the payer and nonce, canonical inclusion, transaction destination and value, calldata hash, the WOTS proof against the expected source key, the new-epoch event, and the pinned account's current key state. It rereads the finalized heads and the common block before showing a result. A missing or contradictory observation clears the previous result.

On 2026-11-06 both public endpoints rejected the historical filtered log query and reported pruned historical nonce state near the published epoch-2 rotation. With the transaction hash omitted, the browser found the payment in block **141084075** by reading block bodies. Both endpoints confirmed the receipt and the active epoch-2 root at common finalized block **141103334**. The bundled example starts five blocks before inclusion. Exports from the managed wallet use the actual preview start block. This public check observed an existing same-vault rotation. [Published transaction](https://testnet.bscscan.com/tx/0x9df38d9e37eb01e9bcaedf6a207e69fdb58e5b052b0854d5fe5c5cb5df78b69e).

Two local interruption drills withheld the sender's reply after submitting a real rotation to Anvil. On chain 31337 the receiving profile recovered the cross-device handover hash and the original journal retained its rotation leaf after reload. Separately, on a chain-97 fixture the locked managed wallet exported its rotation record. A clean browser recovered the exact hash from that file without a wallet or a second submission. Withholding one endpoint suppressed the result. The chain-97 fixture used two routes to one local node. The public handover pilot below exercises the signing path. The manual payment retry below covers an unmined handover after its signed data has been saved. Independent recovery after losing the original signer remains open.

### Public two-profile handover

On 2026-11-06 two isolated Edge profiles on one computer created separate encrypted vaults. The source created a fresh [BSC testnet smart account](https://testnet.bscscan.com/address/0xba8ac0bd1bedc0b7948a491ea8f9d0b2a02c687d). The receiver generated its own successor key. A mismatching fingerprint stopped the source before signing. After reviewing the matching fingerprint the source authorized a rotation. Both profiles used the dedicated faucet payer for gas.

| Operation | Mined block and receipt | Gas used |
| --- | ---: | ---: |
| Create the account, activate epoch 1 and deposit 3 wei | [141107976](https://testnet.bscscan.com/tx/0x24df180a9e9650315a41b5e404e635cc8150813b5545b3748feb5c630c4bcd47) | 1,546,071 |
| Hand over to the receiving vault, epoch 1 leaf 960 | [141108169](https://testnet.bscscan.com/tx/0xd9a529c08102ec3e36b931af171edc78c438b87032bce0fd142a9ff8343c39d1) | 197,155 |
| Transfer 1 wei from the receiving vault, epoch 2 leaf 0 | [141108305](https://testnet.bscscan.com/tx/0xe73f994fce608776b2c01a48a96b1ee321b98e09793e9ae463947fd616feed8f) | 182,306 |

The receiving profile matched the public record to its saved request, verified the WOTS signature and finalized receipt on both endpoints, then reloaded and unlocked its own vault before signing. At shared finalized block 141108830, both endpoints reported epoch 2, next leaf 1 and a balance of 2 wei. A subsequent signing attempt in the old profile stopped at the root comparison before another leaf reservation or payer request. Total gas fees for the three transactions were 0.0001925532 tBNB. The trial used independent browser storage and a constrained test payer on one machine. Physical-device, retail-wallet and independent recovery testing remain open. [Try the public testnet flow](https://aurven.site/wallet.html#testnetHandover).

### Resuming an interrupted handover payment

The source reserves its one-time leaf before signing. Before requesting payment, it commits the signed calldata encrypted under the original vault key to the local action history. The request binds the saved fee limit, gas price, payer nonce and receiving fingerprint. Retrying explicitly asks the payer to approve the same terms after two endpoints agree that the original payment is unseen and both the confirmed and pending nonce are still free. The vault checks the authenticated payment, the reserved leaf and the WOTS proof. The retry has no signing worker. The original prompt and every retry share a Web Lock for that chain-97 payer and nonce.

A local two-profile drill rejected the first payer prompt, submitted the second to an unmined pool, then dropped it and reopened the source. The retry was blocked while the transaction was pending and while another tab held the payment lock. After eviction the receiver verified the rotation and transferred one wei. The payer requests matched byte for byte and the source used one handover signing leaf.

On 2026-11-06 a second drill on BSC testnet used two separate Edge profiles and a constrained faucet payer. It [created a fresh account](https://testnet.bscscan.com/tx/0x4a3c43beb71654c10b2d02df2511b15dfbff3dd0fd5a1087c75f4f23a20778a8), deliberately declined the first request before broadcast, then reloaded and unlocked the source. The saved authorization produced [one mined rotation at block 141111637](https://testnet.bscscan.com/tx/0x83a2bae8cf548b264a7cf215685dc58b1b0961a3a563f403c87bc8b9d3c0388c). After receipt verification and reload the receiver [sent one wei from epoch 2, leaf 0](https://testnet.bscscan.com/tx/0x8ec08be3fa2d5d016cb65b61d6ab1ed2b6be7c2159e0ff208348084b9d19fb34). Both endpoints agreed at finalized block 141111925 on all three receipts, epoch 2, next leaf 1 and a two-wei balance. Total fees were 0.0001925587 tBNB. The mempool eviction was exercised locally.

Once the encrypted payment exists, the original active vault can reopen it. The manual retry stops on an expired authorization, changed signing state, fee mismatch, occupied nonce, a pending or included transaction, or incomplete evidence. For new handovers, the encrypted reservation also commits the exact message digest, randomizer, salt and a hash of the original fee request. If the browser closes before the signed payment is saved, unlock the original vault and select **Recover authorization from reserved leaf**. The worker reconstructs only that same proof and seals the payment locally. The review and payer confirmation are separate steps. Imported backups, public receipt exports and legacy reservations without this commitment cannot reconstruct the proof.

Two isolated Edge profiles on a disposable chain-97 node rehearsed two interruptions: closing after reservation but before signing, and aborting the payment storage write after signing. Each source reloaded, reconstructed its reserved authorization and kept a single reservation. In the second drill the reconstructed calldata hash matched the original. Recovery did not open the payer. After explicit approval each receiver verified the rotation, reopened its vault and sent one fixture wei. Losing the original vault or the action history still prevents this recovery. The two RPC endpoints may share infrastructure, and an external payer controls the outer transaction it submits.

## Disposable browser transfer


Open [Test Wallet](https://aurven.site/wallet.html#testnetTrial) in a browser with an injected payer wallet on BSC testnet and enough faucet tBNB for gas. Connect, enter a regular recipient address and preview both addresses and the maximum fee. The payer wallet asks for one contract creation with a value of one wei. The constructor checks chain 97, creates a pinned smart account, activates a fresh tree, funds it and executes the one-wei transfer in the same transaction. A failure reverts all these steps. The browser generates the one-time keys in a disposable worker, commits each signing leaf to IndexedDB before signing and discards the keys afterwards.

On 2026-11-06, Edge produced the account authorizations and a test provider backed by the dedicated faucet payer signed the outer transactions. The first public run consumed 1,716,683 gas. Its provider restricted log searches, which exposed a gap in recovery when the wallet response was lost. The next version also locates the mined payer nonce in block history. A second public run deliberately dropped the wallet reply; after reloading, the browser found the original hash and verified the receipt without another payment or a pasted hash. It consumed 1,737,498 gas and cost 0.0001737498 tBNB. Both trials returned one wei to the payer, and a second official endpoint verified both receipts. [First browser receipt](https://testnet.bscscan.com/tx/0x0570e01f2608c1f503608cc249a81c854882959b473beb32939c8c026169d05e) · [Receipt recovered after reload](https://testnet.bscscan.com/tx/0x96b45367b4f3f5761610e6ee22bd168c26474e1244df998ee98155c972176a26).

Trial history keeps at most 32 records in the current browser profile. Recovery checks the original payer, nonce, value, creation data hash, canonical block, contract events and account code. A node that restricts historical reads may need the transaction hash from the payer wallet. The page only checks on request or immediately after submission. It never automatically resubmits. Clearing browser data removes local context. This release has no device recovery, further transfers from the disposable account, or verification matrix for individual wallet extensions.

## First mined testnet transfer

A fresh payer received faucet tBNB and created the smart account `0x84223b72b46e20748861b9536aa96132e31a3b3f`. The payer activated its first signing tree and funded the account with one wei of tBNB. The account used leaf 0 to return that wei to the payer. Its final balance was zero, the epoch was 1 and the next permitted leaf was 1. The pilot discarded the signing seeds. Use the published account only for observation.

| Operation | Mined gas used | Public receipt |
| --- | ---: | --- |
| Create the smart account | 1,289,010 | [Deployment](https://testnet.bscscan.com/tx/0x60938636335b179e7eabc61a03ccd97c81fafdb2f858d9ee56a2942e8f9b5bf2) |
| Activate the first signing tree | 193,385 | [Activation](https://testnet.bscscan.com/tx/0xad5e2feb8ccd6eae311f17be0617538ffbabab04a82cde47fcd4b2680e673aaa) |
| Fund the smart account | 21,067 | [Funding](https://testnet.bscscan.com/tx/0xc7246721bdd65e44f87b6a83449f9f1d31127b37e6ae162528a52d880cf56374) |
| Execute the native transfer | 203,411 | [Transfer](https://testnet.bscscan.com/tx/0x9e36f3ac70946345ed88afe3f6a6f2f76ea317bf07fb1bdb21b5053b6c34c7e2) |

Two official endpoints agreed on the four receipt hashes, block hashes, fees and final account state. The payer spent 0.0001706873 tBNB in total fees. The locally signed transfer used a selected salt, so its verification work differs from the fixed-salt gas fixtures below.

### Reproduce the disposable command-line pilot

Use Node.js 22+, Foundry 1.8.1 and a fresh dedicated payer with nonce zero. Build with `forge build`. Set `ETH_KEYSTORE` to its encrypted Foundry keystore file and `ETH_PASSWORD` to the path of its private password file. Keep both outside the repository. Obtain only test tBNB. [BNB Chain's faucet instructions](https://docs.bnbchain.org/docs/bsc-faucet/).

```sh
node scripts/testnet-pilot.mjs prepare <testnet-payer-address>
node scripts/testnet-pilot.mjs submit <testnet-payer-address>
```

Preparation reserves each one-time leaf on disk before signing, signs four fixed transactions offline, and saves their exact bytes and hashes together under the ignored `demo-runs/testnet97/` directory. Keep this directory private. Anyone with the signed bytes can submit those specific test transactions. The transfer has a 30-minute deadline. If submission is interrupted, rerun **submit** with the same address and directory. It checks each saved hash and only resends the original bytes if the transaction is absent, its nonce is available and the deadline has time left. An expired, reverted or conflicting run requires inspection. Signing seeds are never saved, so this trial cannot restore the account or sign another transfer.

The local Anvil regression exercises a lost submission reply after the transfer is mined, a rollback that removes that transfer, and an expired retry. It verifies that the confirmed transfer is found without sending again and that a missing transfer can be replayed with identical bytes and hash.

## What the testnet can execute today

Two official BNB Chain RPC endpoints returned identical estimates at each of the following chain-97 blocks. Values are gas units for one fixture per operation. Each fixture starts independently. These observations do not establish worst-case costs.

| UTC on 2026-11-06 | Block and hash | Direct account creation | Native transfer | Active-key rotation |
| --- | --- | ---: | ---: | ---: |
| 03:02:36 | `0x8689e1f` · `0x7858edb0bb37f955ff092209fca0e635208122a7091f986ecc244f4607a12f12` | 1,300,407 | 275,522 | 262,331 |
| 03:04:03 | `0x8689ee0` · `0x0c5314557391e9fd36d37cf3c5768951a2b6f902174582a0d193f45df15c440c` | 1,300,407 | 337,989 | 283,396 |

The tool checks that the simulated constructor returns the wallet's pinned runtime. For transfer and rotation it temporarily supplies account code, balance and storage to the RPC. A public 448-byte fixture and the exact message digest determine the synthetic verification root. Transfer sends one simulated wei to an empty address using leaf 0. Rotation uses leaf 960 in epoch 1. Both use salt zero. The deadline depends on block time, which changes the digest and the number of verification hashes. This exercises the verifier and account code without creating a spendable wallet, producing a private key or broadcasting a transaction. Deployment covers only direct creation, before funding and initial key rotation.

Run from the repository root with Foundry and Node.js 22+. The first run picks a recent block. Pass its hexadecimal block number to the second endpoint immediately. Public nodes may prune state for older blocks. An archive-capable RPC is needed to replay those snapshots.

```sh
forge build
node scripts/testnet-gas.mjs https://bsc-testnet.bnbchain.org
node scripts/testnet-gas.mjs https://bsc-testnet-dataseed.bnbchain.org <hex-block-number>
```

The tool checks chain ID 97 before measuring, pins all calls to one block number, replays each operation at its quoted gas and checks the block hash again. It requires support for RPC state overrides. Automated tests run on disposable local Anvil, independently of the public endpoints. [Official RPC endpoints](https://docs.bnbchain.org/bnb-smart-chain/developers/json_rpc/json-rpc-endpoint/).

## Release gates and planning range

These estimates assume continuous development of the single-signer native-coin wallet, timely independent review and no major redesign. Work on later gates can overlap with testnet development. A change in the signature scheme, recovery design or reviewer availability requires a new estimate.

| Milestone | Planning range from this baseline | Evidence required to pass |
| --- | --- | --- |
| Single-device public testnet pilot | Basic path completed on 2026-11-06 | Five mined actions and recovery after a lost payer reply are recorded above. Local drills now cover dropped, replaced, reverted and reorganized payments. Remaining pilot work includes retail wallet compatibility, testing against restricted RPC history and observing a wider range of public network conditions. |
| Recovery and pilot | Allow a further 4–8 weeks for engineering and drills | Extend crash recovery to other signed operations and repeat interrupted handovers on physical devices. Reproduce receipt recovery across independent RPC outages, deep reorganizations and device loss while preserving every previously used leaf. Repeat standby takeover across physical devices and independent testnet endpoints. Test standby replacement, historical-root rejection and fail-closed behavior after restoring an old profile. Run a public testnet pilot through those scenarios. |
| Public real-asset wallet | Conditional planning range of 3–6 months total | Obtain independent cryptographic parameter and contract/client reviews, fix and retest findings, and publish results. Resolve custody and key-reuse findings before launch. Verify network-specific builds, deployment reproducibility, live monitoring, incident response and a funded mainnet gas payer. Obtain explicit mainnet deployment approval. |

With the existing server, local tools and faucet tBNB, early testing can proceed on the current budget. The independent review needs a confirmed volunteer, sponsor or funding. Mainnet deployment needs real BNB for gas. Until those resources and the technical gates are satisfied, a public launch date is open. [BNB Smart Chain testing and gas](https://docs.bnbchain.org/bnb-smart-chain/developers/quick-guide/) · [Key management and recovery](KEY_STATE.md) · [Current security status](../SECURITY.md).
