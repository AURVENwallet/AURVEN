# Security status

AURVEN is an experimental local/testnet prototype. This repository is not an independently audited wallet. Source checks and passing tests do not establish cryptographic security or suitability for real assets.

The checks below are a pre-publication record, not a production security certification or proof of post-quantum strength.

## Release checks — 2026-11-05

| Check | Result / scope |
| --- | --- |
| Solidity tests | 43 passed, including chain restrictions, tampering, replay, expiry, rotation, interoperability and multisig behavior. |
| Client and UI tests | 31 passed: account snapshots, transfer validation, flow simulation, signing reservation, receipt validation and localization. Compile contracts before running client tests. |
| Reproducible source | A clean staged-source copy builds and passes contract tests. Solidity source bytes are preserved by .gitattributes because metadata contributes to the pinned runtime hash. |
| Runtime pin | Compiled BscTestAccount checked against ui/contract-pin.js. |
| Secret scan | Gitleaks 8.30.1 scanned the public source snapshot with redacted output; no findings in that scan. Tool archive SHA-256 was checked against the official release checksums. |
| Dependency advisory query | OSV query for npm three@0.187.0 returned no matching advisories on this date. This is a database result, not proof that the dependency has no vulnerabilities. |
| Browser checks | Chinese / English navigation, dynamic results, local receipts and form-state retention checked in the browser. |
| Page policy | CSP restricts scripts to local files and the exact import-map hash, without unsafe-inline or unsafe-eval for scripts; objects, base URLs and native form submissions are blocked. RPC connections remain available to HTTPS endpoints and explicit loopback HTTP addresses. |
| Publication boundary | Runtime keys, leaf journals, local receipts, environment files, logs, dependency caches and build artifacts are excluded. Public deterministic test vectors remain intentionally available for reproduction. |

Scanner: [Gitleaks 8.30.1](https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1). Dependency data: [OSV API](https://api.osv.dev/v1/query). The current automated workflow runs source checks, secret scanning, contract tests, runtime-pin verification and client tests. Workflow actions are pinned to commit IDs and receive read-only repository permissions.

## Known limitations

- **Cryptography:** the custom stateful WOTS/Merkle scheme uses 16-byte elements. Its parameters and quantum-security bounds require specialist evaluation. No security level is asserted here.
- **One-time keys:** a leaf must never sign two different digests. The demo journals reservations before returning signatures and rejects reuse within one process. It is not a crash-recoverable, multi-device or browser vault. Each script invocation creates new keys; resuming an old test-key file is not supported.
- **Recovery:** encrypted storage, browser signing, cross-tab locking, old-backup detection, pending-transaction recovery and historical-root rejection in a persistent client remain incomplete. A reverted transaction does not make an already disclosed signature leaf safe to reuse for a different message.
- **Network scope:** only BscTestAccount's constructor enforces chain 97 / 31337. The generic account and factory contracts do not impose that restriction. No mainnet deployment is supplied. Public BSC testnet execution and real network gas compatibility still need validation.
- **RPC trust:** runtime hashes and same-block checks detect inconsistent responses; a single malicious RPC can fabricate a consistent view. There is no independent second-source consensus.
- **Rotation and multisig:** epoch-zero bootstrap intentionally bypasses the deadline check. The account rejects its current root, not every historical root. Multisig owner-code matching targets KeyLabAccount; BscTestAccount compatibility is not complete.
- **Resource limits:** contract tests use a broad gas limit and some generate proofs inside a test. Those totals are not transaction gas quotes or worst-case gas bounds. RPC body-size and rate limits need production hardening.
- **Test material:** deterministic fixture seeds are public, and demo keys are disposable local material. Never fund these accounts on a real network. Never publish demo-runs, expose an unlocked Anvil node, or serve the repository root.

Key unfinished work includes cryptographic-parameter evaluation, encrypted key custody, recovery and protection against reuse from old backups, cross-tab locking, public-testnet validation, multisig compatibility, independent RPC comparison and an independent security audit. Existing checks do not replace this work.

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
