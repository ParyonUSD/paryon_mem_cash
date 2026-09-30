// A miner picks the transactions of its block; the rest wait in the mempool. mem-cash's mine() confirmed
// the whole mempool, so a transaction could not be held back from a block to test what waits.

import { describe, expect, it } from "vitest";
import { addCoin, buildTx, createTestIndexer, OP_TRUE_SCRIPTHASH } from "../testkit.js";

function pool() {
	const node = createTestIndexer(200);
	const a = buildTx([addCoin(node, "aa")], [49_000n, 50_000n]);
	const b = buildTx([addCoin(node, "bb")], [49_000n, 50_000n]);
	const aChild = buildTx([{ txid: a.txid, vout: 0 }], [48_000n]);
	for (const tx of [a, b, aChild]) expect(node.submitTransaction(tx.hex).success).toBe(true);
	return { node, a, b, aChild };
}

describe("mine({ include })", () => {
	it("confirms only the listed transactions and leaves the rest in the mempool", () => {
		const { node, a, b, aChild } = pool();
		node.mine({ include: [a.txid] });
		expect(node.getTxidsAtHeight(201)).toEqual([a.txid]);
		expect(node.getMempoolTxids()).toEqual([b.txid, aChild.txid]);
		// The child spends a confirmed coin now
		expect(node.getMempoolTx(aChild.txid)?.parents.size).toBe(0);
		expect(node.getMempoolHistory(OP_TRUE_SCRIPTHASH).every((entry) => entry.height === 0)).toBe(true);
	});

	it("puts the listed transactions in CTOR order, by txid", () => {
		const { node, a, aChild } = pool();
		node.mine({ include: [aChild.txid, a.txid] });
		expect(node.getTxidsAtHeight(201)).toEqual([a.txid, aChild.txid].sort());
	});

	it("refuses a transaction without its unconfirmed parent, or one not in the mempool", () => {
		const { node, a, aChild } = pool();
		expect(() => node.mine({ include: [aChild.txid] })).toThrow(a.txid);
		expect(() => node.mine({ include: ["ff".repeat(32)] })).toThrow("not in the mempool");
		expect(node.getTip()?.height).toBe(200);
	});

	it("mines an empty block with an empty list, and takes a timestamp with it", () => {
		const { node } = pool();
		node.mine({ include: [], timestamp: 1_700_009_999 });
		expect(node.getTxidsAtHeight(201)).toEqual([]);
		expect(node.getTip()?.timestamp).toBe(1_700_009_999);
		expect(node.getMempoolTxids()).toHaveLength(3);
	});

	it("still confirms the whole mempool without a list", () => {
		const { node, a, b, aChild } = pool();
		node.mine(1_700_009_999);
		expect(node.getTxidsAtHeight(201)).toEqual([a.txid, b.txid, aChild.txid].sort());
		expect(node.getMempoolTxids()).toEqual([]);
		expect(node.getRawTx(aChild.txid)).toBe(aChild.hex);
	});
});
