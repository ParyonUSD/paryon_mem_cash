# Changelog

`@paryonusd/mem-cash` is a fork of mem-cash (https://github.com/mainnet-pat/mem-cash) at 0.0.9. Its
entries each name how the fork differs from upstream. The entries from 0.0.9 down describe upstream's
versions.

Versions 0.0.7 to 0.0.9 were published to npm by mainnet-pat without their source on GitHub. Their
entries below are written by the fork, which recovered each version's TypeScript from the published
build; the code is upstream's and does not differ from it.

## 0.1.0 (unreleased)

The first version of the fork: upstream 0.0.9 in one package, with the behaviour fixes the Paryon
transaction service's simulated network needs.

### Packaging

- **One package instead of five.** `@mem-cash/types`, `storage`, `validation`, `core` and
  `electrum` become the folders `src/types`, `src/storage`, `src/validation`, `src/core` and
  `src/electrum` of `@paryonusd/mem-cash`, with upstream's layering. Upstream publishes five
  packages at one version.
- **Two entry points.** `@paryonusd/mem-cash` exports every name the five 0.0.9 packages exported,
  so moving from them is a change of import paths; `@paryonusd/mem-cash/validation` exports what
  `@mem-cash/validation` did. Upstream has one entry point per package.
- **`AddUtxoParams` is the node's.** Upstream's storage and core packages both exported an
  `AddUtxoParams`. From `@paryonusd/mem-cash` the name is core's (the node's `addUtxo`), and the
  storage test helper's is exported as `StorageAddUtxoParams`.
- **Validation carries its reject codes.** Upstream's `@mem-cash/validation` imports
  `@mem-cash/types` at runtime without declaring it as a dependency, so it resolves only when
  installed next to the other packages. `./validation` includes `src/types` in the package.
- **`@bitauth/libauth` pinned at `3.1.0-next.8`.** Upstream depends on `^3.1.0-next.8`. The
  consensus overrides deep-import `@bitauth/libauth/build/lib/...`, internal paths a libauth release
  may move, so the fork takes a new libauth only on purpose.
- **Tooling.** pnpm, `tsc` to `dist` (no source maps), eslint with typescript-eslint and vitest,
  CI on Node 24; upstream uses yarn workspaces, `tsc -b`, biome and CI on Node 20, 22 and 24. The
  tests import source, so they no longer need a build first, and they are now type-checked
  (`tsconfig.test.json`), which upstream's are not. `engines.node` is `>=22` (upstream `>=20`).
- **Tests.** Upstream's 319 tests pass unchanged apart from import paths, and apart from fixtures
  that computed the plain scripthash, which the byte-order fix reverses; `scripthash.test.ts` gains
  an import of the `ScriptHash` type it used without importing. `src/exports.test.ts` is new and
  holds both entry points to the 0.0.9 names and the fork's additions. `src/testkit.ts` holds the
  fork's test transactions and is left out of the build.

### Behaviour

- **Scripthashes in the Electrum byte order.** The node files coins, history and subscriptions
  under the sha256 of the locking bytecode with its bytes reversed, the scripthash the Electrum
  protocol defines and clients send; `blockchain.address.get_scripthash` and `utxo.get_info` answer
  with it. Upstream used the hash unreversed, so a real client's `scripthash.*` requests found
  nothing. New export `computeScriptHash(lockingBytecode)`. Upstream tests that computed the plain
  hash now reverse it.

- **Protocol 1.4 to 1.5.3, as Fulcrum 1.x.** `server.version` parses versions of up to three parts
  and answers with the negotiated one in Fulcrum's form (`"1.5"` for 1.5.0), and `server.features`
  advertises 1.4 to 1.5.3. Upstream negotiated 1.6 only and parsed two parts, so it refused the
  `"1.5.0"` and `"1.5.2"` clients send. `blockchain.block.headers` keeps its 1.5 shape (`hex`), which
  is now what the negotiated version promises; the Indexer's request types (`ElectrumCashTestSchema`)
  are built on the 1.5.3 schema to match, and `server.version` is typed to take a `[min, max]` range.

