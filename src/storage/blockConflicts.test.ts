// A block that spends a coin some mempool transaction also spends has settled the double spend: BCHN
// removes the loser and everything descending from it (removeForBlock, removeConflicts). mem-cash kept
// it, still marking the coin as spent in the mempool.

import { describe, expect, it } from "vitest";
import { addCoin, blockOf, buildTx, createTestIndexer, OP_TRUE_SCRIPTHASH } from "../testkit.js";

describe("a block against the mempool", () => {
	it("drops the mempool transactions it conflicts with, and their descendants", () => {
		const node = createTestIndexer();
		const coin = addCoin(node, "aa");
		const other = addCoin(node, "bb");
		const loser = buildTx([coin], [49_000n, 50_000n]);
		const loserChild = buildTx([{ txid: loser.txid, vout: 0 }], [48_000n]);
		const bystander = buildTx([other], [99_000n]);
		for (const tx of [loser, loserChild, bystander]) expect(node.submitTransaction(tx.hex).success).toBe(true);

		const winner = buildTx([coin], [98_000n]);
		const affected = node.storage.applyBlock(blockOf(node, [winner]));

		expect(node.getMempoolTxids()).toEqual([bystander.txid]);
		expect(node.getMempoolSpender(`${coin.txid}:0`)).toBeUndefined();
		expect(node.getRawTx(loser.txid)).toBeUndefined();
		expect(node.getMempoolHistory(OP_TRUE_SCRIPTHASH).map((entry) => entry.txHash)).toEqual([bystander.txid]);
		expect(node.getUtxos(OP_TRUE_SCRIPTHASH).map((utxo) => utxo.outpoint.txid).sort()).toEqual(
			[winner.txid, bystander.txid].sort(),
		);
		expect(affected.has(OP_TRUE_SCRIPTHASH)).toBe(true);
	});
});
