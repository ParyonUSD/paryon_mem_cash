// Fulcrum files a mempool transaction at height -1 while one of its parents is unconfirmed, and at 0
// otherwise (Storage.cpp getHistory, getFirstUse: hasUnconfirmedParents), in get_history, get_mempool,
// get_first_use and the status hash; listunspent alone says 0 for every mempool coin. When a block
// confirms the parent, the child moves from -1 to 0, which changes the status of every scripthash it
// touches, so a subscriber hears of it even if nothing else about the scripthash changed.

import { describe, expect, it } from "vitest";
import {
	addCoin,
	buildTx,
	createTestIndexer,
	OP_TRUE_SCRIPTHASH,
	P2SH_OP_TRUE,
	P2SH_OP_TRUE_SCRIPTHASH,
	P2SH_OP_TRUE_UNLOCKING,
} from "../testkit.js";

/** A parent paying OP_TRUE and a child paying the P2SH scripthash, which only the child touches. */
function parentAndChild() {
	const node = createTestIndexer(200);
	const parent = buildTx([addCoin(node, "aa")], [49_000n, 50_000n]);
	const toP2sh = { lockingBytecode: P2SH_OP_TRUE, valueSatoshis: 48_000n };
	const child = buildTx([{ txid: parent.txid, vout: 0 }], [toP2sh]);
	for (const tx of [parent, child]) expect(node.submitTransaction(tx.hex).success).toBe(true);
	return { node, parent, child };
}

describe("mempool heights", () => {
	it("gives a child height -1 in get_history, get_mempool and get_first_use", async () => {
		const { node, child } = parentAndChild();
		const entry = { tx_hash: child.txid, height: -1, fee: 1_000 };
		expect(await node.request("blockchain.scripthash.get_history", [P2SH_OP_TRUE_SCRIPTHASH])).toEqual([entry]);
		expect(await node.request("blockchain.scripthash.get_mempool", [P2SH_OP_TRUE_SCRIPTHASH])).toEqual([entry]);
		expect(await node.request("blockchain.scripthash.get_first_use", [P2SH_OP_TRUE_SCRIPTHASH])).toEqual({
			block_hash: "00".repeat(32),
			height: -1,
			tx_hash: child.txid,
		});
	});

	it("answers get_first_use with the first mempool transaction paying the scripthash", async () => {
		// Two mempool transactions touch the P2SH scripthash, both at -1: `payer` pays it, `spender` only
		// spends from it. Fulcrum orders them by txid and skips one that pays nothing to the scripthash.
		for (let value = 47_000n; value > 46_000n; value -= 1n) {
			const { node, child: payer } = parentAndChild();
			const spender = buildTx([{ txid: payer.txid, vout: 0, unlocking: P2SH_OP_TRUE_UNLOCKING }], [value]);
			if (spender.txid > payer.txid) continue;
			expect(node.submitTransaction(spender.hex).success).toBe(true);
			const firstUse = await node.request("blockchain.scripthash.get_first_use", [P2SH_OP_TRUE_SCRIPTHASH]);
			expect(firstUse).toMatchObject({ height: -1, tx_hash: payer.txid });
			return;
		}
		throw new Error("no spender with a txid below the payer's");
	});

	it("notifies a scripthash only the child touches when the parent confirms", async () => {
		const { node, parent, child } = parentAndChild();
		const statuses: unknown[] = [];
		await node.subscribe("blockchain.scripthash.subscribe", [P2SH_OP_TRUE_SCRIPTHASH], (s) => statuses.push(s));
		node.mine({ include: [parent.txid] });

		expect(statuses).toHaveLength(2);
		expect(statuses[1]).not.toBe(statuses[0]);
		const entry = { tx_hash: child.txid, height: 0, fee: 1_000 };
		expect(await node.request("blockchain.scripthash.get_mempool", [P2SH_OP_TRUE_SCRIPTHASH])).toEqual([entry]);
		// listunspent says 0 for a mempool coin whatever its parents
		expect(await node.request("blockchain.scripthash.listunspent", [OP_TRUE_SCRIPTHASH])).toMatchObject([
			{ tx_hash: parent.txid, tx_pos: 1, height: 201 },
		]);
	});
});
