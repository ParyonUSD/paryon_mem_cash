// An OP_RETURN output is no coin: BCHN never adds it to the UTXO set, and Fulcrum indexes neither a coin
// nor history for it (Mempool.cpp, BlockProc.cpp: "skip OP_RETURN"). mem-cash indexed it as a spendable
// coin of the OP_RETURN script's scripthash, in the mempool and in blocks, so spending it was refused as
// bad-txns-input-scriptpubkey-unspendable where BCHN answers Missing inputs.

import { describe, expect, it } from "vitest";
import { addCoin, blockOf, broadcast, buildTx, createTestIndexer, rejected } from "../testkit.js";
import { computeScriptHash } from "../types/index.js";

const OP_RETURN_SCRIPTHASH = computeScriptHash(Uint8Array.of(0x6a));

async function indexed(node: ReturnType<typeof createTestIndexer>) {
	return {
		unspent: await node.request("blockchain.scripthash.listunspent", [OP_RETURN_SCRIPTHASH]),
		history: await node.request("blockchain.scripthash.get_history", [OP_RETURN_SCRIPTHASH]),
	};
}

describe("OP_RETURN outputs", () => {
	// buildTx pads a one-output transaction with an empty OP_RETURN output, output 1
	it("are not indexed from the mempool, nor once mined", async () => {
		const node = createTestIndexer(200);
		const tx = buildTx([addCoin(node, "aa")], [99_000n]);
		expect(node.submitTransaction(tx.hex).success).toBe(true);
		expect(await indexed(node)).toEqual({ unspent: [], history: [] });
		node.mine();
		expect(await indexed(node)).toEqual({ unspent: [], history: [] });
	});

	it("are not indexed from a block that reaches the node from elsewhere", async () => {
		const node = createTestIndexer(200);
		const tx = buildTx([addCoin(node, "aa")], [99_000n]);
		node.storage.applyBlock(blockOf(node, [tx]));
		expect(await indexed(node)).toEqual({ unspent: [], history: [] });
	});

	it("cannot be spent: Missing inputs, as the coin never existed", async () => {
		const node = createTestIndexer(200);
		const tx = buildTx([addCoin(node, "aa")], [99_000n]);
		node.submitTransaction(tx.hex);
		const spend = buildTx([{ txid: tx.txid, vout: 1 }, addCoin(node, "bb")], [99_000n]);
		expect(await broadcast(node, spend.hex)).toBe(rejected("Missing inputs"));
	});
});
