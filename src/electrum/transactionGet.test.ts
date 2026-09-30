// blockchain.transaction.get answers from the node's chain and mempool, as Fulcrum asks bitcoind's
// getrawtransaction: a transaction that left the mempool without confirming is unknown again.

import { describe, expect, it } from "vitest";
import { addCoin, buildTx, createTestIndexer } from "../testkit.js";

const NO_SUCH_TRANSACTION = "No such mempool or blockchain transaction. Use gettransaction for wallet transactions.";

function withChain() {
	const node = createTestIndexer();
	const parent = buildTx([addCoin(node, "aa")], [49_000n, 50_000n]);
	const child = buildTx([{ txid: parent.txid, vout: 0 }], [48_000n]);
	for (const tx of [parent, child]) expect(node.submitTransaction(tx.hex).success).toBe(true);
	return { node, parent, child };
}

describe("blockchain.transaction.get", () => {
	it("forgets a transaction removed from the mempool, and its descendants", async () => {
		const { node, parent, child } = withChain();
		expect(await node.request("blockchain.transaction.get", [child.txid])).toBe(child.hex);

		node.storage.removeMempoolTx(parent.txid);
		for (const tx of [parent, child]) {
			await expect(node.request("blockchain.transaction.get", [tx.txid])).rejects.toThrow(NO_SUCH_TRANSACTION);
			expect(node.getRawTx(tx.txid)).toBeUndefined();
		}
	});

	it("forgets the transactions of a cleared mempool", async () => {
		const { node, parent } = withChain();
		node.storage.clearMempool();
		await expect(node.request("blockchain.transaction.get", [parent.txid])).rejects.toThrow(NO_SUCH_TRANSACTION);
	});

	it("keeps answering for a transaction a block confirmed", async () => {
		const { node, parent, child } = withChain();
		node.mine();
		expect(await node.request("blockchain.transaction.get", [parent.txid])).toBe(parent.hex);
		expect(await node.request("blockchain.transaction.get", [child.txid])).toBe(child.hex);
	});
});
