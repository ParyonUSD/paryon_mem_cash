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

- One package with two entry points instead of five packages; the same exported names, plus `computeScriptHash`, `createBlockHeader` and the types of the new options.
- pnpm, eslint and vitest in place of yarn workspaces and biome; `@bitauth/libauth` pinned exactly, since validation deep-imports libauth's build internals, which a range could move.
- Behaviour, where the simulator had to work around upstream (PLAN.md phase 3):
  - scripthashes in the Electrum byte order (sha256 reversed);
  - `server.version` negotiates Fulcrum's 1.4 to 1.5.3, three-part versions included;
  - refusals in BCHN's words: `txn-mempool-conflict (code 18)` against `Missing inputs`, a rebroadcast mempool transaction answered with its txid, `transaction already in block chain`, `bad-txns-nonfinal, non-final transaction (code 64)`;
  - mempool transactions linked to their parents (height -1, removal cascading, children kept when a block confirms a parent); BIP68 counting a mempool coin from the next block;
  - a transaction that leaves the mempool unconfirmed is forgotten; a verbose mempool transaction has no block fields;
  - `mine()` builds real 80-byte headers linked by prev-hash and can confirm chosen transactions (`include`); a block drops the mempool transactions it conflicts with;
  - `disconnectBlocks` for reorgs, with `undoBlock` no longer wiping the mempool or restoring phantom coins.

The audit's other findings (finality checked first, Fulcrum's `listunspent` order, and the rest) are PLAN.md's phase 4. Where the upstream READMEs under `src/` describe behaviour these fixes changed, they have been updated.

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
