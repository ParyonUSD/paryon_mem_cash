import { binToHex, sha256, utf8ToBin } from "@bitauth/libauth";
import type {
	Balance,
	BlockHeader,
	HistoryEntry,
	MempoolTx,
	OutpointKey,
	ProcessedBlock,
	ScriptHash,
	Storage,
	TransactionRecord,
	Txid,
	UndoInfo,
	UtxoEntry,
} from "../types/index.js";
import { makeOutpointKey } from "../types/index.js";
import { createTestHelpers, type TestHelpers } from "./testHelpers.js";

/** An opaque, deep-cloned snapshot of the full storage state (chain + mempool). */
export type StorageSnapshot = StorageInternals;

/** Storage extended with direct test manipulation and snapshot/restore. */
export type TestableStorage = Storage & {
	readonly _test: TestHelpers;
	/** Capture a deep-cloned snapshot of the entire storage state. */
	snapshot(): StorageSnapshot;
	/** Restore the storage to a previously captured snapshot (repeatable). */
	restore(snap: StorageSnapshot): void;
};

/** Internal state shared between storage and test helpers. */
export interface StorageInternals {
	// Confirmed chain state
	headers: (BlockHeader | undefined)[];
	headersByHash: Map<string, BlockHeader>;
	utxos: Map<OutpointKey, UtxoEntry>;
	utxosByScriptHash: Map<ScriptHash, Set<OutpointKey>>;
	history: Map<ScriptHash, HistoryEntry[]>;
	txIndex: Map<Txid, TransactionRecord>;
	rawTxs: Map<Txid, string>;
	undoInfos: Map<number, UndoInfo>;

	// Per-block txid ordering (for merkle proofs)
	blockTxids: Map<number, Txid[]>;

	// Mempool state
	mempoolTxs: Map<Txid, MempoolTx>;
	mempoolUtxos: Map<OutpointKey, UtxoEntry>;
	mempoolUtxosByScriptHash: Map<ScriptHash, Set<OutpointKey>>;
	mempoolSpends: Map<OutpointKey, Txid>;
	mempoolHistory: Map<ScriptHash, HistoryEntry[]>;
}

/** Clone a UtxoEntry, copying the mutable lockingBytecode. */
function cloneUtxo(utxo: UtxoEntry): UtxoEntry {
	return { ...utxo, lockingBytecode: utxo.lockingBytecode.slice() };
}

/** Create empty internals. */
function createInternals(): StorageInternals {
	return {
		headers: [],
		headersByHash: new Map(),
		utxos: new Map(),
		utxosByScriptHash: new Map(),
		history: new Map(),
		txIndex: new Map(),
		rawTxs: new Map(),
		undoInfos: new Map(),
		blockTxids: new Map(),
		mempoolTxs: new Map(),
		mempoolUtxos: new Map(),
		mempoolUtxosByScriptHash: new Map(),
		mempoolSpends: new Map(),
		mempoolHistory: new Map(),
	};
}

/** Compute Electrum-style status hash: SHA256 of concatenated `"txHash:height:"` strings. */
function computeStatusHash(entries: HistoryEntry[]): string | null {
	if (entries.length === 0) return null;

	let concatenated = "";
	for (const entry of entries) {
		concatenated += `${entry.txHash}:${entry.height}:`;
	}

	return binToHex(sha256.hash(utf8ToBin(concatenated)));
}

/**
 * A block transaction's outputs that are coins: an OP_RETURN output is none, as BCHN never adds it to the
 * UTXO set and Fulcrum indexes neither a coin nor history for it. Upstream indexed every output.
 */
function indexedOutputs(tx: ProcessedBlock["transactions"][number]) {
	return tx.outputs.filter((output) => output.utxo.lockingBytecode[0] !== OP_RETURN);
}

const OP_RETURN = 0x6a;

/** Get or create a set in a map. */
function getOrCreateSet<K, V>(map: Map<K, Set<V>>, key: K): Set<V> {
	let set = map.get(key);
	if (!set) {
		set = new Set();
		map.set(key, set);
	}
	return set;
}

