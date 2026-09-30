import {
	binToHex,
	cashAddressToLockingBytecode,
	decodeTransactionBch,
	hashTransactionUiOrder,
	hexToBin,
} from "@bitauth/libauth";
import type { StorageSnapshot, TestableStorage } from "../storage/index.js";
import { createMemoryStorage } from "../storage/index.js";
import type {
	ProcessedBlock,
	ProcessedBlockInput,
	ProcessedBlockOutput,
	ProcessedBlockTx,
	ScriptHash,
	StorageReader,
	TokenData,
	UtxoEntry,
} from "../types/index.js";
import {
	computeMedianTimePast,
	computeScriptHash,
	makeOutpointKey,
	REJECT_DUPLICATE,
	REJECT_INVALID,
	REJECT_MALFORMED,
} from "../types/index.js";
import type {
	ChainState,
	DebugResult,
	SourceOutput,
	TxVerifier,
	ValidatedTransaction,
} from "../validation/index.js";
import { acceptToMempool } from "./accept.js";
import { createBlockHeader } from "./blockHeader.js";
import type { SubscriptionManager } from "./subscriptionManager.js";
import { createSubscriptionManager } from "./subscriptionManager.js";

/** Configuration for the Node. All fields optional. */
export interface NodeConfig {
	/** Transaction verifier. When provided, submitTransaction runs full validation. */
	readonly verifier?: TxVerifier;
}

/** Parameters for adding a UTXO. Provide `address` or `scriptHash` + `lockingBytecode`. */
export interface AddUtxoParams {
	readonly txid: string;
	readonly vout: number;
	readonly satoshis: bigint;
	/** Cash address (e.g. "bitcoincash:qp..."). Derives scriptHash and lockingBytecode automatically. */
	readonly address?: string;
	/** Explicit scriptHash. Required if address is not provided. */
	readonly scriptHash?: string;
	readonly height: number;
	readonly lockingBytecode?: Uint8Array;
	readonly isCoinbase?: boolean;
	/** Optional CashToken data (category, amount, NFT) carried by this UTXO. */
	readonly tokenData?: TokenData;
}

/** Successful transaction submission. */
export interface SubmitSuccess {
	readonly success: true;
	readonly txid: string;
	readonly fee: bigint;
	readonly size: number;
	readonly affectedScriptHashes: ReadonlySet<ScriptHash>;
}

/** Failed transaction submission. */
export interface SubmitFailure {
	readonly success: false;
	/** BCHN reject code (e.g. REJECT_INVALID, REJECT_NONSTANDARD). */
	readonly code: number;
	/** BCHN strRejectReason. */
	readonly error: string;
	/** BCHN strDebugMessage — optional extra context. */
	readonly debugMessage?: string;
	/**
	 * The refusal as BCHN's sendrawtransaction words it, which Fulcrum passes on: the reject reason and
	 * code for a transaction mempool validation refused, but "Missing inputs" alone for an input the
	 * node does not have, which BCHN reports without a validation state.
	 */
	readonly message: string;
}

/** Result of submitting a transaction. */
export type SubmitResult = SubmitSuccess | SubmitFailure;

/** Result of mining blocks. */
export interface MineResult {
	/** New chain tip height after mining. */
	readonly height: number;
	/** All scripthashes affected by confirming mempool transactions. */
	readonly affectedScriptHashes: ReadonlySet<ScriptHash>;
}

/** Options for disconnecting blocks. */
export interface DisconnectOptions {
	/** Raw transactions admitted before the disconnected ones return, for the new branch to confirm. */
	readonly replacementTxs?: readonly string[];
}

/** Result of disconnecting blocks. */
export interface DisconnectResult {
	/** The tip's height afterwards. */
	readonly height: number;
	/** The transactions admitted to the mempool, in order: replacements, disconnected, then held ones. */
	readonly returned: readonly string[];
	/** The disconnected and held transactions no longer valid at the new tip. */
	readonly dropped: readonly string[];
	readonly affectedScriptHashes: ReadonlySet<ScriptHash>;
}

/** The core node engine with in-memory storage. */
export interface Node extends StorageReader {
	/** Submit a raw transaction hex. */
	readonly submitTransaction: (rawHex: string) => SubmitResult;

	/** Debug a raw transaction: run full validation with per-input traces, without accepting to mempool. */
	readonly debugTransaction: (rawHex: string) => DebugResult | SubmitFailure;

