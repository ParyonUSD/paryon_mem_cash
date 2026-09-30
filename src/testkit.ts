// Transactions for the fork's tests: OP_TRUE coins, spent and chained without signatures. Left out of
// the build (tsconfig.json); only tests import it.

import {
	binToHex,
	decodeTransactionBch,
	encodeTransactionBch,
	hashTransactionUiOrder,
	hexToBin,
	type Output,
	ripemd160,
	sha256,
} from "@bitauth/libauth";
import { createIndexer, type Indexer } from "./electrum/index.js";
import { createBlockHeader } from "./core/index.js";
import { computeScriptHash, makeOutpointKey, type ProcessedBlock } from "./types/index.js";
import { createTxVerifier } from "./validation/index.js";

const hash160 = (bytes: Uint8Array) => ripemd160.hash(sha256.hash(bytes));

/** OP_1: anyone can spend it, so a test needs no keys. */
export const OP_TRUE = Uint8Array.of(0x51);
export const OP_TRUE_SCRIPTHASH = computeScriptHash(OP_TRUE);

/** P2SH20 of OP_TRUE: standard, and spent by pushing the redeem script (`P2SH_OP_TRUE_UNLOCKING`). */
export const P2SH_OP_TRUE = Uint8Array.of(0xa9, 0x14, ...hash160(OP_TRUE), 0x87);
export const P2SH_OP_TRUE_UNLOCKING = Uint8Array.of(0x01, 0x51);
export const P2SH_OP_TRUE_SCRIPTHASH = computeScriptHash(P2SH_OP_TRUE);

export const SEQUENCE_FINAL = 0xffffffff;

export interface TestInput {
	readonly txid: string;
	readonly vout: number;
	readonly sequence?: number;
	/** Empty by default, which spends OP_TRUE. */
	readonly unlocking?: Uint8Array;
}

/** An output: a value paid to OP_TRUE, or one in full. */
export type TestOutput = bigint | Output;

export interface TestTx {
	readonly txid: string;
	readonly hex: string;
}

/**
 * A transaction spending `inputs` into `outputs`, each a value paid to OP_TRUE or an output in full.
 * One too small for the 65-byte minimum gets an empty OP_RETURN output after them.
 */
export function buildTx(
	inputs: readonly TestInput[],
	outputs: readonly TestOutput[],
	{ locktime = 0, version = 2 }: { locktime?: number; version?: number } = {},
): TestTx {
	const encode = (padded: boolean) => encodeTransactionBch({
		version,
		locktime,
		inputs: inputs.map((input) => ({
			outpointTransactionHash: hexToBin(input.txid),
			outpointIndex: input.vout,
			unlockingBytecode: input.unlocking ?? new Uint8Array(0),
			sequenceNumber: input.sequence ?? SEQUENCE_FINAL,
		})),
		outputs: [
			...outputs.map((output) =>
				typeof output === "bigint" ? { lockingBytecode: OP_TRUE, valueSatoshis: output } : output),
			...(padded ? [{ lockingBytecode: Uint8Array.of(0x6a), valueSatoshis: 0n }] : []),
		],
	});
	const unpadded = encode(false);
	const encoded = unpadded.length < 65 ? encode(true) : unpadded;
	return { txid: binToHex(hashTransactionUiOrder(encoded)), hex: binToHex(encoded) };
}

/**
 * A node with a verifier and a tip at `height`. Standardness is off by default, as OP_TRUE is
 * non-standard; a standard node's tests spend P2SH_OP_TRUE coins (`addP2shCoin`).
 */
export function createTestIndexer(height = 200, { standard = false }: { standard?: boolean } = {}): Indexer {
	const node = createIndexer({ verifier: createTxVerifier({ standard }) });
	node.setChainTip(height, 1_700_000_000);
	return node;
}

/** A confirmed OP_TRUE coin: output 0 of a transaction the node never saw, its txid `seed` repeated. */
export function addCoin(node: Indexer, seed: string, satoshis = 100_000n, height = 100): TestInput {
	const txid = seed.repeat(32);
	node.addUtxo({ txid, vout: 0, satoshis, height, lockingBytecode: OP_TRUE, scriptHash: OP_TRUE_SCRIPTHASH });
	return { txid, vout: 0 };
}

/** A confirmed P2SH_OP_TRUE coin, with the unlocking script that spends it. */
export function addP2shCoin(node: Indexer, seed: string, satoshis = 100_000n, height = 100): TestInput {
	const txid = seed.repeat(32);
	const scriptHash = P2SH_OP_TRUE_SCRIPTHASH;
	node.addUtxo({ txid, vout: 0, satoshis, height, lockingBytecode: P2SH_OP_TRUE, scriptHash });
	return { txid, vout: 0, unlocking: P2SH_OP_TRUE_UNLOCKING };
}

/** An output paying P2SH_OP_TRUE, standard where OP_TRUE is not. */
export const toP2sh = (valueSatoshis: bigint): Output => ({ lockingBytecode: P2SH_OP_TRUE, valueSatoshis });

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

/**
 * The next block on the node's tip, holding `txs`, in the shape storage.applyBlock takes: a block that
 * reaches the node from elsewhere, as the simulator connects them.
 */
export function blockOf(node: Indexer, txs: readonly TestTx[]): ProcessedBlock {
	const tip = node.getTip();
	const height = (tip?.height ?? 0) + 1;
	const header = createBlockHeader({
		height,
		prevHash: tip?.hash ?? "00".repeat(32),
		txids: txs.map((tx) => tx.txid),
		timestamp: (tip?.timestamp ?? 0) + 600,
		nonce: 1_000_000 + height,
	});
	return {
		height,
		hash: header.hash,
		header,
		transactions: txs.map(({ txid, hex }) => {
			const decoded = decodeTransactionBch(hexToBin(hex));
			if (typeof decoded === "string") throw new Error(decoded);
			return {
				txid,
				rawHex: hex,
				inputs: decoded.inputs.map((input) => ({
					prevOutpoint: { txid: binToHex(input.outpointTransactionHash), vout: input.outpointIndex },
				})),
				outputs: decoded.outputs.map((output, vout) => ({
					outpointKey: makeOutpointKey(txid, vout),
					utxo: {
						outpoint: { txid, vout },
						satoshis: output.valueSatoshis,
						scriptHash: computeScriptHash(output.lockingBytecode),
						height,
						lockingBytecode: output.lockingBytecode,
					},
				})),
			};
		}),
	};
}
