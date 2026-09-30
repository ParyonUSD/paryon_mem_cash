import { binToHex, hexToBin, sha256 } from "@bitauth/libauth";
import { computeMerkleBranchAndRoot, type BlockHeader } from "../types/index.js";

// Version bits and regtest difficulty: nothing checks proof of work here, the fields only have to be
// well formed.
const VERSION = 0x20000000;
const BITS = 0x207fffff;

export interface BlockHeaderParams {
	readonly height: number;
	/** The previous block's hash, display order. */
	readonly prevHash: string;
	/** The block's txids in order, display order. */
	readonly txids: readonly string[];
	readonly timestamp: number;
	/** What tells apart two blocks on the same parent with the same transactions and time. */
	readonly nonce: number;
}

const doubleSha256 = (bytes: Uint8Array) => sha256.hash(sha256.hash(bytes));
const reversed = (bytes: Uint8Array) => bytes.slice().reverse();

function uint32LE(value: number): Uint8Array {
	const bytes = new Uint8Array(4);
	new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
	return bytes;
}

/**
 * A real 80-byte block header: version, the previous block's hash, the merkle root of the block's
 * txids, time, bits and nonce, hashed to the block hash with double sha256. Hashes are shown
 * byte-reversed, as nodes and Electrum servers show them.
 */
export function createBlockHeader({ height, prevHash, txids, timestamp, nonce }: BlockHeaderParams): BlockHeader {
	// The merkle root of an empty block, which has no coinbase here, is left as zeros
	const root =
		txids.length === 0
			? new Uint8Array(32)
			: computeMerkleBranchAndRoot(
					txids.map((txid) => reversed(hexToBin(txid))),
					0,
				).root;
	const bytes = new Uint8Array([
		...uint32LE(VERSION),
		...reversed(hexToBin(prevHash)),
		...root,
		...uint32LE(timestamp),
		...uint32LE(BITS),
		...uint32LE(nonce),
	]);
	return {
		hash: binToHex(reversed(doubleSha256(bytes))),
		height,
		version: VERSION,
		prevHash,
		merkleRoot: binToHex(reversed(root)),
		timestamp,
		bits: BITS,
		nonce,
		hex: binToHex(bytes),
	};
}
