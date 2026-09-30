// Since November 2018 a BCH block orders its transactions by txid (CTOR), not parents first, so a child
// can come before the parent whose output it spends. BCHN connects such a block by adding every output
// before spending any input. mem-cash spent and created coins transaction by transaction, so the child's
// input found no coin yet and the parent then added it: a coin spent in the block stayed unspent.

import { describe, expect, it } from "vitest";
import { addCoin, blockOf, buildTx, createTestIndexer, OP_TRUE_SCRIPTHASH } from "../testkit.js";

function childFirst() {
	const node = createTestIndexer();
	const coin = addCoin(node, "aa");
	const parent = buildTx([coin], [49_000n, 50_000n]);
	const child = buildTx([{ txid: parent.txid, vout: 0 }], [48_000n]);
	node.storage.applyBlock(blockOf(node, [child, parent]));
	return { node, coin, parent, child };
}

describe("a block with a child before its parent", () => {
	it("spends the coin the parent creates and the child spends", () => {
		const { node, parent, child } = childFirst();
		expect(node.getUtxoByOutpoint(`${parent.txid}:0`)).toBeUndefined();
		expect(node.getUtxos(OP_TRUE_SCRIPTHASH).map((utxo) => `${utxo.outpoint.txid}:${utxo.outpoint.vout}`).sort()).toEqual(
			[`${parent.txid}:1`, `${child.txid}:0`].sort(),
		);
		// In block order, as Fulcrum's txNum order
		expect(node.getHistory(OP_TRUE_SCRIPTHASH).map((entry) => entry.txHash).slice(-2)).toEqual([child.txid, parent.txid]);
	});

	it("undoes to the coin the parent spent, and nothing the block created", () => {
		const { node, coin } = childFirst();
		node.storage.undoBlock(201);
		expect(node.getUtxos(OP_TRUE_SCRIPTHASH).map((utxo) => utxo.outpoint.txid)).toEqual([coin.txid]);
	});
});