	/** Mine a block: confirms all mempool transactions, advances chain tip. */
	readonly mine: (timestamp?: number) => MineResult;

	/**
	 * Disconnect the last `count` blocks, as a reorg does before it connects the new branch. Their
	 * transactions return to the mempool ahead of what it held, each admitted again at the new tip; one
	 * no longer valid there (a conflict, a lock not final any more) drops out with its descendants.
	 * `replacementTxs` are admitted first, so the transactions they conflict with are the ones that
	 * drop: the way to give a new branch a double spend. A replacement the node refuses throws, leaving
	 * the node as it was. Scripthash subscribers hear once, of the final status; header subscribers
	 * hear of the next block mined.
	 */
	readonly disconnectBlocks: (count: number, options?: DisconnectOptions) => DisconnectResult;

	/** Set chain tip with 11 headers at the given timestamp (sets both height and MTP). */
	readonly setChainTip: (height: number, timestamp: number) => void;

	/** Set the timestamp of the NEXT mined block without mining it (test helper). Consumed by the next mine(). */
	readonly setNextBlockTimestamp: (timestamp: number) => void;

	/** Add a UTXO to the confirmed set. */
	readonly addUtxo: (params: AddUtxoParams) => void;

	/** Reset all storage (UTXOs, transactions, mempool, history, headers) to empty. */
	readonly reset: () => void;

	/** Capture a deep-cloned snapshot of the entire node state (chain + mempool). */
	readonly snapshot: () => StorageSnapshot;

	/** Restore the node to a previously captured snapshot (repeatable). */
	readonly restore: (snap: StorageSnapshot) => void;

	/** Set or replace the transaction verifier. */
	readonly setVerifier: (verifier: TxVerifier) => void;

	/** The underlying storage with test helpers for direct manipulation. */
	readonly storage: TestableStorage;

	/** The subscription manager. */
	readonly subscriptions: SubscriptionManager;
}

/**
 * Create a core node with in-memory storage.
 *
 * Wires together storage, optional transaction verifier, and subscription manager.
 *
 * When `config.verifier` is provided, `submitTransaction` runs full consensus
 * and policy checks. Without a verifier, transactions are decoded and accepted
 * directly (useful for testing or trusted-input scenarios).
 */
