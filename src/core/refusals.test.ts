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
