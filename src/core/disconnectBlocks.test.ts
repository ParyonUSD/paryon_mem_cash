// A reorg disconnects the last blocks and connects others. BCHN returns the disconnected blocks'
// transactions to the mempool where they are still valid (updateMempoolForReorg), keeps what the mempool
// held, and a transaction the new branch conflicts with drops out with its descendants. mem-cash had no
// way to disconnect a block but undoBlock, which cleared the mempool.

import { describe, expect, it } from "vitest";
import { addCoin, broadcast, buildTx, createTestIndexer, OP_TRUE_SCRIPTHASH } from "../testkit.js";

function minedFamily() {
	const node = createTestIndexer(200);
	const coin = addCoin(node, "aa");
	const parent = buildTx([coin], [49_000n, 50_000n]);
	const child = buildTx([{ txid: parent.txid, vout: 0 }], [48_000n]);
	for (const tx of [parent, child]) expect(node.submitTransaction(tx.hex).success).toBe(true);
	node.mine();
	// Pending on top of the block: spends the parent's other output
	const pending = buildTx([{ txid: parent.txid, vout: 1 }], [49_000n]);
	expect(node.submitTransaction(pending.hex).success).toBe(true);
	return { node, coin, parent, child, pending };
}

describe("disconnectBlocks", () => {
	it("returns the disconnected transactions to the mempool ahead of what it held, linked again", async () => {
		const { node, coin, parent, child, pending } = minedFamily();
		const block = node.getTip();
		const result = node.disconnectBlocks(1);

		expect(result).toMatchObject({ height: 200, returned: [parent.txid, child.txid, pending.txid], dropped: [] });
		expect(node.getTip()?.height).toBe(200);
		expect(node.getHeaderByHash(block?.hash ?? "")).toBeUndefined();
		expect(node.getMempoolTxids()).toEqual([parent.txid, child.txid, pending.txid]);
		expect([...(node.getMempoolTx(pending.txid)?.parents ?? [])]).toEqual([parent.txid]);
		expect(node.getTx(parent.txid)).toBeUndefined();
		expect(await node.request("blockchain.transaction.get_height", [parent.txid])).toBe(0);
		// The coin the parent spends stays spent, now by the mempool
		expect(node.getMempoolSpender(`${coin.txid}:0`)).toBe(parent.txid);
		expect(node.getUtxos(OP_TRUE_SCRIPTHASH).map((utxo) => utxo.outpoint.txid).sort()).toEqual(
			[child.txid, pending.txid].sort(),
		);
	});

	it("notifies each changed scripthash once, with the final status", async () => {
		const { node } = minedFamily();
		const statuses: unknown[] = [];
		await node.subscribe("blockchain.scripthash.subscribe", [OP_TRUE_SCRIPTHASH], (data) => statuses.push(data));
		node.disconnectBlocks(1);
		expect(statuses).toEqual([
			[OP_TRUE_SCRIPTHASH, expect.any(String)],
			[OP_TRUE_SCRIPTHASH, node.getScriptHashStatus(OP_TRUE_SCRIPTHASH)],
		]);
	});

	it("admits replacements first, so the transactions they conflict with drop out with descendants", () => {
		const { node, coin, parent, child, pending } = minedFamily();
		const oldBlock = node.getTip();
		const doubleSpend = buildTx([coin], [98_000n]);
		const result = node.disconnectBlocks(1, { replacementTxs: [doubleSpend.hex] });

		expect(result.returned).toEqual([doubleSpend.txid]);
		expect(result.dropped).toEqual([parent.txid, child.txid, pending.txid]);
		expect(node.getMempoolTxids()).toEqual([doubleSpend.txid]);
		expect(node.getRawTx(parent.txid)).toBeUndefined();

		node.mine();
		node.mine();
		expect(node.getTip()?.height).toBe(202);
		expect(node.getHeader(201)?.hash).not.toBe(oldBlock?.hash);
		expect(node.getTx(doubleSpend.txid)?.height).toBe(201);
	});

	it("lists a replacement that was one of the disconnected transactions once", () => {
		const { node, parent, child, pending } = minedFamily();
		const result = node.disconnectBlocks(1, { replacementTxs: [parent.hex] });
		expect(result.returned).toEqual([parent.txid, child.txid, pending.txid]);
	});

	it("throws on a replacement the node refuses, leaving the node as it was", async () => {
		const { node, pending } = minedFamily();
		const tip = node.getTip();
		const orphan = buildTx([{ txid: "ee".repeat(32), vout: 0 }], [1_000n]);
		expect(() => node.disconnectBlocks(1, { replacementTxs: [orphan.hex] })).toThrow(/Missing inputs/);
		expect(node.getTip()).toEqual(tip);
		expect(node.getMempoolTxids()).toEqual([pending.txid]);
		expect(await broadcast(node, pending.hex)).toBe(pending.txid);
	});

	it("drops a returning transaction no longer final at the lower tip", () => {
		const node = createTestIndexer(200);
		// A locktime must be below the height of the block holding it: 201 fits block 202, not the
		// block 201 that follows the tip once both blocks are disconnected
		const late = buildTx([{ ...addCoin(node, "aa"), sequence: 0 }], [49_000n, 50_000n], { locktime: 201 });
		node.mine();
		expect(node.submitTransaction(late.hex).success).toBe(true);
		node.mine();
		expect(node.disconnectBlocks(2)).toMatchObject({ height: 200, returned: [], dropped: [late.txid] });
	});

	it("refuses to disconnect more blocks than it has", () => {
		const node = createTestIndexer(200);
		node.mine();
		expect(() => node.disconnectBlocks(2)).toThrow();
		expect(() => node.disconnectBlocks(0)).toThrow();
		expect(node.getTip()?.height).toBe(201);
	});
});