export function createNode(config?: NodeConfig): Node {
	const storage = createMemoryStorage();

	let verifier = config?.verifier;
	// Pending timestamp for the next mined block (test helper: setNextBlockTimestamp). Consumed once by mine().
	let pendingTimestamp: number | undefined;
	// Sets apart the blocks this node mines, even two on the same parent with the same transactions
	let nextNonce = 0;
	const subscriptions = createSubscriptionManager(storage);

	function deriveChainState(): ChainState | null {
		const tip = storage.getTip();
		if (!tip) return null;
		return {
			height: tip.height,
			medianTimePast: computeMedianTimePast(storage, tip.height),
		};
	}

	/** Resolve failure with BCHN reject code. */
	interface ResolveFailure {
		ok: false;
		code: number;
		error: string;
		debugMessage?: string;
		message?: string;
	}

	function resolveSourceOutputs(
		rawHex: string,
	): { ok: true; outputs: SourceOutput[] } | ResolveFailure {
		const rawBytes = hexToBin(rawHex);
		const decoded = decodeTransactionBch(rawBytes);
		if (typeof decoded === "string")
			return {
				ok: false,
				code: REJECT_MALFORMED,
				error: "TX decode failed",
				debugMessage: decoded,
			};

		const outpoints = decoded.inputs.map((input) =>
			makeOutpointKey(binToHex(input.outpointTransactionHash), input.outpointIndex),
		);
		// BCHN looks for a conflict on every input before it looks for a missing one
		// (AcceptToMemoryPoolWorker), and answers the two differently: a client retries a missing
		// input, which a lagging server explains, but not a double spend.
		if (outpoints.some((key) => storage.getMempoolSpender(key) !== undefined)) {
			return { ok: false, code: REJECT_DUPLICATE, error: "txn-mempool-conflict" };
		}
		const sourceOutputs: SourceOutput[] = [];
		for (const key of outpoints) {
			const utxo = storage.getUtxoByOutpoint(key);
			if (!utxo) {
				return {
					ok: false,
					code: REJECT_INVALID,
					error: "bad-txns-inputs-missingorspent",
					message: "Missing inputs",
				};
			}
			sourceOutputs.push(utxoToSourceOutput(utxo));
		}
		return { ok: true, outputs: sourceOutputs };
	}

	/** Convert a reject failure to a SubmitFailure, avoiding undefined in optional fields. */
	function toSubmitFailure(f: {
		code: number;
		error: string;
		debugMessage?: string;
		message?: string;
	}): SubmitFailure {
		// BCHN's FormatStateMessage: the reason, the debug message after a comma, then the code
		const debug = f.debugMessage ? `, ${f.debugMessage}` : "";
		const message = f.message ?? `${f.error}${debug} (code ${f.code})`;
		const result: SubmitFailure = { success: false, code: f.code, error: f.error, message };
		if (f.debugMessage != null) (result as { debugMessage: string }).debugMessage = f.debugMessage;
		return result;
	}

	/** Whether the chain's coins (spent in the mempool or not) hold an output of the transaction. */
	function hasCoinInChain(rawHex: string, txid: string): boolean {
		const decoded = decodeTransactionBch(hexToBin(rawHex));
		if (typeof decoded === "string") return false;
		return decoded.outputs.some((_, vout) => {
			const key = makeOutpointKey(txid, vout);
			if (storage.getMempoolUtxo(key)) return false;
			return storage.getUtxoByOutpoint(key) !== undefined || storage.getMempoolSpender(key) !== undefined;
		});
	}

	function submitTransaction(rawHex: string): SubmitResult {
		const result = admit(rawHex);
		if (result.success) subscriptions.notifyChanges(result.affectedScriptHashes);
		return result;
	}

	/** Mempool acceptance without notifying, for a caller that notifies once for many transactions. */
	function admit(rawHex: string): SubmitResult {
		// BCHN's sendrawtransaction answers a transaction its mempool already holds with the txid, as
		// if it had just been accepted, so a client can broadcast again without telling the two apart.
		const txid = binToHex(hashTransactionUiOrder(hexToBin(rawHex)));
		const known = storage.getMempoolTx(txid);
		if (known) {
			const { fee, size } = known;
			return { success: true, txid, fee, size, affectedScriptHashes: new Set() };
		}
		// And one whose outputs the chain still holds as coins it refuses without validating, the way
		// BCHN finds out a transaction is already confirmed: by its unspent outputs, not by an index.
		if (hasCoinInChain(rawHex, txid)) {
			return toSubmitFailure({
				code: REJECT_DUPLICATE,
				error: "txn-already-known",
				message: "transaction already in block chain",
			});
		}

		const resolved = resolveSourceOutputs(rawHex);
		if (!resolved.ok) return toSubmitFailure(resolved);
		const sourceOutputs = resolved.outputs;

		let validatedTx: ValidatedTransaction;

		if (verifier) {
			const chainState = deriveChainState();
			if (!chainState) {
				return toSubmitFailure({ code: REJECT_INVALID, error: "No chain tip set" });
			}
			const result = verifier.verify(rawHex, sourceOutputs, chainState);
			if (!result.success) return toSubmitFailure(result);
			validatedTx = result.validatedTx;
		} else {
			const rawBytes = hexToBin(rawHex);
			const decoded = decodeTransactionBch(rawBytes);
			if (typeof decoded === "string") {
				return toSubmitFailure({ code: REJECT_MALFORMED, error: "TX decode failed", debugMessage: decoded });
			}
			const txid = binToHex(hashTransactionUiOrder(rawBytes));
			const inputSum = sourceOutputs.reduce((sum, so) => sum + so.valueSatoshis, 0n);
			const outputSum = decoded.outputs.reduce((sum, o) => sum + o.valueSatoshis, 0n);
			validatedTx = {
				txid,
				rawHex,
				fee: inputSum - outputSum,
				size: rawBytes.length,
				transaction: decoded,
				sourceOutputs,
			};
		}

		const { affectedScriptHashes } = acceptToMempool(storage, validatedTx);

		return {
			success: true,
			txid: validatedTx.txid,
			fee: validatedTx.fee,
			size: validatedTx.size,
			affectedScriptHashes,
		};
	}

	function debugTransaction(rawHex: string): DebugResult | SubmitFailure {
		if (!verifier) {
			return toSubmitFailure({ code: REJECT_INVALID, error: "No verifier configured" });
		}
		const resolved = resolveSourceOutputs(rawHex);
		if (!resolved.ok) return toSubmitFailure(resolved);

		const chainState = deriveChainState();
		if (!chainState) {
			return toSubmitFailure({ code: REJECT_INVALID, error: "No chain tip set" });
		}

		return verifier.debug(rawHex, resolved.outputs, chainState);
	}

	function setChainTip(height: number, timestamp: number): void {
		const startHeight = Math.max(0, height - 10);
		for (let h = startHeight; h <= height; h++) {
			storage._test.header.add({
				hash: h.toString(16).padStart(64, "0"),
				height: h,
				timestamp,
			});
		}
	}

	function addUtxo(params: AddUtxoParams): void {
		let { scriptHash, lockingBytecode } = params;

		if (params.address) {
			const decoded = cashAddressToLockingBytecode(params.address);
			if (typeof decoded === "string") {
				throw new Error(`Invalid address: ${decoded}`);
			}
			lockingBytecode = lockingBytecode ?? decoded.bytecode;
			scriptHash = scriptHash ?? computeScriptHash(decoded.bytecode);
		}

		if (!scriptHash) {
			throw new Error("Either address or scriptHash must be provided");
		}

		storage._test.utxo.add(
			Object.assign(
				{
					txid: params.txid,
					vout: params.vout,
					satoshis: params.satoshis,
					scriptHash,
					height: params.height,
					lockingBytecode: lockingBytecode ?? new Uint8Array(0),
				},
				params.isCoinbase ? { isCoinbase: true } : {},
				params.tokenData !== undefined ? { tokenData: params.tokenData } : {},
			),
		);
	}

	function reset(): void {
		storage._test.reset();
	}

	function setNextBlockTimestamp(timestamp: number): void {
		pendingTimestamp = timestamp;
	}

	function snapshot(): StorageSnapshot {
		return storage.snapshot();
	}

	function restore(snap: StorageSnapshot): void {
		storage.restore(snap);
	}

	function mine(timestamp?: number): MineResult {
		const tip = storage.getTip();
		const newHeight = (tip?.height ?? 0) + 1;
		// Precedence: explicit arg > pending (setNextBlockTimestamp) > monotonic default. The default never goes
		// backwards from the current tip, so time-travelled chains stay consistent across auto-mines.
		const ts = timestamp ?? pendingTimestamp ?? Math.max(1700000000 + newHeight, (tip?.timestamp ?? 0) + 1);
		pendingTimestamp = undefined;

		const txids = storage.getMempoolTxids();
		const processedTxs: ProcessedBlockTx[] = [];

		for (const txid of txids) {
			const mempoolTx = storage.getMempoolTx(txid);
			if (!mempoolTx) continue;
			const rawHex = storage.getRawTx(txid);

			const inputs: ProcessedBlockInput[] = [];
			const outputs: ProcessedBlockOutput[] = [];

			for (const [, entry] of mempoolTx.entries) {
				for (const key of entry.confirmedSpends) {
					const [prevTxid, prevVout] = key.split(":") as [string, string];
					inputs.push({ prevOutpoint: { txid: prevTxid, vout: Number(prevVout) } });
				}
				for (const key of entry.unconfirmedSpends) {
					const [prevTxid, prevVout] = key.split(":") as [string, string];
					inputs.push({ prevOutpoint: { txid: prevTxid, vout: Number(prevVout) } });
				}
				for (const key of entry.outputs) {
					const utxo = storage.getMempoolUtxo(key);
					if (utxo) {
						outputs.push({ outpointKey: key, utxo: { ...utxo, height: newHeight } });
					}
				}
			}

			const ptx: ProcessedBlockTx = { txid, inputs, outputs, fee: mempoolTx.fee };
			if (rawHex) (ptx as { rawHex: string }).rawHex = rawHex;
			processedTxs.push(ptx);
		}

		storage.clearMempool();

		// A real header on the tip, so blocks have distinct hashes that link, and a client can tell a
		// reorg; upstream stored 80 zero bytes under a hash of the height, then rewrote the last 11
		// headers (setChainTip) to set the median time past, which the real timestamps now give.
		const header = createBlockHeader({
			height: newHeight,
			prevHash: tip?.hash ?? "0".repeat(64),
			txids: processedTxs.map((tx) => tx.txid),
			timestamp: ts,
			nonce: nextNonce++,
		});

		const block: ProcessedBlock = {
			height: newHeight,
			hash: header.hash,
			header,
			transactions: processedTxs,
		};
		const affectedScriptHashes = storage.applyBlock(block);

		subscriptions.notifyChanges(affectedScriptHashes);
		subscriptions.notifyNewTip(header);

		return { height: newHeight, affectedScriptHashes };
	}

	function disconnectBlocks(count: number, options?: DisconnectOptions): DisconnectResult {
		const tipHeight = storage.getTip()?.height ?? 0;
		if (!Number.isInteger(count) || count < 1) throw new Error(`Cannot disconnect ${count} blocks`);
		const heights = Array.from({ length: count }, (_, i) => tipHeight - i);
		// Headers set with setChainTip have no block behind them to undo
		const blocks = heights.map((height) => storage.getTxidsAtHeight(height));
		if (blocks.some((txids) => txids === undefined)) {
			throw new Error(`Cannot disconnect ${count} blocks from ${tipHeight}: not every one was connected here`);
		}
		const before = storage.snapshot();

		// Oldest block first, each in block order, then the mempool, parents before children
		const rawOf = (txid: string) => storage.getRawTx(txid) as string;
		const disconnected = blocks.reverse().flatMap((txids) => (txids ?? []).map(rawOf));
		const held = storage.getMempoolTxids().map(rawOf);

		const affected = new Set<ScriptHash>(storage.clearMempool());
		for (const height of heights) for (const sh of storage.undoBlock(height)) affected.add(sh);

		const returned: string[] = [];
		const dropped: string[] = [];
		const readmit = (rawHex: string) => {
			const result = admit(rawHex);
			// A replacement may be one of the disconnected transactions, which then answers as known
			if (result.success && !returned.includes(result.txid)) {
				returned.push(result.txid);
				for (const sh of result.affectedScriptHashes) affected.add(sh);
			}
			return result;
		};
		for (const rawHex of options?.replacementTxs ?? []) {
			const result = readmit(rawHex);
			if (!result.success) {
				storage.restore(before);
				throw new Error(`Replacement refused at height ${tipHeight - count}: ${result.message}`);
			}
		}
		for (const rawHex of [...disconnected, ...held]) {
			const result = readmit(rawHex);
			if (!result.success) dropped.push(binToHex(hashTransactionUiOrder(hexToBin(rawHex))));
		}

		subscriptions.notifyChanges(affected);
		return { height: tipHeight - count, returned, dropped, affectedScriptHashes: affected };
	}

	function setVerifier(v: TxVerifier): void {
		verifier = v;
	}

	return {
		// StorageReader delegation
		getHeader: storage.getHeader,
		getHeaderByHash: storage.getHeaderByHash,
		getTip: storage.getTip,
		getHistory: storage.getHistory,
		getMempoolHistory: storage.getMempoolHistory,
		getBalance: storage.getBalance,
		getUtxos: storage.getUtxos,
		getTx: storage.getTx,
		getRawTx: storage.getRawTx,
		getScriptHashStatus: storage.getScriptHashStatus,
		getMempoolTx: storage.getMempoolTx,
		getTxidsAtHeight: storage.getTxidsAtHeight,
		getUtxoByOutpoint: storage.getUtxoByOutpoint,
		getMempoolSpender: storage.getMempoolSpender,
		getMempoolTxids: storage.getMempoolTxids,
		getMempoolUtxo: storage.getMempoolUtxo,
		// Node operations
		submitTransaction,
		debugTransaction,
		mine,
		disconnectBlocks,
		setChainTip,
		setNextBlockTimestamp,
		addUtxo,
		reset,
		snapshot,
		restore,
		setVerifier,
		storage,
		subscriptions,
	};
}

/** Map a storage UtxoEntry to a validation SourceOutput. */
function utxoToSourceOutput(utxo: UtxoEntry): SourceOutput {
	const so: SourceOutput = {
		lockingBytecode: utxo.lockingBytecode,
		valueSatoshis: utxo.satoshis,
	};
	// Height 0 is a mempool coin: acceptance links the spender to it as a parent. Upstream left the
	// height out for it, which the verifier and acceptance read as a coin confirmed at height 1.
	(so as { height: number }).height = utxo.height;
	if (utxo.isCoinbase) {
		(so as { isCoinbase: boolean }).isCoinbase = true;
	}
	if (utxo.tokenData) {
		(so as { token: unknown }).token = {
			category: hexToBin(utxo.tokenData.category),
			amount: utxo.tokenData.amount,
			nft: utxo.tokenData.nft
				? {
						commitment: hexToBin(utxo.tokenData.nft.commitment),
						capability: utxo.tokenData.nft.capability,
					}
				: undefined,
		};
	}
	return so;
}
