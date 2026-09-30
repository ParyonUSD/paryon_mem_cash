// get_balance as Fulcrum's Storage::getBalance: confirmed is every confirmed coin (spent in the mempool
// or not), unconfirmed the mempool outputs still unspent less the confirmed coins the mempool spends.
// mem-cash also counted mempool outputs a mempool child had spent, so a chain of mempool transactions
// added up its intermediate outputs.

import { describe, expect, it } from "vitest";
import { addCoin, buildTx, createTestIndexer, OP_TRUE_SCRIPTHASH } from "../testkit.js";

describe("get_balance", () => {
	it("leaves out mempool outputs a mempool child spends", async () => {
		const node = createTestIndexer(200);
		const parent = buildTx([addCoin(node, "aa", 100_000n)], [49_000n, 50_000n]);
		const child = buildTx([{ txid: parent.txid, vout: 0 }], [48_000n]);
		for (const tx of [parent, child]) expect(node.submitTransaction(tx.hex).success).toBe(true);

		// Unspent in the mempool: parent:1 (50,000) and child:0 (48,000); spent from the chain: 100,000
		expect(await node.request("blockchain.scripthash.get_balance", [OP_TRUE_SCRIPTHASH])).toEqual({
			confirmed: 100_000,
			unconfirmed: -2_000,
		});
	});
});