/**
 * Insert a confirmed history entry by height, after the entries already at its height: applyBlock inserts
 * a block's transactions in block order, so they keep it, as Fulcrum's txNum order does. Upstream sorted
 * them by txHash, which the status hash then followed.
 */
function insertHistorySorted(entries: HistoryEntry[], entry: HistoryEntry): void {
	let i = entries.length;
	while (i > 0) {
		const prev = entries[i - 1];
		if (!prev || prev.height <= entry.height) break;
		i--;
	}
	entries.splice(i, 0, entry);
}

/**
 * Insert a mempool history entry maintaining Fulcrum's mempool sort order:
 * height 0 (confirmed parents) before height -1 (unconfirmed parents),
 * within same height sorted by txHash ascending.
 * This is equivalent to (height descending, txHash ascending).
 */
function insertMempoolHistorySorted(entries: HistoryEntry[], entry: HistoryEntry): void {
	let i = entries.length;
	while (i > 0) {
		const prev = entries[i - 1];
		if (!prev || prev.height > entry.height) break;
		if (prev.height === entry.height && prev.txHash <= entry.txHash) break;
		i--;
	}
	entries.splice(i, 0, entry);
}

/** Create a new in-memory storage instance with test helpers. */
export function createMemoryStorage(): TestableStorage {
	const s = createInternals();

	// --- StorageReader ---

	function getHeader(height: number): BlockHeader | undefined {
		return s.headers[height];
	}

	function getHeaderByHash(hash: string): BlockHeader | undefined {
		return s.headersByHash.get(hash);
	}

	function getTip(): BlockHeader | undefined {
		for (let i = s.headers.length - 1; i >= 0; i--) {
			const h = s.headers[i];
			if (h) return h;
		}
		return undefined;
	}

	function getHistory(
		scriptHash: ScriptHash,
		fromHeight?: number,
		toHeight?: number,
	): HistoryEntry[] {
		const all = s.history.get(scriptHash);
		if (!all) return [];

		if (fromHeight === undefined && toHeight === undefined) return [...all];

		return all.filter((e) => {
			if (fromHeight !== undefined && e.height < fromHeight) return false;
			if (toHeight !== undefined && e.height > toHeight) return false;
			return true;
		});
	}

	function getMempoolHistory(scriptHash: ScriptHash): HistoryEntry[] {
		return [...(s.mempoolHistory.get(scriptHash) ?? [])];
	}

	function getBalance(
		scriptHash: ScriptHash,
		tokenFilter: "include_tokens" | "exclude_tokens" | "tokens_only" = "include_tokens",
	): Balance {
		const counts = (utxo: UtxoEntry) =>
			tokenFilter === "include_tokens" || (tokenFilter === "tokens_only") === (utxo.tokenData !== undefined);
		// Confirmed balance: sum of confirmed UTXOs
		let confirmed = 0n;
		const confirmedKeys = s.utxosByScriptHash.get(scriptHash);
		if (confirmedKeys) {
			for (const key of confirmedKeys) {
				const utxo = s.utxos.get(key);
				if (utxo && counts(utxo)) confirmed += utxo.satoshis;
			}
		}

		// Unconfirmed delta, as Fulcrum's Storage::getBalance:
		//   + mempool outputs to this scripthash that no mempool transaction spends
		//   - confirmed UTXOs spent in mempool (confirmedSpends only, not unconfirmedSpends)
		// Upstream added the mempool outputs a mempool child spends too.
		let unconfirmed = 0n;

		// Add mempool UTXO values
		const mempoolKeys = s.mempoolUtxosByScriptHash.get(scriptHash);
		if (mempoolKeys) {
			for (const key of mempoolKeys) {
				if (s.mempoolSpends.has(key)) continue;
				const utxo = s.mempoolUtxos.get(key);
				if (utxo && counts(utxo)) unconfirmed += utxo.satoshis;
			}
		}

		// Subtract confirmed UTXOs spent in mempool
		for (const mempoolTx of s.mempoolTxs.values()) {
			const entry = mempoolTx.entries.get(scriptHash);
			if (!entry) continue;
			for (const spentKey of entry.confirmedSpends) {
				const utxo = s.utxos.get(spentKey);
				if (utxo && counts(utxo)) unconfirmed -= utxo.satoshis;
			}
		}

		return { confirmed, unconfirmed };
	}

	/**
	 * Unspent coins in Fulcrum's listunspent order (Storage.cpp UnspentItem::operator<): confirmed ones by
	 * height and the position of their transaction in its block, then mempool ones whose transaction has
	 * no unconfirmed parent, then those whose transaction has one; ties by output index, value, then txid.
	 * Upstream listed them in the order they arrived, which a client picking the first coin sees.
	 */
	function getUtxos(scriptHash: ScriptHash): UtxoEntry[] {
		const rank = (utxo: UtxoEntry): [number, number] => {
			if (utxo.height > 0) {
				// A coin seeded with the test helpers has no block to sit in; it goes after the block's own
				const position = s.blockTxids.get(utxo.height)?.indexOf(utxo.outpoint.txid) ?? -1;
				return [utxo.height, position === -1 ? Number.MAX_SAFE_INTEGER : position];
			}
			const hasUnconfirmedParent = (s.mempoolTxs.get(utxo.outpoint.txid)?.parents.size ?? 0) > 0;
			return [Number.MAX_SAFE_INTEGER, hasUnconfirmedParent ? 1 : 0];
		};
		return listUtxos(scriptHash)
			.map((utxo) => ({ utxo, rank: rank(utxo) }))
			.sort((a, b) =>
				a.rank[0] - b.rank[0] ||
				a.rank[1] - b.rank[1] ||
				a.utxo.outpoint.vout - b.utxo.outpoint.vout ||
				Number(a.utxo.satoshis - b.utxo.satoshis) ||
				compareStrings(a.utxo.outpoint.txid, b.utxo.outpoint.txid))
			.map(({ utxo }) => utxo);
	}

	function listUtxos(scriptHash: ScriptHash): UtxoEntry[] {
		const result: UtxoEntry[] = [];

		// Confirmed UTXOs not spent in mempool
		const confirmedKeys = s.utxosByScriptHash.get(scriptHash);
		if (confirmedKeys) {
			for (const key of confirmedKeys) {
				if (s.mempoolSpends.has(key)) continue;
				const utxo = s.utxos.get(key);
				if (utxo) result.push(cloneUtxo(utxo));
			}
		}

		// Mempool UTXOs (unconfirmed outputs)
		const mempoolKeys = s.mempoolUtxosByScriptHash.get(scriptHash);
		if (mempoolKeys) {
			for (const key of mempoolKeys) {
				if (s.mempoolSpends.has(key)) continue;
				const utxo = s.mempoolUtxos.get(key);
				if (utxo) result.push(cloneUtxo(utxo));
			}
		}

		return result;
	}

	function getTx(txid: Txid): TransactionRecord | undefined {
		return s.txIndex.get(txid);
	}

	function getRawTx(txid: Txid): string | undefined {
		return s.rawTxs.get(txid);
	}

	function getScriptHashStatus(scriptHash: ScriptHash): string | null {
		const confirmed = s.history.get(scriptHash) ?? [];
		const mempool = s.mempoolHistory.get(scriptHash) ?? [];
		return computeStatusHash([...confirmed, ...mempool]);
	}

	function getMempoolTx(txid: Txid): MempoolTx | undefined {
		return s.mempoolTxs.get(txid);
	}

	function getTxidsAtHeight(height: number): Txid[] | undefined {
		const txids = s.blockTxids.get(height);
		return txids ? [...txids] : undefined;
	}

	function getUtxoByOutpoint(key: OutpointKey): UtxoEntry | undefined {
		if (s.mempoolSpends.has(key)) return undefined;
		const utxo = s.utxos.get(key) ?? s.mempoolUtxos.get(key);
		return utxo ? cloneUtxo(utxo) : undefined;
	}

	function getMempoolSpender(key: OutpointKey): Txid | undefined {
		return s.mempoolSpends.get(key);
	}

	function getMempoolTxids(): Txid[] {
		return [...s.mempoolTxs.keys()];
	}

	function getMempoolUtxo(key: OutpointKey): UtxoEntry | undefined {
		const utxo = s.mempoolUtxos.get(key);
		return utxo ? cloneUtxo(utxo) : undefined;
	}

	// --- StorageWriter ---

	function applyBlock(block: ProcessedBlock): Set<ScriptHash> {
		const affected = new Set<ScriptHash>();
		const addedUtxoKeys: OutpointKey[] = [];
		const removedUtxos: UtxoEntry[] = [];

		// Every output first, then every input, as BCHN's ConnectBlock does: under CTOR a block orders its
		// transactions by txid, so a child can come before the parent it spends. Upstream went transaction
		// by transaction, and a child ahead of its parent left the coin it spent unspent.
		for (const tx of block.transactions) {
			for (const output of indexedOutputs(tx)) {
				s.utxos.set(output.outpointKey, output.utxo);
				getOrCreateSet(s.utxosByScriptHash, output.utxo.scriptHash).add(output.outpointKey);
				addedUtxoKeys.push(output.outpointKey);
				affected.add(output.utxo.scriptHash);
			}
		}

		for (const tx of block.transactions) {
			// Process inputs (spend UTXOs)
			for (const input of tx.inputs) {
				const key = makeOutpointKey(input.prevOutpoint.txid, input.prevOutpoint.vout);
				// A mempool transaction spending the same coin lost the double spend: it goes, with its
				// descendants, as BCHN's removeForBlock removes conflicts
				const spender = s.mempoolSpends.get(key);
				if (spender !== undefined && spender !== tx.txid) removeMempoolTxInternal(spender, affected);
				const existing = s.utxos.get(key);
				if (existing) {
					removedUtxos.push(cloneUtxo(existing));
					affected.add(existing.scriptHash);
					s.utxos.delete(key);
					const shSet = s.utxosByScriptHash.get(existing.scriptHash);
					if (shSet) {
						shSet.delete(key);
						if (shSet.size === 0) s.utxosByScriptHash.delete(existing.scriptHash);
					}
				}
			}

			// Store transaction record
			const txRecord: TransactionRecord = {
				txid: tx.txid,
				height: block.height,
			};
			if (tx.rawHex !== undefined) {
				(txRecord as { rawHex: string }).rawHex = tx.rawHex;
			}
			if (tx.fee !== undefined) {
				(txRecord as { fee: bigint }).fee = tx.fee;
			}
			s.txIndex.set(tx.txid, txRecord);
			if (tx.rawHex) {
				s.rawTxs.set(tx.txid, tx.rawHex);
			}

			// Remove from mempool if present. Its children stay: they spend a confirmed coin now.
			if (s.mempoolTxs.has(tx.txid)) {
				confirmMempoolTx(tx.txid, affected);
			}
		}

		// Update history for all affected scripthashes
		for (const tx of block.transactions) {
			const txScriptHashes = new Set<ScriptHash>();
			for (const input of tx.inputs) {
				const key = makeOutpointKey(input.prevOutpoint.txid, input.prevOutpoint.vout);
				const removed = removedUtxos.find(
					(u) => makeOutpointKey(u.outpoint.txid, u.outpoint.vout) === key,
				);
				if (removed) txScriptHashes.add(removed.scriptHash);
			}
			for (const output of indexedOutputs(tx)) {
				txScriptHashes.add(output.utxo.scriptHash);
			}

			for (const sh of txScriptHashes) {
				const entries = getOrCreateArray(s.history, sh);
				insertHistorySorted(entries, { txHash: tx.txid, height: block.height });
			}
		}

		// Store block txid ordering (for merkle proofs)
		s.blockTxids.set(
			block.height,
			block.transactions.map((tx) => tx.txid),
		);

		// Store header
		s.headers[block.height] = block.header;
		s.headersByHash.set(block.hash, block.header);

		// Store undo info
		s.undoInfos.set(block.height, {
			height: block.height,
			hash: block.hash,
			addedUtxos: addedUtxoKeys,
			removedUtxos,
			affectedScriptHashes: affected,
		});

		return affected;
	}

	function undoBlock(height: number): Set<ScriptHash> {
		const undo = s.undoInfos.get(height);
		if (!undo) return new Set();

		const affected = new Set(undo.affectedScriptHashes);
		const blockTxids = new Set(s.blockTxids.get(height) ?? []);

		// Remove UTXOs added by this block
		for (const key of undo.addedUtxos) {
			const utxo = s.utxos.get(key);
			if (utxo) {
				s.utxos.delete(key);
				const shSet = s.utxosByScriptHash.get(utxo.scriptHash);
				if (shSet) {
					shSet.delete(key);
					if (shSet.size === 0) s.utxosByScriptHash.delete(utxo.scriptHash);
				}
			}
		}

		// Restore UTXOs spent by this block, except those it created itself: a coin a parent created and
		// a child in the same block spent existed neither before nor after, and upstream brought it back
		const added = new Set(undo.addedUtxos);
		for (const utxo of undo.removedUtxos) {
			const key = makeOutpointKey(utxo.outpoint.txid, utxo.outpoint.vout);
			if (added.has(key)) continue;
			s.utxos.set(key, utxo);
			getOrCreateSet(s.utxosByScriptHash, utxo.scriptHash).add(key);
		}

		// Remove the block's history entries and transaction records. By txid, not by height: other
		// records can sit at the same height (coins a consumer seeded with the test helpers).
		for (const sh of affected) {
			const entries = s.history.get(sh);
			if (entries) {
				const filtered = entries.filter((e) => !blockTxids.has(e.txHash));
				if (filtered.length === 0) {
					s.history.delete(sh);
				} else {
					s.history.set(sh, filtered);
				}
			}
		}
		for (const txid of blockTxids) {
			s.txIndex.delete(txid);
			s.rawTxs.delete(txid);
		}

		// Remove block txids
		s.blockTxids.delete(height);

		// Remove header
		const header = s.headers[height];
		if (header) {
			s.headersByHash.delete(header.hash);
			s.headers[height] = undefined;
		}
		// Trim trailing undefineds
		while (s.headers.length > 0 && s.headers[s.headers.length - 1] === undefined) {
			s.headers.pop();
		}

		// The mempool is left alone. Upstream cleared it; the node instead takes it out before undoing
		// and admits the undone transactions and it again (Node.disconnectBlocks).

		s.undoInfos.delete(height);

		return affected;
	}

	function addMempoolTx(tx: MempoolTx): Set<ScriptHash> {
		const affected = new Set<ScriptHash>();

		s.mempoolTxs.set(tx.txid, tx);

		for (const [scriptHash, entry] of tx.entries) {
			affected.add(scriptHash);

			// Track confirmed spends
			for (const key of entry.confirmedSpends) {
				s.mempoolSpends.set(key, tx.txid);
			}

			// Track unconfirmed spends
			for (const key of entry.unconfirmedSpends) {
				s.mempoolSpends.set(key, tx.txid);
			}

			// Add mempool UTXOs
			for (const key of entry.outputs) {
				const utxo = s.mempoolUtxos.get(key);
				// The UTXO must be provided via mempoolUtxos already, or we create a placeholder
				// In practice, the caller builds the full MempoolTx with UTXOs set up via test helpers
				if (!utxo) continue;
				getOrCreateSet(s.mempoolUtxosByScriptHash, scriptHash).add(key);
			}

			// Add mempool history (sorted: height 0 before -1, then by txHash)
			const hasUnconfirmedParent = tx.parents.size > 0;
			const historyEntry: HistoryEntry = {
				txHash: tx.txid,
				height: hasUnconfirmedParent ? -1 : 0,
				fee: tx.fee,
			};
			const mempoolEntries = getOrCreateArray(s.mempoolHistory, scriptHash);
			insertMempoolHistorySorted(mempoolEntries, historyEntry);
		}

		// Update parent→child linkage
		for (const parentTxid of tx.parents) {
			const parentTx = s.mempoolTxs.get(parentTxid);
			if (parentTx) {
				(parentTx.children as Set<Txid>).add(tx.txid);
			}
		}

		return affected;
	}

	function removeMempoolTx(txid: Txid): Set<ScriptHash> {
		const affected = new Set<ScriptHash>();
		removeMempoolTxInternal(txid, affected);
		return affected;
	}

	function removeMempoolTxInternal(txid: Txid, affected: Set<ScriptHash>): void {
		// Iterative traversal to avoid stack overflow on deep chains
		const stack: Txid[] = [txid];
		const toRemove: Txid[] = [];
		const visited = new Set<Txid>();

		// Collect all descendants depth-first (children before parents)
		while (stack.length > 0) {
			const current = stack.pop() as Txid;
			if (visited.has(current)) continue;
			visited.add(current);
			toRemove.push(current);

			const tx = s.mempoolTxs.get(current);
			if (tx) {
				for (const childTxid of tx.children) {
					if (!visited.has(childTxid)) stack.push(childTxid);
				}
			}
		}

		// Remove in reverse order (children first)
		for (let i = toRemove.length - 1; i >= 0; i--) {
			removeOneMempoolTx(toRemove[i] as Txid, affected);
		}
	}

	/** Remove one transaction from the mempool, leaving its children to the caller. */
	function removeOneMempoolTx(removeTxid: Txid, affected: Set<ScriptHash>): void {
		const tx = s.mempoolTxs.get(removeTxid);
		if (!tx) return;

		for (const [scriptHash, entry] of tx.entries) {
			affected.add(scriptHash);

			// Remove spend tracking
			for (const key of entry.confirmedSpends) {
				s.mempoolSpends.delete(key);
			}
			for (const key of entry.unconfirmedSpends) {
				s.mempoolSpends.delete(key);
			}

			// Remove mempool UTXOs
			for (const key of entry.outputs) {
				s.mempoolUtxos.delete(key);
				const shSet = s.mempoolUtxosByScriptHash.get(scriptHash);
				if (shSet) {
					shSet.delete(key);
					if (shSet.size === 0) s.mempoolUtxosByScriptHash.delete(scriptHash);
				}
			}

			// Remove mempool history
			const mempoolEntries = s.mempoolHistory.get(scriptHash);
			if (mempoolEntries) {
				const filtered = mempoolEntries.filter((e) => e.txHash !== removeTxid);
				if (filtered.length === 0) {
					s.mempoolHistory.delete(scriptHash);
				} else {
					s.mempoolHistory.set(scriptHash, filtered);
				}
			}
		}

		// Remove parent→child reference
		for (const parentTxid of tx.parents) {
			const parentTx = s.mempoolTxs.get(parentTxid);
			if (parentTx) {
				(parentTx.children as Set<Txid>).delete(removeTxid);
			}
		}

		s.mempoolTxs.delete(removeTxid);
		forgetUnconfirmedRawTx(removeTxid);
	}

	/**
	 * A node only knows the transactions of its chain and its mempool, so one that leaves the mempool
	 * without confirming goes from the raw transactions too; upstream kept it answering
	 * blockchain.transaction.get.
	 */
	function forgetUnconfirmedRawTx(txid: Txid): void {
		if (!s.txIndex.has(txid)) s.rawTxs.delete(txid);
	}

	/**
	 * Take a transaction a block confirmed out of the mempool. Its children stay, as they do in BCHN's
	 * mempool: what they spend of it is a confirmed coin now, and one left with no unconfirmed parent
	 * moves from height -1 to 0 in the mempool history, as Fulcrum files it.
	 */
	function confirmMempoolTx(txid: Txid, affected: Set<ScriptHash>): void {
		const tx = s.mempoolTxs.get(txid);
		if (!tx) return;
		removeOneMempoolTx(txid, affected);
		for (const childTxid of tx.children) {
			const child = s.mempoolTxs.get(childTxid);
			if (!child) continue;
			for (const entry of child.entries.values()) {
				const fromParent = entry.unconfirmedSpends.filter((key) => key.startsWith(`${txid}:`));
				if (fromParent.length === 0) continue;
				const unconfirmed = entry.unconfirmedSpends as OutpointKey[];
				unconfirmed.splice(0, unconfirmed.length, ...unconfirmed.filter((key) => !fromParent.includes(key)));
				(entry.confirmedSpends as OutpointKey[]).push(...fromParent);
			}
			(child.parents as Set<Txid>).delete(txid);
			if (child.parents.size > 0) continue;
			for (const scriptHash of child.entries.keys()) {
				affected.add(scriptHash);
				const entries = s.mempoolHistory.get(scriptHash) ?? [];
				const others = entries.filter((e) => e.txHash !== childTxid);
				insertMempoolHistorySorted(others, { txHash: childTxid, height: 0, fee: child.fee });
				s.mempoolHistory.set(scriptHash, others);
			}
		}
	}

	function clearMempool(): Set<ScriptHash> {
		const affected = new Set<ScriptHash>();
		clearMempoolInternal(affected);
		return affected;
	}

	function clearMempoolInternal(affected: Set<ScriptHash>): void {
		for (const scriptHash of s.mempoolHistory.keys()) {
			affected.add(scriptHash);
		}
		for (const [, tx] of s.mempoolTxs) {
			for (const scriptHash of tx.entries.keys()) {
				affected.add(scriptHash);
			}
		}
		for (const txid of s.mempoolTxs.keys()) forgetUnconfirmedRawTx(txid);
		s.mempoolTxs.clear();
		s.mempoolUtxos.clear();
		s.mempoolUtxosByScriptHash.clear();
		s.mempoolSpends.clear();
		s.mempoolHistory.clear();
	}

	function addMempoolUtxo(key: OutpointKey, utxo: UtxoEntry): void {
		s.mempoolUtxos.set(key, utxo);
	}

	function storeRawTx(txid: Txid, rawHex: string): void {
		s.rawTxs.set(txid, rawHex);
	}

	// --- Build test helpers ---
	// --- Snapshot / restore ---
	// structuredClone deep-copies Maps, Sets, typed arrays and BigInt while preserving intra-snapshot
	// reference identity (e.g. a UtxoEntry shared between `utxos` and `undoInfos`). Restore repopulates the
	// live internals in place so the closures above keep reading the same `s` object.
	function snapshot(): StorageSnapshot {
		return structuredClone(s);
	}
	function restore(snap: StorageSnapshot): void {
		const c = structuredClone(snap);
		s.headers = c.headers;
		s.headersByHash = c.headersByHash;
		s.utxos = c.utxos;
		s.utxosByScriptHash = c.utxosByScriptHash;
		s.history = c.history;
		s.txIndex = c.txIndex;
		s.rawTxs = c.rawTxs;
		s.undoInfos = c.undoInfos;
		s.blockTxids = c.blockTxids;
		s.mempoolTxs = c.mempoolTxs;
		s.mempoolUtxos = c.mempoolUtxos;
		s.mempoolUtxosByScriptHash = c.mempoolUtxosByScriptHash;
		s.mempoolSpends = c.mempoolSpends;
		s.mempoolHistory = c.mempoolHistory;
	}

	const testHelpers = createTestHelpers(s, { removeMempoolTx, clearMempool });

	return {
		// StorageReader
		getHeader,
		getHeaderByHash,
		getTip,
		getHistory,
		getMempoolHistory,
		getBalance,
		getUtxos,
		getTx,
		getRawTx,
		getScriptHashStatus,
		getMempoolTx,
		getTxidsAtHeight,
		getUtxoByOutpoint,
		getMempoolSpender,
		getMempoolTxids,
		getMempoolUtxo,
		// StorageWriter
		applyBlock,
		undoBlock,
		addMempoolTx,
		removeMempoolTx,
		clearMempool,
		addMempoolUtxo,
		storeRawTx,
		// Snapshot / restore
		snapshot,
		restore,
		// Test
		_test: testHelpers,
	};
}

function compareStrings(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/** Get or create an array in a map. */
function getOrCreateArray<K, V>(map: Map<K, V[]>, key: K): V[] {
	let arr = map.get(key);
	if (!arr) {
		arr = [];
		map.set(key, arr);
	}
	return arr;
}
