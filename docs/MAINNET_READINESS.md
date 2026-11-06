# BSC wallet release readiness

Updated 2026-11-06. An encrypted browser vault created a reusable smart account on BSC testnet (chain 97), signed two transfers, rotated to a fresh active tree, and signed a third transfer from the same address. Lost-device recovery, reorganization drills and independent security review remain open.

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
| Single-device public testnet pilot | Basic path completed on 2026-11-06 | Five mined actions and recovery after a lost payer reply are recorded above. Outstanding pilot cases include expired, dropped, replaced, reverted and reorganized submissions, plus compatibility with retail wallets. |
| Recovery and pilot | Allow a further 4–8 weeks for engineering and drills | Persist the exact signed payload before releasing it. Reconcile pending, dropped and reorganized transactions without signing twice with a leaf. Demonstrate safe device handover, lost-device recovery, historical-root rejection and fail-closed behavior after restoring an old profile. Run a public testnet pilot through those scenarios. |
| Public real-asset wallet | Conditional planning range of 3–6 months total | Obtain independent cryptographic parameter and contract/client reviews, fix and retest findings, and publish results. Resolve custody and key-reuse findings before launch. Verify network-specific builds, deployment reproducibility, live monitoring, incident response and a funded mainnet gas payer. Obtain explicit mainnet deployment approval. |

With the existing server, local tools and faucet tBNB, early testing can proceed on the current budget. The independent review needs a confirmed volunteer, sponsor or funding. Mainnet deployment needs real BNB for gas. Until those resources and the technical gates are satisfied, a public launch date is open. [BNB Smart Chain testing and gas](https://docs.bnbchain.org/bnb-smart-chain/developers/quick-guide/) · [Key management and recovery](KEY_STATE.md) · [Current security status](../SECURITY.md).
