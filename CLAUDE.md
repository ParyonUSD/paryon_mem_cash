# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`@paryonusd/mem-cash` is a fork of [mem-cash](https://github.com/mainnet-pat/mem-cash) 0.0.9 (MIT, by mainnet-pat): an in-memory Bitcoin Cash node with a Fulcrum-compatible Electrum server. Its consumer is the transaction service's simulated network (`paryon_transaction_service/test/sim`), which today works around several gaps in a shim (`test/sim/chain/shim.ts`, `simNetwork.ts`). The fork exists to fix those gaps at the root.

`PLAN.md` is the spec: goals, the package layout decision, the table of gaps the shim works around, the audit of 0.0.9 and the phased work plan with its status. Read it before changing behaviour, and update its status and tables when a phase or a gap is done.

## Commands

```bash
pnpm install
pnpm check            # tsc for src, tsc for the tests (tsconfig.test.json), eslint
pnpm test             # vitest (watch)
pnpm test:unit        # vitest --run
pnpm build            # tsc to dist/
```

## Layout

One package, upstream's five packages as folders under `src/`, with upstream's layering and no cycles:

- `src/types` — primitives, data types, merkle, median time past, BCHN reject codes, the storage interface.
- `src/storage` — the in-memory storage: UTXO set, history, headers, mempool, undo info, `snapshot()` / `restore()`. The pluggable-storage abstraction stays for now; PLAN.md drops it only if the rollback fix needs that.
- `src/validation` — `createTxVerifier`: BCHN-ordered consensus and policy checks, libauth VM. Depends on `src/types` and libauth only.
- `src/core` — `createNode`: mempool acceptance, block processing (`mine`), the subscription manager.
- `src/electrum` — the Fulcrum-compatible handlers, `dispatch`, `createIndexer` (the node plus `request` / `subscribe`), the `test.*` handlers.

Entry points: `src/index.ts` (".", everything) and `src/validation/index.ts` ("./validation"). `src/exports.test.ts` holds both to the names the five `@mem-cash/*` 0.0.9 packages exported; a change to the public API changes that test on purpose.

Tests sit next to the code (`*.test.ts`) and import source through relative paths. The build (`tsconfig.json`) leaves them out; `tsconfig.test.json` type-checks them with `noUncheckedIndexedAccess` relaxed, because upstream never type-checked its tests.

## Rules for changes

- Every behaviour fix comes with a test that fails before the fix. Say in the commit that it did.
- Upstream's tests stay as upstream wrote them; a fix that changes an upstream expectation says so in the commit and the changelog.
- One entry per change in `CHANGELOG.md`, naming how the fork now differs from upstream.
- Small conventional commits whose body explains why. Comments say why, not what.
- Keep mem-cash's MIT licence and copyright notice.
- `@bitauth/libauth` is pinned exactly: `src/validation/verifier.ts` deep-imports `@bitauth/libauth/build/lib/...`, internal paths a libauth release may move. Check them when upgrading.
- Formatting is upstream's (tabs, double quotes); eslint enforces 120 columns. Nothing reformats upstream code wholesale, so its history stays readable with `git blame`.

## Behaviour to keep in mind (upstream 0.0.9, until PLAN.md phases 3 and 4 change it)

- Scripthashes are the plain sha256 of the locking bytecode, not Electrum's byte-reversed one.
- `server.version` negotiates protocol 1.6 only.
- A mempool conflict and a missing input both answer `bad-txns-inputs-missingorspent`; inputs are looked up before finality is checked.
- Mempool entries are at height 0 whatever their parents; `listunspent` is in acceptance order.
- `mine()` confirms the whole mempool and emits synthetic headers; `undoBlock` clears the whole mempool.

`scripts/verify-recovery.sh` checks that a ref from before the restructure (`bf21c89` and earlier) compiles to the published `@mem-cash/*` tarballs of a version. It needs yarn and network access for `npm pack`.
