# BSC wallet release readiness

Updated 2026-11-06. The single-signer wallet runs locally. On BSC testnet (chain 97) the browser can inspect accounts, review drafts and reserve leaves. Signed browser simulation runs on the disposable local chain. The public testnet has gas estimates for the contract, with mined end-to-end receipts still pending. The project token has a separate contract and release history.

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
| Public testnet trial | 2–4 weeks | A fresh browser vault can create a chain-97 account, fund it with faucet tBNB, activate a root, transfer and rotate. Publish successful transaction hashes and mined gas with the expected balance, epoch and leaf changes. Exercise expired, reverted and interrupted submissions. |
| Recovery and pilot | Allow a further 4–8 weeks for engineering and drills | Persist the exact signed payload before releasing it. Reconcile pending, dropped and reorganized transactions without signing twice with a leaf. Demonstrate safe device handover, lost-device recovery, historical-root rejection and fail-closed behavior after restoring an old profile. Run a public testnet pilot through those scenarios. |
| Public real-asset wallet | Conditional planning range of 3–6 months total | Obtain independent cryptographic parameter and contract/client reviews, fix and retest findings, and publish results. Resolve custody and key-reuse findings before launch. Verify network-specific builds, deployment reproducibility, live monitoring, incident response and a funded mainnet gas payer. Obtain explicit mainnet deployment approval. |

With the existing server, local tools and faucet tBNB, early testing can proceed on the current budget. The independent review needs a confirmed volunteer, sponsor or funding. Mainnet deployment needs real BNB for gas. Until those resources and the technical gates are satisfied, a public launch date is open. [BNB Smart Chain testing and gas](https://docs.bnbchain.org/bnb-smart-chain/developers/quick-guide/) · [Key management and recovery](KEY_STATE.md) · [Current security status](../SECURITY.md).
