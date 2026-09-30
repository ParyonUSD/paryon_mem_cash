// blockchain.scripthash.listunspent in Fulcrum's order (Storage.cpp listUnspent, UnspentItem::operator<):
// confirmed coins by height and position in the block, then mempool coins whose transaction has no
// unconfirmed parent, then those whose transaction has one; ties by tx_pos, value, then tx_hash. Builders
// pick coins by position (`.find`, `[0]`), so a different order makes the bot chain off a different coin.

import { describe, expect, it } from "vitest";
import { addCoin, buildTx, createTestIndexer, OP_TRUE_SCRIPTHASH } from "../testkit.js";

type Unspent = { tx_hash: string; tx_pos: number; height: number; value: number };

async function listUnspent(node: ReturnType<typeof createTestIndexer>): Promise<string[]> {
	const utxos = (await node.request("blockchain.scripthash.listunspent", [OP_TRUE_SCRIPTHASH])) as Unspent[];
	return utxos.map((u) => `${u.tx_hash}:${u.tx_pos}`);
}

describe("listunspent order", () => {
	it("lists confirmed coins by height, then mempool coins without then with unconfirmed parents", async () => {
		const node = createTestIndexer(200);
		const late = addCoin(node, "dd", 10_000n, 90);
		const early = addCoin(node, "ee", 10_000n, 60);
		const c1 = addCoin(node, "c1");
		const c2 = addCoin(node, "c2");

		const t1 = buildTx([c1], [49_000n, 50_000n]);
		const t3 = buildTx([{ txid: t1.txid, vout: 0 }], [48_000n]);
		const t2 = buildTx([c2], [60_000n, 39_000n]);
		for (const tx of [t1, t3, t2]) expect(node.submitTransaction(tx.hex).success).toBe(true);

		expect(await listUnspent(node)).toEqual([
			`${early.txid}:0`,
			`${late.txid}:0`,
			// No unconfirmed parent: by tx_pos, then value
			`${t2.txid}:0`,
			`${t2.txid}:1`,
			`${t1.txid}:1`,
			// A child of t1, which the mempool still holds
			`${t3.txid}:0`,
		]);
	});

	it("lists the coins of one mined block by position, which CTOR makes txid order, not mempool order", async () => {
		const node = createTestIndexer(200);
		const a = buildTx([addCoin(node, "aa")], [99_000n]);
		const b = buildTx([addCoin(node, "bb")], [99_000n]);
		// The mempool receives the higher txid first; the block holds the lower one first
		const [lower, higher] = a.txid < b.txid ? [a, b] : [b, a];
		for (const tx of [higher, lower]) expect(node.submitTransaction(tx.hex).success).toBe(true);
		node.mine();
		expect(await listUnspent(node)).toEqual([`${lower.txid}:0`, `${higher.txid}:0`]);
	});
});
