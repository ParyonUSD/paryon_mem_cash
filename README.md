# @paryonusd/mem-cash

An in-memory Bitcoin Cash node with a Fulcrum-compatible Electrum server, for tests that need a network without running one. It keeps a UTXO set, a mempool and a chain of blocks in memory, checks transactions the way BCHN does (script evaluation by [libauth](https://github.com/bitauth/libauth)), and answers the Electrum Cash protocol the way [Fulcrum](https://github.com/cculianu/Fulcrum) does.

It is the backbone of the Paryon transaction service's simulated network (`paryon_transaction_service/test/sim`).

## A fork of mem-cash 0.0.9

This is a fork of [mem-cash](https://github.com/mainnet-pat/mem-cash) by mainnet-pat, at version 0.0.9. The git history carries upstream's commits up to 0.0.6, then 0.0.7, 0.0.8 and 0.0.9 recovered one commit each: those three were published to npm without their source, and their TypeScript was rebuilt from the published build and checked to compile to it byte for byte (`scripts/verify-recovery.sh`, and [PLAN.md](PLAN.md#recovery-results)).

Why fork:

- **The source of what we run.** With our own package, the published code and its source are the same thing.
- **Fixes at the root.** The simulator works around several places where mem-cash differs from BCHN and Fulcrum (scripthash byte order, `server.version`, refusal wording, mempool parent links, headers, rollback). Each workaround has to second-guess mem-cash's internal state; fixing them here removes it.
- **More consumers are coming**, which is the point where the Paryon repos turn shared code into a package.

[PLAN.md](PLAN.md) has the goals, the gaps, the audit of 0.0.9 and the work plan, with the status of each phase.

## Entry points

| Import | Contents |
|---|---|
| `@paryonusd/mem-cash` | the whole node and Electrum server: `createIndexer`, `createNode`, the handlers, storage, and everything `./validation` exports |
| `@paryonusd/mem-cash/validation` | BCHN-style transaction checking alone (`createTxVerifier` and the individual checks); pulls in no node or Electrum code |

Every name the five `@mem-cash/*` 0.0.9 packages exported is exported under the same name, so moving from them is a change of import paths. The one exception: `@mem-cash/storage` and `@mem-cash/core` both exported an `AddUtxoParams`. The node's keeps the name; the storage helper's is `StorageAddUtxoParams`.

```ts
import { createIndexer } from '@paryonusd/mem-cash';
import { createTxVerifier } from '@paryonusd/mem-cash/validation';

const indexer = createIndexer({ verifier: createTxVerifier({ vmVersion: 'BCH_2025_05', standard: true }) });
indexer.setChainTip(200, 1700000000);

const address = 'bitcoincash:qr95sy3j9xwd2ap32xkykttr4cvcu7as4y0qverfuy';
await indexer.request('test.add_utxo', [address, { satoshis: 10_000 }]);
const utxos = await indexer.request('blockchain.address.listunspent', [address]);
const txid = await indexer.request('blockchain.transaction.broadcast', [rawHex]);
indexer.mine();
```

The folders under `src/` are upstream's five packages, and each keeps its README: [types](src/types), [storage](src/storage), [validation](src/validation), [core](src/core), [electrum](src/electrum). The layering is upstream's too: types under storage and validation, core on those, electrum on everything.

## How it differs from upstream

[CHANGELOG.md](CHANGELOG.md) has one entry per change, each naming how it differs from upstream. In short, so far:

- One package with two entry points instead of five packages; the same exported names, plus `computeScriptHash`, `createBlockHeader`, `checkDuplicateInputs` and the types of the new options (among them `TxVerifier.checkBeforeInputs`, `ConsensusOverrides.maximumDataCarrierBytes` and a token filter on `StorageReader.getBalance`).
- pnpm, eslint and vitest in place of yarn workspaces and biome; `@bitauth/libauth` pinned exactly, since validation deep-imports libauth's build internals, which a range could move.
- Behaviour, where the simulator had to work around upstream (PLAN.md phase 3):
  - scripthashes in the Electrum byte order (sha256 reversed);
  - `server.version` negotiates Fulcrum's 1.4 to 1.5.3, three-part versions included;
  - refusals in BCHN's words: `txn-mempool-conflict (code 18)` against `Missing inputs`, a rebroadcast mempool transaction answered with its txid, `transaction already in block chain`, `bad-txns-nonfinal, non-final transaction (code 64)`;
  - mempool transactions linked to their parents (height -1, removal cascading, children kept when a block confirms a parent); BIP68 counting a mempool coin from the next block;
  - a transaction that leaves the mempool unconfirmed is forgotten; a verbose mempool transaction has no block fields;
  - `mine()` builds real 80-byte headers linked by prev-hash and can confirm chosen transactions (`include`); a block drops the mempool transactions it conflicts with;
  - `disconnectBlocks` for reorgs, with `undoBlock` no longer wiping the mempool or restoring phantom coins.
- Behaviour, from the audit of 0.0.9 (PLAN.md phase 4):
  - checks in BCHN's order: the transaction on its own (`CheckRegularTransaction`, `IsStandardTx`, finality) before its inputs are looked up, so a non-final transaction is refused as such even when an input is missing or conflicts; BIP68 before `CheckTxInputs`; tokens after the fees;
  - refusals in BCHN's words where libauth's were given: standardness (`scriptpubkey`, `dust`, `oversize-op-return`, `bad-txns-nonstandard-inputs`, ...), `bad-txns-inputs-duplicate`, `bad-txns-vout-toolarge`, `bad-txns-undersize`, `bad-txns-version`, the `bad-txns-token-*` reasons, amounts in BCH in `bad-txns-in-belowout`; OP_RETURN data counted as BCHN counts it;
  - BIP68 time locks enforced against the median time past;
  - `listunspent` in Fulcrum's order, with its token filter (also on `get_balance`); `get_balance` without mempool outputs the mempool spends; history within a block in block order; `get_history`'s `to_height` exclusive; `get_first_use` from the mempool at -1 with an unconfirmed parent;
  - OP_RETURN outputs not indexed; verbose transactions with BCHN's asm, types and addresses (P2SH32 included); Fulcrum's error codes for broadcast and `transaction.get`; hex parameters in either case.

Where the upstream READMEs under `src/` describe behaviour these fixes changed, they have been updated.

## Known differences from BCHN and Fulcrum

What the audit found and the fork leaves, because nothing Paryon runs depends on it or the fix is not worth its weight:

- **Script failures in libauth's words.** A script that fails is refused as BCHN refuses it, `mandatory-script-verify-flag-failed (...)` or `non-mandatory-script-verify-flag (...)` with the right code, but the text in the brackets is libauth's (for a P2SH hash mismatch, "The P2SH redeem bytecode provided in this input does not match the hash required by the locking bytecode" where BCHN says "Script evaluated without error but finished with a false/empty top stack element"). libauth's errors do not map one to one onto BCHN's `ScriptErrorString`.
- **`CheckTxInputs` per check, not per input.** BCHN checks each input in turn for maturity, unspendable script and value range; the verifier runs each check over all inputs. Only which of two such refusals wins can differ.
- **Time locks on coins below the stored headers.** A coin seeded with `addUtxo` at a height the node holds no header for (below `setChainTip`'s eleven) counts its BIP68 time lock from time 0, so the lock is met.
- **2026 opcodes named as in 2023.** Verbose asm names opcodes as libauth's 2023 set does; the opcodes the 2026 upgrade assigns show their earlier names. A signature's sighash type is named when its encoding is a Schnorr or DER signature's, checked with libauth rather than BCHN's `CheckTransactionSignatureEncoding`.
- **`listunspent` ties.** Fulcrum breaks a tie between two coins of one transaction position and value by the address of their token data in memory; the fork uses the txid.
- **Parameter handling.** `transaction.get` takes `verbose` as a boolean only (Fulcrum also a number) and answers `Invalid verbose parameter`; `listunspent` accepts extra parameters Fulcrum refuses; `blockchain.estimatefee` answers -1 where Fulcrum forwards to BCHN's estimate (at least the relay fee); `block.headers` with a `cp_height` below the range does not refuse.
- **Memory.** `snapshot()` is a `structuredClone` of the whole node; a consumer taking one per block (as the simulator did before `disconnectBlocks`) grows by about 1 MB per block.

## Commands

```bash
pnpm install
pnpm check         # tsc for the source and the tests, eslint
pnpm test          # vitest (watch)
pnpm test:unit     # vitest --run
pnpm build         # tsc to dist/
```

## Licence

MIT, as upstream. [LICENSE](LICENSE) keeps mem-cash's copyright notice; the fork's changes are under the same licence.
