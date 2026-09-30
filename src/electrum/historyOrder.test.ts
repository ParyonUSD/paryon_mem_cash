// Confirmed history in Fulcrum's order: by height, then by position in the block (txNum), which is also
// the order the status hash concatenates. mem-cash sorted a block's transactions by txid, so a parent
// and its child in one block could come out child first, and the status hash differed from Fulcrum's.

import { binToHex, sha256, utf8ToBin } from "@bitauth/libauth";
import { describe, expect, it } from "vitest";
import { addCoin, buildTx, createTestIndexer, OP_TRUE_SCRIPTHASH } from "../testkit.js";

describe("history within a block", () => {
	it("lists a block's transactions in block order, and hashes the status in that order", async () => {
		for (let value = 48_000n; value > 47_000n; value -= 1n) {
			const node = createTestIndexer(200);
			const parent = buildTx([addCoin(node, "aa")], [49_000n, 50_000n]);
			const child = buildTx([{ txid: parent.txid, vout: 0 }], [value]);
			// A child whose txid sorts first shows the difference
			if (child.txid > parent.txid) continue;
			for (const tx of [parent, child]) expect(node.submitTransaction(tx.hex).success).toBe(true);
			node.mine();

			const history = await node.request("blockchain.scripthash.get_history", [OP_TRUE_SCRIPTHASH]);
			expect(history).toEqual([
				{ tx_hash: parent.txid, height: 201 },
				{ tx_hash: child.txid, height: 201 },
			]);
			const status = binToHex(sha256.hash(utf8ToBin(`${parent.txid}:201:${child.txid}:201:`)));
			expect(await node.request("blockchain.scripthash.get_status", [OP_TRUE_SCRIPTHASH])).toBe(status);
			return;
		}
		throw new Error("no child with a txid below its parent's");
	});
});
