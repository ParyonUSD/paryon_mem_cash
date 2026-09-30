import { binToHex } from "@bitauth/libauth";
import type {
	MempoolTx,
	MempoolTxScriptHashEntry,
	OutpointKey,
	ScriptHash,
	Storage,
	Txid,
	UtxoEntry,
} from "../types/index.js";
import { computeScriptHash, makeOutpointKey } from "../types/index.js";
import { OP_RETURN, type ValidatedTransaction } from "../validation/index.js";

/** Result of accepting a validated transaction into the mempool. */
export interface AcceptResult {
	readonly affectedScriptHashes: ReadonlySet<ScriptHash>;
}

/**
 * Accept a validated transaction into the mempool.
 *
 * This is the write side of the evaluate+accept two-phase pattern.
 * The evaluator validates and returns a ValidatedTransaction (read-only);
 * this function computes scripthashes from the decoded transaction and
 * performs the storage mutations.
 */
export function acceptToMempool(storage: Storage, validatedTx: ValidatedTransaction): AcceptResult {
	const { txid, rawHex, fee, size, transaction, sourceOutputs } = validatedTx;

	// Compute scripthashes for each output. An OP_RETURN output gets none: it is no coin, and Fulcrum
	// indexes neither a coin nor history for it; upstream indexed it as a spendable coin.
	const outputScriptHashes: (ScriptHash | undefined)[] = [];
	for (const output of transaction.outputs) {
		const isCoin = output.lockingBytecode[0] !== OP_RETURN;
		outputScriptHashes.push(isCoin ? computeScriptHash(output.lockingBytecode) : undefined);
	}

	// Create mempool UTXOs for each output
	for (let vout = 0; vout < transaction.outputs.length; vout++) {
		const output = transaction.outputs[vout];
		const scriptHash = outputScriptHashes[vout];
		if (!output || !scriptHash) continue;
		const key = makeOutpointKey(txid, vout);
		const base = {
			outpoint: { txid, vout },
			satoshis: output.valueSatoshis,
			scriptHash,
			height: 0 as const,
			lockingBytecode: output.lockingBytecode,
		};
		const utxoEntry: UtxoEntry = output.token
			? {
					...base,
					tokenData: {
						category: binToHex(output.token.category),
						amount: output.token.amount,
						...(output.token.nft
							? {
									nft: {
										capability: output.token.nft.capability,
										commitment: binToHex(output.token.nft.commitment),
									},
								}
							: {}),
					},
				}
			: base;
		storage.addMempoolUtxo(key, utxoEntry);
	}

	// Build MempoolTx entries map
	const entriesMap = new Map<ScriptHash, MempoolTxScriptHashEntry>();
	const parents = new Set<Txid>();

	// Process inputs — derive scripthash and outpointKey from decoded tx + sourceOutputs
	for (let i = 0; i < transaction.inputs.length; i++) {
		const input = transaction.inputs[i];
		const sourceOutput = sourceOutputs[i];
		if (!input || !sourceOutput) continue;

		const parentTxid = binToHex(input.outpointTransactionHash);
		const outpointKey = makeOutpointKey(parentTxid, input.outpointIndex);
		const inputScriptHash = computeScriptHash(sourceOutput.lockingBytecode);

		const entry = getOrCreateEntry(entriesMap, inputScriptHash);
		if ((sourceOutput.height ?? 1) > 0) {
			(entry.confirmedSpends as OutpointKey[]).push(outpointKey);
		} else {
			(entry.unconfirmedSpends as OutpointKey[]).push(outpointKey);
			parents.add(parentTxid);
		}
	}

	// Process outputs
	for (let vout = 0; vout < outputScriptHashes.length; vout++) {
		const scriptHash = outputScriptHashes[vout];
		if (!scriptHash) continue;
		const key = makeOutpointKey(txid, vout);
		const entry = getOrCreateEntry(entriesMap, scriptHash);
		(entry.outputs as OutpointKey[]).push(key);
	}

	const mempoolTx: MempoolTx = {
		txid,
		fee,
		size,
		entries: entriesMap,
		parents,
		children: new Set(),
	};

	storage.storeRawTx(txid, rawHex);
	const affectedScriptHashes = storage.addMempoolTx(mempoolTx);

	return { affectedScriptHashes };
}

/** Get or create a MempoolTxScriptHashEntry in the map. */
function getOrCreateEntry(
	map: Map<ScriptHash, MempoolTxScriptHashEntry>,
	scriptHash: ScriptHash,
): MempoolTxScriptHashEntry {
	let entry = map.get(scriptHash);
	if (!entry) {
		entry = { confirmedSpends: [], unconfirmedSpends: [], outputs: [] };
		map.set(scriptHash, entry);
	}
	return entry;
}
