// Transactions for the fork's tests: OP_TRUE coins, spent and chained without signatures. Left out of
// the build (tsconfig.json); only tests import it.

import { binToHex, encodeTransactionBch, hashTransactionUiOrder, hexToBin } from "@bitauth/libauth";
import { createIndexer, type Indexer } from "./electrum/index.js";
import { computeScriptHash } from "./types/index.js";
import { createTxVerifier } from "./validation/index.js";

/** OP_1: anyone can spend it, so a test needs no keys. */
export const OP_TRUE = Uint8Array.of(0x51);
export const OP_TRUE_SCRIPTHASH = computeScriptHash(OP_TRUE);

export const SEQUENCE_FINAL = 0xffffffff;

export interface TestInput {
	readonly txid: string;
	readonly vout: number;
	readonly sequence?: number;
}

export interface TestTx {
	readonly txid: string;
	readonly hex: string;
}

/**
 * A transaction spending `inputs` into OP_TRUE outputs of the given values. One too small for the
 * 65-byte minimum gets an empty OP_RETURN output after them.
 */
export function buildTx(
	inputs: readonly TestInput[],
	outputs: readonly bigint[],
	{ locktime = 0, version = 2 }: { locktime?: number; version?: number } = {},
): TestTx {
	const encode = (padded: boolean) => encodeTransactionBch({
		version,
		locktime,
		inputs: inputs.map((input) => ({
			outpointTransactionHash: hexToBin(input.txid),
			outpointIndex: input.vout,
			unlockingBytecode: new Uint8Array(0),
			sequenceNumber: input.sequence ?? SEQUENCE_FINAL,
		})),
		outputs: [
			...outputs.map((valueSatoshis) => ({ lockingBytecode: OP_TRUE, valueSatoshis })),
			...(padded ? [{ lockingBytecode: Uint8Array.of(0x6a), valueSatoshis: 0n }] : []),
		],
	});
	const unpadded = encode(false);
	const encoded = unpadded.length < 65 ? encode(true) : unpadded;
	return { txid: binToHex(hashTransactionUiOrder(encoded)), hex: binToHex(encoded) };
}

/** A node with a verifier (OP_TRUE is non-standard, so standardness is off) and a tip at `height`. */
export function createTestIndexer(height = 200): Indexer {
	const node = createIndexer({ verifier: createTxVerifier({ standard: false }) });
	node.setChainTip(height, 1_700_000_000);
	return node;
}

/** A confirmed OP_TRUE coin: output 0 of a transaction the node never saw, its txid `seed` repeated. */
export function addCoin(node: Indexer, seed: string, satoshis = 100_000n, height = 100): TestInput {
	const txid = seed.repeat(32);
	node.addUtxo({ txid, vout: 0, satoshis, height, lockingBytecode: OP_TRUE, scriptHash: OP_TRUE_SCRIPTHASH });
	return { txid, vout: 0 };
}

/** What a broadcast answers: the txid, or the message it was refused with. */
export async function broadcast(node: Indexer, hex: string): Promise<string> {
	try {
		return await node.request("blockchain.transaction.broadcast", [hex]);
	} catch (error) {
		return (error as Error).message;
	}
}

/** Fulcrum's wrapping of the node's refusal. */
export const rejected = (reason: string) => `the transaction was rejected by network rules.\n\n${reason}\n`;
