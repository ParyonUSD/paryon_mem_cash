// Undoing a block puts back the coins it spent and takes away the ones it created. A coin the block both
// created and spent (a parent and child confirmed together) existed in neither state, so it must not
// come back; and undoing touches the chain, not the mempool, which the node rebuilds from the undone
// transactions.

import { describe, expect, it } from "vitest";
import { addCoin, blockOf, buildTx, createTestIndexer, OP_TRUE_SCRIPTHASH } from "../testkit.js";

function chainOfTwo() {
	const node = createTestIndexer();
	const coin = addCoin(node, "aa");
	const parent = buildTx([coin], [49_000n, 50_000n]);
	const child = buildTx([{ txid: parent.txid, vout: 0 }], [48_000n]);
	node.storage.applyBlock(blockOf(node, [parent, child]));
	return { node, coin, parent, child };
}

describe("undoBlock", () => {
	it("restores no coin the block created and spent itself", () => {
		const { node, coin, parent } = chainOfTwo();
		node.storage.undoBlock(201);
		expect(node.getUtxoByOutpoint(`${parent.txid}:0`)).toBeUndefined();
		expect(node.getUtxos(OP_TRUE_SCRIPTHASH).map((utxo) => utxo.outpoint.txid)).toEqual([coin.txid]);
	});

	it("leaves the mempool as it is", () => {
		const { node } = chainOfTwo();
		const pending = buildTx([addCoin(node, "bb")], [99_000n]);
		expect(node.submitTransaction(pending.hex).success).toBe(true);
		node.storage.undoBlock(201);
		expect(node.getMempoolTxids()).toEqual([pending.txid]);
	});

	it("removes only the block's own history and transaction records", () => {
		const { node, coin, parent, child } = chainOfTwo();
		// A record at the same height that is not the block's, as a consumer seeds coins
		node.storage._test.tx.add({ txid: "cc".repeat(32), height: 201, rawHex: "00" });
		const seeded = { txHash: "cc".repeat(32), height: 201 };
		node.storage._test.history.add({ scriptHash: OP_TRUE_SCRIPTHASH, entries: [seeded] });
		node.storage.undoBlock(201);
		expect(node.getTx(parent.txid)).toBeUndefined();
		expect(node.getTx(child.txid)).toBeUndefined();
		expect(node.getTx("cc".repeat(32))).toBeDefined();
		expect(node.getHistory(OP_TRUE_SCRIPTHASH).map((entry) => entry.txHash)).toEqual(["cc".repeat(32)]);
		expect(node.getUtxoByOutpoint(`${coin.txid}:0`)).toBeDefined();
	});
});
