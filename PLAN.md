# @paryonusd/mem-cash: design plan

A fork of [mem-cash](https://github.com/mainnet-pat/mem-cash), an in-memory Bitcoin Cash node with a Fulcrum-compatible Electrum server, published in the `@paryonusd` scope as one package. It is the backbone of the transaction service's simulated network (`paryon_transaction_service/test/sim`, PR #67).

Status: phases 1 (import and recover) and 2 (restructure) done, 2026-09-30. The repository carries upstream's history to 0.0.6 and the 0.0.7, 0.0.8 and 0.0.9 changes recovered as one commit each, every one compiling byte for byte to what npm published ([Recovery results](#recovery-results)); goal 2 is met. The five packages are now one, `@paryonusd/mem-cash` 0.1.0 (unpublished), with the 0.0.9 API and behaviour ([Restructure results](#restructure-results)). Phase 3 (the shimmed gaps) done, 2026-09-30: every node or Electrum gap in [the table](#gaps-the-shim-works-around-today) is fixed in the package with a test that failed before it ([Gap fix results](#gap-fix-results)); the service's shim still has them until phase 5 adopts the package. Next: phase 4, the audit's findings.

## Goals

In order:

1. **One package the transaction service's simulator uses without shim fixes.** Every gap in [the table below](#gaps-the-shim-works-around-today) that is node or Electrum behaviour is fixed in the package, and the matching workaround leaves `test/sim/chain/shim.ts` and `simNetwork.ts`. What remains in the service is simulation of several servers (relay, indexing delay, pauses, eviction), not corrections of one.
2. **The 0.0.9 source, recovered.** The audit found the 0.0.7 to 0.0.9 change small (snapshot/restore, timestamps, consensus overrides) and the published 0.0.6 reproducible from its source, so recovery is low risk. The fork starts from TypeScript that compiles to the published 0.0.9, reconstructed from the 0.0.6 source and the 0.0.9 build (see [Recovering the 0.0.9 source](#recovering-the-009-source)), so nothing we run today is lost.
3. **The important audit findings fixed.** Every finding the audit rates high, meaning it can make a simulated scenario behave differently from the real network, is fixed with a test; medium and low ones are fixed or recorded. From the [audit](#audit): refusal order with finality first (high), Fulcrum's `listunspent` order and mempool heights -1 (medium, both reachable by the bot), then the rest by effort.

## Why fork

- **We cannot read the source of what we run.** The simulator pins mem-cash 0.0.9. Versions 0.0.7 to 0.0.9 were published to npm in July 2026 as compiled JavaScript only; GitHub stops at 0.0.6. With our own package, the published code and its source are the same thing.
- **Some gaps are better fixed at the root than shimmed.** The transaction service's shim (`test/sim/chain/shim.ts`, `simNetwork.ts`) works around them, but each workaround has to second-guess mem-cash's internal state. See [Gaps](#gaps-the-shim-works-around-today).
- **More consumers are coming.** The V2 fork of the transaction service, and possibly the api service. A second consumer is the point where the resilience doc says to turn shared code into a package, as was done with `@paryonusd/electrum-session`.
- **The licence allows it.** mem-cash is MIT: a fork keeps its copyright notice and licence, and fixes can still be offered upstream.

## What we run today

| | |
|---|---|
| Packages | `@mem-cash/types`, `storage`, `validation`, `core`, `electrum`, all pinned exactly at 0.0.9 (devDependencies of the transaction service) |
| Source on GitHub | up to 0.0.6 (`~/git-clones/mem-cash`, head `9d5ba98`) |
| Published without source | 0.0.7 (2026-07-19), 0.0.8 (2026-07-22), 0.0.9 (2026-07-23); recovered in this repository, see [Recovery results](#recovery-results) |
| Install scripts | none; only `prepublishOnly` |
| Source maps | shipped without `sourcesContent` |
| Build output | plain `tsc` output, readable |
| Dependencies | `@bitauth/libauth` ^3.1.0-next.8 (the service pins 3.1.0-next.8) |

## Recovering the 0.0.9 source

The published 0.0.9 is plain `tsc` output with `.d.ts` files alongside, so its TypeScript can be recovered:

1. Start from the 0.0.6 source (`~/git-clones/mem-cash`, head `9d5ba98`).
2. Diff the published 0.0.6 build against the published 0.0.9 build (`npm pack` of each package), file by file. The diff is the 0.0.7 to 0.0.9 changes in compiled form; the `.d.ts` diff gives their types.
3. Apply each change to the TypeScript source, as one commit per upstream version (0.0.7, 0.0.8, 0.0.9), attributed to upstream.
4. **Verify:** compile the recovered source with upstream's compiler settings and diff the output against the published 0.0.9 `dist`, per package. The recovery is done when the emitted JavaScript and declarations match, apart from formatting. Run upstream's tests.

This is done before the restructure, so "0.0.9 recovered" and "restructured into one package" are separate, reviewable steps. If a change cannot be recovered with confidence, ask mainnet-pat for the source of that version.

### Recovery results

Done 2026-09-30. The repository starts from upstream's history (fetched from `~/git-clones/mem-cash` master, head `9d5ba98`; remote `upstream` is `https://github.com/mainnet-pat/mem-cash.git`), then:

| Commit | Upstream version | npm gitHead | Change |
|---|---|---|---|
| `aa2ac19` | | | this plan |
| `a2fff03` | 0.0.7 | `9fa7824` | storage and node `snapshot()` / `restore()`, `setNextBlockTimestamp`, monotonic `mine()` timestamp |
| `d2f55a0` | 0.0.8 | `9d5b36e` | `TxVerifierConfig.consensus` overrides, VM built from libauth's instruction sets when set; validation README example |
| `da59b6e` | 0.0.9 | `6ee1892` | three more override keys; the six introspection operations rebuilt when `maximumStackItemLength` is overridden |

Each recovered commit names mainnet-pat as co-author and the npm version and gitHead it reproduces; versions are bumped with upstream's `bump.mjs`.

**Verification.** `scripts/verify-recovery.sh <version> <ref>` checks out the ref in a throwaway worktree, builds it from scratch with upstream's toolchain (`yarn install --frozen-lockfile`, `npx tsc -b`, TypeScript 5.9.3, Node 24.21.0), fetches each `@mem-cash/*` tarball of that version with `npm pack`, and compares every file under `dist` (`.js`, `.d.ts` and their `.map`s) plus `package.json` and `README.md` byte for byte:

```
scripts/verify-recovery.sh 0.0.6 9d5ba98   # upstream's own source, as a baseline
scripts/verify-recovery.sh 0.0.7 a2fff03
scripts/verify-recovery.sh 0.0.8 d2f55a0
scripts/verify-recovery.sh 0.0.9 da59b6e
```

All four exit 0: types 32, storage 12, validation 20, core 16 and electrum 64 dist files identical, and every `package.json` and `README.md` identical. The only difference is the four `memCash.*` files in the published electrum `dist`, which no source has produced since 0.0.6 and which are the same bytes in all four tarballs. As a negative control, `scripts/verify-recovery.sh 0.0.9 d2f55a0` (the 0.0.8 source against the 0.0.9 tarballs) exits 1, naming `types.d.ts`, `verifier.js`, their maps and every `package.json`.

The match is stricter than "apart from formatting": the source maps are identical too, so each recovered line and column sits where upstream's did. That settled details the JavaScript alone leaves open (a blank line, an import's position, unwrapped long lines).

**Tests.** Upstream's suite, after `npx tsc -b` (the packages import each other through their `dist`, so without a build 15 of 17 files fail to resolve): `npx vitest run` gives 17 files, 319 tests passed at 0.0.6, 0.0.7, 0.0.8 and 0.0.9 alike.

**What the build cannot confirm.** tsc erases type annotations, so their text is reconstructed; the maps fix only their length. In 0.0.8 the facade's parameter type (`ReturnType<typeof createVirtualMachineBch2025>`), the BCH_SPEC cast and the `as never` casts; in 0.0.9 the local `type State = any` (five characters where used, and it must accept both the BCH_SPEC and the common operation types, because the operations table is a union) and the `as (state: State) => State` casts. They compile, have upstream's exact lengths and emit upstream's exact output, but upstream may have spelled them differently.

**Carried over from upstream as published, revisited in the restructure:**
- ~~`biome check` passes at 0.0.6 but not at 0.0.9~~: settled, biome is replaced by eslint. `node.ts` and `verifier.ts` keep upstream's formatting (nothing reformats upstream code wholesale); `type State = any` carries an eslint disable comment saying why no narrower type fits; one 130-column line is wrapped.
- `ConsensusOverrides` is not exported from the validation index. Still open: exporting it adds to the 0.0.9 API, so it waits for a change that needs it.
- None of upstream's tests cover the 0.0.7 to 0.0.9 features (snapshot/restore, `setNextBlockTimestamp`, consensus overrides). Partly settled in phase 3: the reorg no longer relies on snapshots, and `disconnectBlocks` restores one when a replacement is refused, which its tests cover. A direct test of each is still open.
- The consensus overrides deep-import `@bitauth/libauth/build/lib/...`. libauth 3.1.0-next.8 has no `exports` map, so these resolve, but they are internal paths a libauth release may move. Settled for now: libauth is pinned exactly at 3.1.0-next.8, so a new release is taken only on purpose.

## Package layout

mem-cash splits into five packages. Measured on the 0.0.6 source:

| Package | Source lines | Test lines | Depends on |
|---|---:|---:|---|
| `types` | 492 | 161 | libauth |
| `storage` | 989 | 662 | types |
| `validation` | 959 | 652 | libauth, types (reject codes; imported at runtime but not declared as a dependency) |
| `core` | 920 | 1270 | types, storage, validation |
| `electrum` | 2703 | 1795 | all four |

**Keep:** the layering. A VM layer (types, storage, validation, core) sits under a protocol layer (electrum), with no cycles.

**Drop:** the package boundaries.
- Consumers use all five together: `electrum` depends on the other four, so the split saves nothing on install. It only means five versions to publish and keep in step, and upstream already bumps them together.
- `types` exists only to be shared across packages; within one package it is a folder.
- `storage` is shaped for pluggable backends (LevelDB, RocksDB, SQLite) that do not exist; only the in-memory one does. That interface is also what makes block rollback awkward: undoing a block goes through a generic storage API instead of restoring state.
- `validation` is the one part useful on its own: it depends only on libauth and the reject codes in `types`, and answers "would BCHN accept this transaction?".

**Decision (settled, done in phase 2):** one package, `@paryonusd/mem-cash`.

```
src/
  types/        primitives, data types, merkle, BCHN reject codes
  storage/      the in-memory UTXO set, history, headers, mempool state
  validation/   BCHN-ordered consensus and policy checks, libauth VM
  core/         the node: mempool acceptance, subscriptions, block processing
  electrum/     Fulcrum-compatible JSON-RPC handlers, dispatch, the Indexer facade
```

Entry points:

| Export | Contents | For |
|---|---|---|
| `.` | the whole node and Electrum server | the simulator |
| `./validation` | BCHN-style transaction checking alone | any consumer that wants to check a transaction before broadcasting it |

The storage abstraction stays through the restructure. It is removed or simplified only if phase 3's rollback fix needs that, and added back only if persistence is ever needed.

### Restructure results

Done 2026-09-30, on top of `bf21c89`:

| Commit | Change |
|---|---|
| `a0af679` | the five packages' `src` moved (`git mv`, so `git log --follow` and blame keep upstream's history) to `src/types`, `storage`, `validation`, `core`, `electrum`; `@mem-cash/*` imports became relative paths; one `package.json` (`@paryonusd/mem-cash` 0.1.0, pnpm, `"type": "module"`, `tsc` to `dist`, `"files": ["dist"]`, exports map), libauth pinned exactly at 3.1.0-next.8; `src/index.ts` and `src/exports.test.ts` |
| `9ab44fe` | eslint (typescript-eslint recommended, as electrum-session) in place of biome |
| `2126b7d` | `.github/workflows/ci.yaml`: `pnpm install --frozen-lockfile` (runs `prepare`, which builds), `pnpm check`, `pnpm test:unit`, on Node 24 |
| `46e196e` | README, CLAUDE.md, the folder READMEs; `verify-recovery.sh` scoped to refs up to `bf21c89` |

**Entry points.** `.` (`dist/index.js`) exports every name the five 0.0.9 packages exported: 184 names, the same value or type kind for each, compared with the TypeScript compiler against the published 0.0.9 `.d.ts` files. The one collision, `AddUtxoParams` (storage and core), keeps core's meaning; storage's is `StorageAddUtxoParams`, the only new name. `./validation` (`dist/validation/index.js`) exports exactly `@mem-cash/validation`'s 42 names and loads only `src/validation` and `src/types`, no node or Electrum code. `src/exports.test.ts` holds both to these names (runtime names compared exactly; type names checked by `tsc -p tsconfig.test.json`); removing the types re-export from `src/index.ts` makes it fail with 1 test and 22 type errors.

**Tests.** `pnpm test:unit`: 18 files, 322 tests pass, no build needed first. Upstream's 319 have the same file and test names as before the move and all pass; the 3 others are `exports.test.ts`. The tests' only changes are import paths, plus one added `import type { ScriptHash }` in `scripthash.test.ts`, which used the type without importing it: upstream never type-checked its tests. `tsconfig.test.json` now does, with `noUncheckedIndexedAccess` off for four unguarded array reads in `mempool.test.ts`.

**Checks.** `pnpm check` (tsc for the source, tsc for the tests, eslint) passes; `pnpm build` emits `dist/` with `.js` and `.d.ts` only. The built package was loaded by name from Node 24 through both entry points (`createIndexer`, `createTxVerifier`, `test.add_utxo`, `get_balance`). `scripts/verify-recovery.sh 0.0.9 da59b6e` still exits 0 from the restructured repository.

**Found on the way:** upstream's `@mem-cash/validation` imports `@mem-cash/types` at runtime (reject codes, in `checks.js` and `verifier.js`) without declaring it, so it resolves only when installed next to the other packages. In one package the question is gone.

**Not done here, by design:** no behaviour change; the storage abstraction kept; `assets/` (upstream's logo) kept but unused; the CI workflow has not run on GitHub (no remote).

### Gap fix results

Done 2026-09-30, on top of `d9fb1b8`, one commit per gap, each with a test that failed before its fix (the commit body quotes the failure):

| Commit | Gap | Test | What changed |
|---|---|---|---|
| `b47afe4` | scripthash byte order | `electrum/scripthashOrder.test.ts` (4) | one `computeScriptHash` (exported) everywhere a scripthash is made; checked against the protocol documentation's example |
| `f0e754f` | protocol version | `electrum/protocolVersion.test.ts` (5) | 1.4 to 1.5.3, one to three parts, answered in Fulcrum's form (`"1.5"` for 1.5.0); `block.headers` keeps its 1.5 shape, and the Indexer's request types now build on the 1.5.3 schema |
| `93c7464` | conflict and missing input | `core/refusals.test.ts` (4) | `txn-mempool-conflict (code 18)`, checked on every input first; `Missing inputs` without a code; `SubmitFailure.message` is the text BCHN answers with; `StorageReader.getMempoolSpender` |
| `26f1abe` | rebroadcast | `core/refusals.test.ts` (1) | a mempool transaction answers with its txid, notifying nobody |
| `cffc8c4` | already confirmed | `core/refusals.test.ts` (2) | `transaction already in block chain` while the chain's coins hold an output (wording checked against BCHN master's `node/transaction.cpp`); `Missing inputs` once all are spent |
| `1ca8b17` | non-final wording | `core/refusals.test.ts` (2) | `FormatStateMessage` (reason, debug message, code); non-final re-coded 64 by the verifier |
| `312ad81` | parent links | `core/mempoolParents.test.ts` (4) | a mempool coin's height 0 reaches acceptance, which links parent and child; a block confirming a parent keeps and relinks its children |
| `afd6946` | BIP68 | `core/sequenceLocks.test.ts` (3, 1 failing before) | height 0 counts as the next block |
| `8475658` | `transaction.get` | `electrum/transactionGet.test.ts` (3, 2 failing before) | a transaction leaving the mempool unconfirmed loses its raw hex |
| `1c417d2` | verbose mempool transaction (the shim deleted the fields too) | `electrum/transactionGet.test.ts` (1) | no `blockhash`, `blocktime`, `time`, `confirmations` outside a block |
| `43fbd65` | headers | `core/blockHeaders.test.ts` (4, 3 failing before) | `createBlockHeader` (exported); per-node nonce; `mine()` no longer rewrites the last 11 headers, so the median time past comes from real timestamps |
| `aefde6f` | conflicts on block connect (part of the reorg gap; the simulator re-admitted its mempool around each block for it) | `storage/blockConflicts.test.ts` (1) | `applyBlock` removes a conflicting mempool transaction with its descendants |
| `7496f00` | `undoBlock` | `storage/undoBlock.test.ts` (3) | no phantom coins; history and records removed by txid; mempool left alone |
| `dc2da2d` | reorg | `core/disconnectBlocks.test.ts` (7) | `Node.disconnectBlocks(count, { replacementTxs })` |
| `84139ff` | `mine()` whole mempool | `core/mineInclude.test.ts` (5, 4 failing before) | `mine({ timestamp, include })`; `mine()` no longer clears the mempool |

**Order.** As planned, except that parent links come before BIP68: the node passing a mempool coin's height 0 is what both fixes build on, and on its own it changes no acceptance decision, so BIP68's test could fail first on the commit after it.

**Tests.** `pnpm test:unit`: 29 files, 371 tests pass (322 before the phase). `pnpm check` passes. Upstream tests changed only where their fixtures computed the plain scripthash (`accept.test.ts`, `node.test.ts`, `indexer.test.ts`, `test.test.ts`); `exports.test.ts` lists the new exports. `src/testkit.ts` (OP_TRUE transactions, `blockOf`) serves the new tests and is left out of the build.

**Choices worth reviewing:**
- Refusal texts live on `SubmitFailure.message`, required, while `error` and `code` keep BCHN's reject reason and code (for a missing input `bad-txns-inputs-missingorspent` and 16, which upstream's tests assert). The broadcast handlers wrap `message`.
- `disconnectBlocks` does not notify header subscribers; they hear of the next block. Fulcrum sees a reorg as one step, and the simulator's reorg always mines the new branch at once.
- `disconnectBlocks` re-admits through full validation at the lower tip, so a transaction whose locktime no longer fits drops out, as BCHN's `removeForReorg` does. Only blocks connected on the node (by `mine` or `applyBlock`) can be disconnected.
- The pluggable storage abstraction stays: the rollback fix did not need it removed.

**What the phase leaves for adoption (phase 5).** The simulator builds blocks for its servers with its own `toProcessedBlock` and seeds coins with the test helpers, computing scripthashes with the plain sha256 (`simNetwork.ts`, `shim.ts` `addressScriptHash`): both must switch to `computeScriptHash`. Its per-block snapshots and seed replay give way to `disconnectBlocks`, its `admit()` to `submitTransaction` and `message`, its headers to the node's. A node method connecting a block given as a header and raw transactions (what `testkit.blockOf` builds) would remove `toProcessedBlock` too; it is not built.

**Carried over, still open:** `setNextBlockTimestamp` and a successful `snapshot()`/`restore()` round trip have no direct test (`disconnectBlocks` restores a snapshot when a replacement is refused, and that is tested).

## Gaps the shim works around today

Each is a candidate to fix in the fork, after which the matching workaround leaves the transaction service's shim.

| Gap in mem-cash 0.0.9 | Real behaviour (BCHN / Fulcrum) | Worked around in | Fixed in |
|---|---|---|---|
| Scripthashes keyed by the plain sha256 of the locking bytecode | Electrum uses the byte-reversed hash, so real clients' UTXO reads came back empty | `shim.ts` (reverses `params[0]`) | `b47afe4` |
| `server.version` negotiates protocol 1.6 only, and rejects three-part versions | Fulcrum accepts 1.4 to 1.5.x, as the library and clients send | `shim.ts` (answers `server.version` itself) | `f0e754f` |
| A mempool conflict and a missing input both answer `bad-txns-inputs-missingorspent` | `txn-mempool-conflict` and `Missing inputs`, which ElectrumWrapper classifies | `shim.ts` `admit()` | `93c7464` |
| Rebroadcasting a transaction the mempool already holds is refused | silent success with the txid | `shim.ts` `admit()` | `26f1abe` |
| No answer for a transaction already confirmed | `transaction already in block chain` while one of its outputs is unspent | `shim.ts` `admit()` | `cffc8c4` |
| BIP68 evaluates an unconfirmed parent at height 1 | the next block's height | `shim.ts` `admit()` | `afd6946` |
| Non-final refusal text `bad-txns-nonfinal` | `non-final` wording the wrapper classifies | `shim.ts` | `1ca8b17` |
| `mine()` emits identical all-zero headers and a synthetic hash | real 80-byte headers linked by prev-hash, so reorgs can be recognised | `headers.ts`, `simNetwork.ts` | `43fbd65` |
| No reorg; `undoBlock` clears the whole mempool and restores coins created and spent in the same block | disconnected blocks return their transactions to the mempool; spent coins stay spent | `simNetwork.ts` (per-block snapshots) | `aefde6f`, `7496f00`, `dc2da2d` |
| Mempool entries not linked to their parents (`utxoToSourceOutput` drops height 0), so removal does not cascade and mempool history shows height 0 | parents tracked, children removed with them, height -1 for an unconfirmed parent | `shim.ts` `mempoolParents()`, `withDescendants()` | `312ad81` |
| `transaction.get` keeps answering after a transaction left the mempool | `No such mempool or blockchain transaction` | `shim.ts` | `8475658`; verbose block fields `1c417d2` |
| `mine()` confirms the whole mempool | a miner picks what it includes | `simNetwork.ts` (`include`) | `84139ff` |

The audit adds to this table.

## Scope

**In the fork:**
- the five packages restructured into one;
- root fixes for the gaps above that belong to a node or an Electrum server;
- tests for each fix;
- a CHANGELOG entry per change, naming what differs from upstream.

**Stays in the transaction service, for now:**
- the two-server simulation (`test/sim/chain`: relay, indexing delay, pause, eviction, the miner node);
- the Electrum socket for real clients (`test/sim/electrum`);
- the harness, invariants and scenarios.

These could later move into the fork or into `@paryonusd/electrum-session/testing`, once the V2 fork needs them.

**Non-goals:**
- persistence (LevelDB and similar);
- a production Electrum server;
- features the simulator does not use.

## Relationship with upstream

- Keep mem-cash's MIT licence and copyright notice; our changes are MIT as well.
- Offer upstream the fixes worth sharing, as PRs to mainnet-pat, so the two can stay close. mainnet-js `next` depends on mem-cash too, so they help its users.
- Record in the README which upstream version the fork is based on.

## Publishing

As `@paryonusd/electrum-session` does:
- `"type": "module"`, `tsc` build to `dist`, `"files": ["dist"]`, an `exports` map with `types` and `import` per entry point;
- scripts `build`, `test`, `lint`, `check`, and `prepare` building on install;
- a `ci.yaml` running check and tests;
- the licence stays MIT (electrum-session is ISC; this code carries mem-cash's MIT notice).

## Consumers

| Consumer | Uses | When |
|---|---|---|
| `paryon_transaction_service` (`test/sim`) | `.` | first; replaces the five `@mem-cash/*` devDependencies |
| V2 fork of the transaction service | `.` | when forked |
| `paryon_api_service` | `.` (tests) | possibly |
| `@paryonusd/library` | `./validation` | possibly, to check a transaction before broadcasting it |

## Audit

Running, as a workflow of four auditors and a verifier, on 0.0.9:

| Dimension | Question |
|---|---|
| Provenance | What changed from 0.0.6 to 0.0.9 without public source? Anything a test dependency should not do (network, filesystem, `eval`, timers, environment)? |
| Validation | Where does it accept what BCHN 29 refuses, or refuse what BCHN accepts, and which refusal wins when several apply? |
| Mempool and storage | Acceptance, parent tracking, mining, rollback, snapshots, history and status hashes, subscriptions |
| Electrum protocol | Answers, ordering, error codes and JSON shapes against Fulcrum |

The verifier reproduces each finding, marks the ones the shim already handles, and says for each whether it needs a shim fix, an upstream issue, or nothing.

Results (2026-09-30): 24 findings, 23 confirmed by the verifier's own reproductions and 1 a duplicate of a shimmed gap; none refuted. Scripts and outputs: `scratchpad/memcash-audit/` in the transaction service session.

**Verdict:** fit for use as the simulator's backbone. In every case tested, what mem-cash accepts and refuses matches BCHN, apart from time-based BIP68 and the OP_RETURN size limit, neither of which Paryon's transactions touch. The fidelity problems are in the order refusals are reported, the order of `listunspent`, and the heights of mempool entries.

**Provenance:**
- The published 0.0.6 is reproducible: rebuilding the GitHub source at `9d5ba98` gives the published dist byte for byte (apart from an orphaned `memCash.js`). So compiling and diffing is a sound check for the recovered 0.0.9.
- The 0.0.7 to 0.0.9 change is small, and all of it looks legitimate:
  - 0.0.7: storage and node `snapshot()` / `restore()` (a structuredClone), `setNextBlockTimestamp`, and a `mine()` timestamp that never goes backwards;
  - 0.0.8: consensus overrides for private networks in the validation config, deep-importing libauth build internals;
  - 0.0.9: more override keys, and rebuilding libauth's introspection opcodes when `maximumStackItemLength` is overridden.
  Only snapshot/restore matters to us: the simulator's reorgs use it.
- The npm `gitHead`s of 0.0.7 to 0.0.9 are not on GitHub.
- The build is safe to run: no Node builtins, `eval`, network, filesystem, environment reads or timers, checked under `node --permission`.
- Hygiene gaps: no LICENSE file shipped in the tarballs, no npm provenance, one maintainer publishing by hand.

**Findings that shape the fork**, beyond the known gaps (all confirmed):

| Severity | Finding | Effect on the simulator |
|---|---|---|
| high | A non-final transaction is refused as `txn-mempool-conflict`, `Missing inputs` or `non-BIP68-final`: mem-cash and the shim look up inputs before checking finality, while BCHN checks finality first (`validation.cpp` 524-540) | In lagging-server scenarios, `updatePeriodBorrowing`, `newPeriodPool` or `cancelRedemption` (locktime = the bot's tip) sent to a server a block behind gets `Missing inputs` (retried as transient) where BCHN says `bad-txns-nonfinal` |
| medium | `listunspent` in acceptance order, not Fulcrum's sort (confirmed by height and position; then mempool coins without unconfirmed parents; then with; `Storage.cpp` 4757, 4929) | Builders pick coins by position (`.find`, `[0]`), so the bot can chain off a different mempool coin than against Fulcrum, once its seeded wallet coins are spent within a block |
| medium | Mempool entries always at height 0 (Fulcrum: -1 with an unconfirmed parent); the shim's workaround is incomplete | A scripthash with only a child gets no status notification when the parent confirms; `get_mempool` and `get_history` show 0 |
| medium | Time-based BIP68 never enforced | None today: Paryon uses height-based locks only |
| medium | Standardness and BIP68 checked later than BCHN, so another refusal wins | Only for non-standard transactions, which the builders do not make |
| medium | Standardness, token, duplicate-input and script refusals in libauth wording | None for the bot's classifiers; a test asserting a BCHN reason would fail |
| medium | Token filters (`exclude_tokens`, `tokens_only`) ignored in `listunspent` | None today: clients send `include_tokens` |
| medium | Verbose `transaction.get` reports P2SH32 as nonstandard, without address or asm | None for the bot |
| low | `bad-txns-nonfinal` with code 16 (BCHN 64); `get_balance` counting outputs spent in the mempool; history within a block in txid order; OP_RETURN outputs indexed as spendable; `node.mine()` overwriting the last 11 headers; ranged `get_history` inclusive; 1.6 advertised but 1.5 `block.headers` shape; Fulcrum error codes; OP_RETURN budget off by one byte (libauth); heap growing about 1 MB per block through snapshots | None for current scenarios |


## Open decisions

1. **Fork base: decided.** The 0.0.9 source recovered from the 0.0.6 source and the published build ([Recovering the 0.0.9 source](#recovering-the-009-source)); asking upstream only for a change that cannot be recovered with confidence.
2. **Which gaps to fix in the fork and which to leave in the shim.** Node and Electrum behaviour goes into the fork; simulation of several servers stays in the service. The audit's findings are added to the same split. Settled for the gap table in phase 3: all twelve rows were node or Electrum behaviour and are fixed in the fork; the audit's findings follow in phase 4.
3. **Where the generic simulation layers end up:** in the fork, in `@paryonusd/electrum-session/testing`, or in the service until the V2 fork needs them.
4. **Upstream PRs:** which fixes to offer, and when.

## Work plan

Phases for a workflow, each with a review before the next:

1. **Import and recover (goal 2).** Done 2026-09-30, see [Recovery results](#recovery-results). Create the repo from the 0.0.6 source, keeping upstream history and attribution. Recover 0.0.7, 0.0.8 and 0.0.9 as one commit each, verified by compiling and diffing against the published builds.
2. **Restructure (goal 1).** Done 2026-09-30, see [Restructure results](#restructure-results). Merge the five packages into `src/` folders, one `package.json`, the two entry points, electrum-session's tooling (pnpm, tsc, vitest, eslint, CI). All upstream tests pass unchanged.
3. **Fix the shimmed gaps (goal 1).** Done 2026-09-30, see [Gap fix results](#gap-fix-results). One commit per gap from the table, each with a test that fails before it. Order by how much shim each fix removes: scripthash order, protocol version, refusal wording, parent links, headers, rollback and reorg.
4. **Fix the important audit findings (goal 3).** One commit per finding, each with a test that fails before it: finality checked first, Fulcrum's `listunspent` order, mempool heights -1 with the notifications they drive; then the medium ones off our path (time-based BIP68, check order, BCHN reject wording, token filters, P2SH32 in verbose output); low ones fixed where cheap or recorded in the README.
5. **Adopt (goal 1).** In the transaction service, replace the five `@mem-cash/*` devDependencies with `@paryonusd/mem-cash` and remove every workaround the fork made unnecessary from `shim.ts` and `simNetwork.ts`. Done when the sim suite gives the same outcomes and the same expected failures as before, and the shim holds only multi-server simulation.
6. **Publish** 0.1.0, and offer the upstream PRs decided in decision 4.