- **A double spend and a missing input answer differently, as BCHN.** An input a mempool transaction
  already spends is refused with `txn-mempool-conflict (code 18)`, checked on every input before any
  is looked up; an input the node does not have, or a block spent, with `Missing inputs` and no code,
  which is what BCHN's `sendrawtransaction` says. Upstream answered `bad-txns-inputs-missingorspent
  (code 16)` for both. `SubmitFailure` gains `message`, the text BCHN answers with, which the
  broadcast handlers wrap; `error` and `code` keep BCHN's reject reason and code. New
  `StorageReader.getMempoolSpender(outpoint)`.

- **Rebroadcasting a mempool transaction succeeds.** `submitTransaction` and the broadcast handlers
  answer a transaction the mempool already holds with its txid, as BCHN's `sendrawtransaction` does,
  without notifying anyone (`affectedScriptHashes` is empty). Upstream refused it as spending its own
  inputs again.

- **A confirmed transaction is refused as `transaction already in block chain`.** While the chain's
  coins hold one of its outputs (spent in the mempool or not), as BCHN's `sendrawtransaction`
  decides it. Upstream validated it again and answered that its inputs were missing or spent.

- **Refusals in BCHN's `FormatStateMessage` form, non-final with code 64.** A refusal's text is the
  reason, the debug message after a comma when there is one, then the code: a transaction not final
  yet reads `bad-txns-nonfinal, non-final transaction (code 64)`, the `non-final transaction` a
  client classifies. The verifier gives a non-final transaction code 64 (`REJECT_NONSTANDARD`), as
  BCHN's mempool re-codes it; `checkLocktimeFinality` keeps the consensus code 16. Upstream left out
  the debug message and answered `bad-txns-nonfinal (code 16)`.

- **Mempool transactions linked to their parents.** A transaction spending a mempool coin records it
  as an unconfirmed spend and the spender as a child, so its mempool history entries are at height -1
  (Fulcrum's) and removing a transaction removes its descendants. A block that confirms a parent keeps
  its children in the mempool: what they spend of it becomes a confirmed spend, and a child left with
  no unconfirmed parent moves to height 0. Upstream passed a mempool coin to the verifier without a
  height, read as 1, so it linked nothing; and a block confirming a transaction removed its
  descendants too.

- **BIP68 counts a mempool coin from the next block.** The verifier evaluates a relative height lock
  on a source output at height 0 as if the coin confirmed in the next block, as BCHN's
  `CheckSequenceLocks` does, so any lock above 0 on an unconfirmed parent is refused as
  `non-BIP68-final (code 64)`. Upstream counted it from height 1 and accepted it.

- **A transaction that leaves the mempool unconfirmed is forgotten.** Removing it (with its
  descendants) or clearing the mempool drops its raw transaction unless a block holds it, so
  `blockchain.transaction.get` answers `No such mempool or blockchain transaction`, as Fulcrum over
  BCHN does. Upstream kept every raw transaction it had ever accepted.

- **A verbose mempool transaction has no block fields.** `blockchain.transaction.get` with `verbose`
  leaves out `blockhash`, `blocktime`, `time` and `confirmations` for a transaction not in a block,
  as `getrawtransaction` does; the schema marks them optional. Upstream gave an empty block hash and
  zeros.

- **`mine()` builds real headers.** Each block gets an 80-byte header (version, the tip's hash,
  the merkle root of its txids, its time, regtest bits, a nonce that sets apart every block the node
  mines) and the double-sha256 hash of it, so blocks link by prev-hash and have distinct hashes. The
  headers before it are left as they are: upstream stored 80 zero bytes under a hash of the height
  and then rewrote the last 11 headers with the block's time (`setChainTip`), so the median time
  past after `mine()` was the block's time; it is now the median of the real timestamps. New export
  `createBlockHeader`.

- **`setChainTip` stores real headers.** Its 11 headers are empty 80-byte headers built the same
  way, each linked by prev-hash to the one before (or to the header already stored below them), so
  the tip's hex hashes to the hash the first mined block names as its parent. Upstream stored 80
  zero bytes under a hash made from the height, and a client checking linkage by hashing hex saw
  the first mined block as a reorg.

- **A block drops the mempool transactions it conflicts with.** `applyBlock` removes a mempool
  transaction spending a coin the block spends, with its descendants, as BCHN's `removeForBlock`
  does. Upstream kept it, with the coin still marked as spent in the mempool.

- **`undoBlock` restores no phantom coins and keeps the mempool.** A coin the undone block both
  created and spent is not restored, and the block's history entries and transaction records are
  removed by txid rather than every record at its height. The mempool is left for the node to
  rebuild (see `disconnectBlocks`); upstream cleared it.

- **Reorgs: `Node.disconnectBlocks(count, { replacementTxs })`.** Disconnects the last `count`
  blocks: their transactions return to the mempool ahead of what it held, each admitted again at the
  new tip, and one no longer valid there drops out with its descendants; coins they spend stay spent
  (by the mempool). Replacement transactions are admitted first, so the ones they conflict with are
  the ones that drop, which is how a new branch gets a double spend; a refused replacement throws and
  leaves the node as it was, and so does a block applied without its raw transactions (`rawHex`),
  which cannot be returned to the mempool. Subscribers hear once per scripthash. Upstream had only `undoBlock`,
  which cleared the mempool. New types `DisconnectOptions`, `DisconnectResult`.

- **`mine({ include })` confirms chosen transactions.** `mine()` takes `{ timestamp, include }` (a
  number is still the timestamp): with `include`, the block holds only the listed mempool
  transactions, in mempool order, and the rest stay in the mempool, children of a confirmed parent
  relinked. A listed transaction whose unconfirmed parent is not listed, or one not in the mempool,
  throws. Upstream confirmed the whole mempool and cleared it. New type `MineOptions`.

- **Finality before inputs.** A transaction that is not final yet is refused as
  `bad-txns-nonfinal, non-final transaction (code 64)` even when an input is missing or conflicts
  with the mempool, as BCHN's `AcceptToMemoryPoolWorker` checks finality before it looks up inputs.
  The verifier gains an optional `checkBeforeInputs(rawHex, chainState)` with the checks that need no
  inputs, which the node runs first, in `submitTransaction` and `debugTransaction`. Upstream looked
  the inputs up first and answered `Missing inputs` or `txn-mempool-conflict`.

- **`listunspent` in Fulcrum's order.** `getUtxos`, and so `listunspent`, lists confirmed coins by
  height and their transaction's position in the block, then mempool coins whose transaction has no
  unconfirmed parent, then those whose transaction has one; ties by output index, value, then txid
  (Fulcrum's `UnspentItem::operator<`). A coin seeded with the test helpers, which sits in no block,
  comes after a block's own at its height. Upstream listed coins in the order they arrived.

- **`get_first_use` from the mempool as Fulcrum.** With no confirmed history, it answers the first
  mempool transaction that pays the scripthash (skipping one that only spends from it), at height -1
  when that transaction has an unconfirmed parent. Upstream answered the first mempool entry of any
  kind at height 0. The heights -1 of `get_history`, `get_mempool` and the status hash, and the
  notification a subscriber gets when a block confirms the parent, come from the parent links above;
  `mempoolHeights.test.ts` holds them all.

- **Checks in BCHN's order.** The verifier checks what `AcceptToMemoryPoolWorker` checks, in its
  order: the transaction on its own (null prevout, then a duplicate input, now refused as
  `bad-txns-inputs-duplicate (code 16)` by new `checkDuplicateInputs`), dust (standard only), finality,
  then with the inputs BIP68 before `CheckTxInputs` (maturity, unspendable, values, in-belowout), then
  fees and scripts. So dust wins over a fee too low and over a locktime not reached, and an unmet
  relative lock wins over outputs exceeding inputs. Upstream checked dust after the fees, BIP68 after
  in-belowout, and left duplicate inputs to libauth, which answered
  `mandatory-script-verify-flag-failed (... spend the same outpoint in multiple inputs ...)`.

- **Standardness in BCHN's words and place.** With `standard` on, the verifier runs BCHN's
  `IsStandardTx` before finality (`version`, `tx-size`, `scriptsig-size`, `scriptsig-not-pushonly`,
  `scriptpubkey`, `dust`, `oversize-op-return`) and `AreInputsStandard` after `CheckTxInputs`
  (`bad-txns-nonstandard-inputs`), each refused with the bare reason and code 64. The limits are
  libauth's consensus table for the VM version with any `consensus` overrides, as the VM reads them.
  Upstream left all but dust to libauth's standard VM, which refused inside script verification as
  `non-mandatory-script-verify-flag (Unable to verify standard transaction: ...)`, or for a version 3
  or a non-push unlocking script as `mandatory-script-verify-flag-failed (...) (code 16)`, after the
  fees and finality.

- **Data carrier bytes counted as BCHN.** A standard transaction may hold 223 bytes of OP_RETURN
  script in all, each output's whole script counted, as BCHN's `nDataSize`; one output of 223 bytes,
  or two of 111 and 112, is accepted. The verifier builds libauth's standard VM with its data carrier
  limit lifted, as the policy check covers it. `ConsensusOverrides` gains `maximumDataCarrierBytes`
  (BCHN's `-datacarriersize`). Upstream (libauth) counted a length byte more per output and refused
  both.

- **Consensus refusals in BCHN's words and place.** Before the inputs are looked up, a transaction
  without inputs or outputs, over the size limit, or with output values out of range is refused as
  `bad-txns-vin-empty`, `bad-txns-vout-empty`, `bad-txns-oversize`, `bad-txns-vout-toolarge` or
  `bad-txns-txouttotal-toolarge` (code 16, `CheckTransactionCommon`); right after finality, one under
  65 bytes or of a version other than 1 or 2 as `bad-txns-undersize` or `bad-txns-version`, code 64
  as the mempool re-codes them. Upstream answered output values as `bad-txns-outputvalues-outofrange`
  once the inputs were found (so `Missing inputs` first), and left the rest to libauth's VM, refused
  last as `mandatory-script-verify-flag-failed (...) (code 16)`.

- **Token refusals in BCHN's words.** The verifier runs BCHN's `CheckTxTokens` after the fees, output
  by output, answering `bad-txns-token-in-belowout`, `-invalid-category`, `-nft-ex-nihilo`,
  `-dupe-genesis`, `-commitment-oversized` or `-amount-overflow` (code 16), with BCHN's debug message
  quoting the output's `token::OutputData` where BCHN gives one. Upstream left tokens to libauth's VM:
  `mandatory-script-verify-flag-failed (Transaction violates token validation: ...)`.

- **BIP68 time locks enforced.** The node gives the verifier each confirmed coin's median time past
  (of the block before the coin's), and the verifier takes a mempool coin's as the tip's, so a
  time-based relative lock is met only once the tip's median time past is that many 512-second units
  later, as BCHN's `CalculateSequenceLocks`. A coin seeded below the headers the node holds (with
  `addUtxo` under `setChainTip`'s eleven) still counts from time 0. Upstream passed no median time
  past, read as 0, so every time lock was met.

- **Token filters.** `listunspent` and `get_balance` (scripthash and address) take Fulcrum's optional
  second parameter: `include_tokens` (the default), `exclude_tokens` or `tokens_only`, trimmed and in
  any case; anything else is refused as invalid params (-32602) with Fulcrum's message.
  `StorageReader.getBalance` takes the filter as an optional second argument. Upstream ignored the
  parameter.

- **Verbose transactions describe scripts as BCHN.** `blockchain.transaction.get` with `verbose` gives
  every script's asm as BCHN's `ScriptToAsmStr` (pushes of up to 8 bytes as numbers, `OP_0` to `OP_16`
  by number, a signature in an unlocking script with its sighash type named), and a locking script's
  type and addresses as `ScriptPubKeyToUniv`: P2SH32 is `scripthash` with its address, a public key and
  a multisig's keys give their P2PKH addresses, and `nulldata` or `nonstandard` scripts carry no
  `reqSigs` or `addresses` (optional in the schema now). Opcodes are named as libauth's 2023 set names
  them. Upstream gave asm only for OP_RETURN (as hex), knew only P2PKH and P2SH20, and called P2SH32
  nonstandard, with `reqSigs: 1` and no address.

- **`get_balance` leaves out mempool outputs the mempool spends.** The unconfirmed balance is the
  mempool outputs no mempool transaction spends, less the confirmed coins the mempool spends, as
  Fulcrum's `Storage::getBalance`. Upstream counted every mempool output, so a chain of mempool
  transactions added up its intermediate outputs.

- **History within a block in block order.** Confirmed history lists a block's transactions in their
  order in the block, as Fulcrum's txNum order, and the status hash follows it. Upstream sorted them by
  txid, so a parent and child confirmed together could come out child first, with a status hash other
  than Fulcrum's.

- **OP_RETURN outputs are no coins.** Neither the mempool nor a block (mined or applied) indexes an
  output whose script starts with OP_RETURN: no coin, no history for its scripthash, as BCHN's UTXO set
  and Fulcrum's index leave it out. Spending one answers `Missing inputs`. Upstream indexed it as a
  spendable coin, refused as `bad-txns-input-scriptpubkey-unspendable` when spent.

## 0.0.9

Recovered from the npm build (gitHead `6ee1892`, published 2026-07-23).

- `ConsensusOverrides` gains `maximumTokenCommitmentLength`, `operationCostBudgetPerByte` and
  `hashDigestIterationsPerByteNonstandard`.
- When `maximumStackItemLength` is overridden, rebuild the operations that capture it when libauth
  creates the instruction set: `OP_UTXOTOKENCOMMITMENT`, `OP_OUTPUTTOKENCOMMITMENT`,
  `OP_ACTIVEBYTECODE`, `OP_UTXOBYTECODE`, `OP_INPUTBYTECODE` and `OP_OUTPUTBYTECODE`.

## 0.0.8

Recovered from the npm build (gitHead `9d5b36e`, published 2026-07-22).

- Add `TxVerifierConfig.consensus` (`ConsensusOverrides`) - overrides libauth's consensus limits
  (bytecode, stack item, VM number, standard unlocking/locking bytecode, transaction and standard
  transaction size) for private and test networks. Each value must be a positive safe integer.
  With overrides, the VM is built from libauth's instruction sets and consensus tables, imported
  from `@bitauth/libauth/build/lib/...`.
- `createVmFacade` takes the overrides as an optional third argument.

## 0.0.7

Recovered from the npm build (gitHead `9fa7824`, published 2026-07-19).

- Add `snapshot()` / `restore()` to the memory storage and the Node: a `structuredClone` of the
  whole chain and mempool state, restorable any number of times. Export the `StorageSnapshot` type.
- Add `Node.setNextBlockTimestamp` - sets the timestamp the next `mine()` uses.
- `mine()` without a timestamp never goes backwards from the tip's timestamp.

## 0.0.6

- Export `getDustThreshold` - reusable token-aware dust calculator.
- Add `TxVerifierConfig.skipFeePolicy` - skips min-relay/absurd-fee; keeps consensus/scripts/dust.
- Add fixed `DUST_RELAY_FEE_PER_KB` constant + `TxVerifierConfig.dustRelayFeePerKb`; dust no longer scales with `minRelayFeePerKb`.
- Export the now-sync `createVmFacade` (and `VmFacade` type).
- Add public `reset()` to the Node/Indexer (clears all storage).
- `Node.addUtxo` accepts `tokenData` for token UTXOs.

## 0.0.5

Rework createVmFacade to be sync.

## 0.0.4

Fix fee policy checks to match BCHN behavior:
- `checkMinRelayFee` now uses floor division with min-1-sat guard (matching `CFeeRate::GetFee`).
- `checkDustOutputs` now computes `3 * GetFee(nSize)` matching BCHN's `GetDustThreshold` order of operations.

## 0.0.3

Node's `setVerifier` allows setting the transaction verifier after creation.

## 0.0.2

VM node's 'addUtxo' accepts addresses.

## 0.0.1

Initial release. In-memory Bitcoin Cash VM and Electrum Cash protocol in TypeScript.

- **VM layer** -- UTXO set, transaction validation (libauth VM + BCHN 29.0.0 consensus/policy rules), mempool with parent/child tracking, block processing, subscription manager
- **Electrum protocol** -- all 53 Fulcrum-compatible JSON-RPC methods with matching error strings, sort orders, and status hash computation
- **Validation pipeline** -- BCHN-ordered checks with two-pass script verification, reject codes, and debug traces
- **5 packages** -- `types`, `storage`, `validation`, `core`, `electrum` with tree-shakeable ESM, no classes, pluggable storage interface
