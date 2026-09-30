// The whole node and Electrum server, under the names the five @mem-cash/* 0.0.9 packages exported,
// so a consumer switches by changing its import paths. The folders keep upstream's layering: types
// under storage and validation, core on top of those, electrum on top of everything.
//
// Transaction checking on its own is also published as "./validation", which pulls in no node or
// Electrum code.

export * from "./core/index.js";
export * from "./electrum/index.js";
// Storage and core both exported an AddUtxoParams. The node's is the one callers of createNode and
// createIndexer use, so it keeps the name; the storage test helper's is renamed here.
export {
	type AddHeaderParams,
	type AddHistoryParams,
	type AddMempoolTxParams,
	type AddTxParams,
	type AddUtxoParams as StorageAddUtxoParams,
	createMemoryStorage,
	type RemoveUtxoParams,
	type StorageInternals,
	type StorageSnapshot,
	type TestableStorage,
	type TestHelpers,
	type TestMempoolInput,
	type TestMempoolOutput,
} from "./storage/index.js";
export * from "./types/index.js";
export * from "./validation/index.js";
