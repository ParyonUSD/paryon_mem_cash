# src/storage

Formerly `@mem-cash/storage`; exported from `@paryonusd/mem-cash`.

In-memory implementation of the `Storage` interface from `src/types`.

## Usage

```typescript
import { createMemoryStorage } from "@paryonusd/mem-cash";

const storage = createMemoryStorage();

// StorageReader methods
storage.getHeader(height);
storage.getHistory(scriptHash);
storage.getBalance(scriptHash);
storage.getUtxos(scriptHash);
storage.getScriptHashStatus(scriptHash);

// StorageWriter methods
storage.applyBlock(block);
storage.undoBlock(height);
storage.addMempoolTx(tx);
```

## Defensive Copies

All reader methods that return `UtxoEntry` objects (`getUtxos`, `getUtxoByOutpoint`, `getMempoolUtxo`) return cloned entries with copied `lockingBytecode` buffers. This prevents external code from mutating internal storage state. `getTxidsAtHeight` also returns a shallow copy.

Undo snapshots created during `applyBlock` clone spent UTXOs so that reorgs restore clean data even if callers mutated returned entries. `undoBlock` restores no coin the block itself created and spent, and leaves the mempool alone; `Node.disconnectBlocks` rebuilds it. `applyBlock` removes the mempool transactions the block confirms, keeping their children (relinked), and those it conflicts with, with their descendants.

## Mempool Child Removal

`removeMempoolTx` uses iterative traversal (not recursion) to cascade-delete descendant transactions, preventing stack overflow on deep chains.

## Test Helpers

`createMemoryStorage()` returns a `TestableStorage` with a `_test` namespace for direct state manipulation:

```typescript
storage._test.utxo.add({ txid, vout, satoshis, scriptHash, height });
storage._test.header.add({ hash, height, timestamp });
storage._test.mempool.add({ txid, fee, size, inputs, outputs });
storage._test.tx.add({ txid, height, rawHex });
storage._test.history.add({ scriptHash, entries });
storage._test.reset();
```
