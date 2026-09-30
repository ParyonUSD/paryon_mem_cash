import { binToHex, sha256 } from "@bitauth/libauth";

/** 64-char lowercase hex scripthash: the Electrum protocol's byte-reversed SHA256 of an output script. */
export type ScriptHash = string;

/** 64-char lowercase hex transaction id. */
export type Txid = string;

/** 64-char lowercase hex block hash. */
export type BlockHash = string;

/** Block height (non-negative integer). */
export type BlockHeight = number;

/** Canonical outpoint key: `"${txid}:${vout}"`. */
export type OutpointKey = `${string}:${number}`;

/** Build a canonical outpoint key from txid and output index. */
export function makeOutpointKey(txid: Txid, vout: number): OutpointKey {
	return `${txid}:${vout}`;
}

/** Parse a canonical outpoint key back into txid and vout. */
export function parseOutpointKey(key: OutpointKey): { txid: Txid; vout: number } {
	const lastColon = key.lastIndexOf(":");
	const voutStr = key.slice(lastColon + 1);
	const vout = Number(voutStr);
	if (!Number.isInteger(vout) || vout < 0 || vout > 0xffffffff) {
		throw new Error(`Invalid vout in outpoint key: ${voutStr}`);
	}
	return {
		txid: key.slice(0, lastColon),
		vout,
	};
}

/**
 * The Electrum protocol's scripthash of a locking bytecode: its sha256 with the bytes reversed, as hex.
 * Clients compute it this way, so the node files everything under it; upstream used the hash unreversed.
 */
export function computeScriptHash(lockingBytecode: Uint8Array): ScriptHash {
	return binToHex(sha256.hash(lockingBytecode).reverse());
}
