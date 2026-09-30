// What a broadcast answers, in the words of BCHN's sendrawtransaction (node/transaction.cpp,
// validation.cpp AcceptToMemoryPoolWorker) as Fulcrum passes them on. Clients classify these texts:
// the transaction service's ElectrumWrapper tells a double spend (txn-mempool-conflict) from a server
// that has not seen a parent yet (Missing inputs), and retries only the second.

import { describe, expect, it } from "vitest";
import { addCoin, broadcast, buildTx, createTestIndexer, rejected } from "../testkit.js";

describe("refusals", () => {
	it("answers txn-mempool-conflict for an input a mempool transaction already spends", async () => {
		const node = createTestIndexer();
		const coin = addCoin(node, "aa");
		expect(node.submitTransaction(buildTx([coin], [99_000n]).hex).success).toBe(true);

		const doubleSpend = buildTx([coin], [98_000n]);
		expect(await broadcast(node, doubleSpend.hex)).toBe(rejected("txn-mempool-conflict (code 18)"));
		expect(node.submitTransaction(doubleSpend.hex)).toMatchObject({
			success: false,
			code: 18,
			error: "txn-mempool-conflict",
		});
	});

	it("answers Missing inputs, without a code, for an input the node does not know", async () => {
		const node = createTestIndexer();
		const orphan = buildTx([{ txid: "bb".repeat(32), vout: 0 }], [1_000n]);
		expect(await broadcast(node, orphan.hex)).toBe(rejected("Missing inputs"));
	});

	it("answers Missing inputs for an input a block already spent", async () => {
		const node = createTestIndexer();
		const coin = addCoin(node, "aa");
		node.submitTransaction(buildTx([coin], [99_000n]).hex);
		node.mine();
		expect(await broadcast(node, buildTx([coin], [98_000n]).hex)).toBe(rejected("Missing inputs"));
	});

	it("reports a conflict before a missing input, as BCHN checks every input for conflicts first", async () => {
		const node = createTestIndexer();
		const coin = addCoin(node, "aa");
		node.submitTransaction(buildTx([coin], [99_000n]).hex);
		const both = buildTx([{ txid: "bb".repeat(32), vout: 0 }, coin], [98_000n]);
		expect(await broadcast(node, both.hex)).toBe(rejected("txn-mempool-conflict (code 18)"));
	});
});

describe("a transaction the node already has", () => {
	it("answers a rebroadcast of a mempool transaction with its txid, as BCHN's sendrawtransaction does", async () => {
		const node = createTestIndexer();
		const tx = buildTx([addCoin(node, "aa")], [99_000n]);
		expect(await broadcast(node, tx.hex)).toBe(tx.txid);
		expect(await broadcast(node, tx.hex)).toBe(tx.txid);
		expect(node.submitTransaction(tx.hex)).toMatchObject({ success: true, txid: tx.txid, fee: 1_000n });
		expect(node.getMempoolTxids()).toEqual([tx.txid]);
	});
});

describe("a transaction already confirmed", () => {
	it("answers 'transaction already in block chain' while one of its outputs is unspent", async () => {
		const node = createTestIndexer();
		const tx = buildTx([addCoin(node, "aa")], [49_000n, 50_000n]);
		node.submitTransaction(tx.hex);
		node.mine();
		expect(await broadcast(node, tx.hex)).toBe(rejected("transaction already in block chain"));

		// An output spent only in the mempool is still unspent in the chain's coins
		node.submitTransaction(buildTx([{ txid: tx.txid, vout: 0 }], [48_000n]).hex);
		expect(await broadcast(node, tx.hex)).toBe(rejected("transaction already in block chain"));
		node.submitTransaction(buildTx([{ txid: tx.txid, vout: 1 }], [49_000n]).hex);
		expect(await broadcast(node, tx.hex)).toBe(rejected("transaction already in block chain"));
	});

	it("answers Missing inputs once a block spent all its outputs, as BCHN no longer knows it", async () => {
		const node = createTestIndexer();
		// Two outputs, so the transaction needs no OP_RETURN padding
		const tx = buildTx([addCoin(node, "aa")], [49_000n, 50_000n]);
		node.submitTransaction(tx.hex);
		const spendBoth = buildTx([{ txid: tx.txid, vout: 0 }, { txid: tx.txid, vout: 1 }], [98_000n]);
		expect(node.submitTransaction(spendBoth.hex).success).toBe(true);
		node.mine();
		expect(await broadcast(node, tx.hex)).toBe(rejected("Missing inputs"));
	});
});

describe("a non-final transaction", () => {
	it("is refused in BCHN's words: reason, debug message and the mempool's code 64", async () => {
		const node = createTestIndexer(200);
		// Final only from the block after next: a locktime must be below the height of the next block
		const tx = buildTx([{ ...addCoin(node, "aa"), sequence: 0 }], [99_000n], { locktime: 201 });
		expect(await broadcast(node, tx.hex)).toBe(rejected("bad-txns-nonfinal, non-final transaction (code 64)"));
		expect(node.submitTransaction(tx.hex)).toMatchObject({ code: 64, error: "bad-txns-nonfinal" });
	});

	it("keeps a debug message in every refusal, as BCHN's FormatStateMessage does", async () => {
		const node = createTestIndexer();
		const tx = buildTx([addCoin(node, "aa", 1_000n)], [2_000n]);
		expect(await broadcast(node, tx.hex)).toMatch(/\n\nbad-txns-in-belowout, .+ \(code 16\)\n$/);
	});
});
