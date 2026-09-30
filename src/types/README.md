# src/types

Formerly `@mem-cash/types`; exported from `@paryonusd/mem-cash`.

Primitives, data types, and interfaces shared by the other folders.

## Contents

- **Primitives** -- `ScriptHash`, `Txid`, `BlockHash`, `OutpointKey` type aliases; `computeScriptHash` gives the Electrum protocol's byte-reversed scripthash of a locking bytecode; `parseOutpointKey` validates vout as an integer in `[0, 0xFFFFFFFF]`
- **Data types** -- `BlockHeader`, `UtxoEntry`, `HistoryEntry`, `MempoolTx`, `TransactionRecord`, `Balance`, `TokenData`
- **Storage interfaces** -- `StorageReader`, `StorageWriter`, `Storage` for pluggable backends
- **Merkle utilities** -- `computeTxMerkleBranch`, `computeHeaderMerkleBranch` for SPV proofs; input validation rejects empty hash lists, out-of-bounds indices, and non-32-byte hashes
- **MTP** -- `computeMedianTimePast` (BIP113)
- **Reject codes** -- BCHN-compatible `REJECT_INVALID`, `REJECT_NONSTANDARD`, etc.
