// Confirmed history in Fulcrum's order: by height, then by position in the block (txNum), which is also
// the order the status hash concatenates. A BCH block orders its transactions by txid (CTOR, since
// November 2018), so within one block that is txid order, a child ahead of a parent whose txid sorts
// higher. mine() built blocks in mempool order, parents first, which no BCH block since has.

import { binToHex, sha256, utf8ToBin } from "@bitauth/libauth";
import { describe, expect, it } from "vitest";
import { addCoin, buildTx, createTestIndexer, OP_TRUE_SCRIPTHASH } from "../testkit.js";

describe("history within a block", () => {
	it("lists a mined block's transactions by txid, a child ahead of its parent, and hashes the status so", async () => {
		for (let value = 48_000n; value > 47_000n; value -= 1n) {
			const node = createTestIndexer(200);
			const parent = buildTx([addCoin(node, "aa")], [49_000n, 50_000n]);
			const child = buildTx([{ txid: parent.txid, vout: 0 }], [value]);
			// A child whose txid sorts first shows the difference
			if (child.txid > parent.txid) continue;
			for (const tx of [parent, child]) expect(node.submitTransaction(tx.hex).success).toBe(true);
			node.mine();

			expect(node.getTxidsAtHeight(201)).toEqual([child.txid, parent.txid]);
			const history = await node.request("blockchain.scripthash.get_history", [OP_TRUE_SCRIPTHASH]);
			expect(history).toEqual([
				{ tx_hash: child.txid, height: 201 },
				{ tx_hash: parent.txid, height: 201 },
			]);
			const status = binToHex(sha256.hash(utf8ToBin(`${child.txid}:201:${parent.txid}:201:`)));
			expect(await node.request("blockchain.scripthash.get_status", [OP_TRUE_SCRIPTHASH])).toBe(status);
			// The block connected: the coin the child spent is gone, the others remain
			expect(node.getUtxos(OP_TRUE_SCRIPTHASH).map((utxo) => `${utxo.outpoint.txid}:${utxo.outpoint.vout}`).sort()).toEqual(
				[`${child.txid}:0`, `${parent.txid}:1`].sort(),
			);
			return;
		}
		throw new Error("no child with a txid below its parent's");
	});
});
