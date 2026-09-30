// A mempool transaction spending another's output is its child: Fulcrum files it at height -1 while a
// parent is unconfirmed, and BCHN removes it with its parent. mem-cash read a mempool coin's height 0 as
// "unknown" on the way to the verifier, so it linked nothing.

import { describe, expect, it } from "vitest";
import { addCoin, buildTx, createTestIndexer, OP_TRUE_SCRIPTHASH, type TestTx } from "../testkit.js";
import { type ProcessedBlock, parseOutpointKey } from "../types/index.js";

function family() {
	const node = createTestIndexer();
	const parent = buildTx([addCoin(node, "aa")], [49_000n, 50_000n]);
	const child = buildTx([{ txid: parent.txid, vout: 0 }], [48_000n]);
	const grandchild = buildTx([{ txid: child.txid, vout: 0 }], [47_000n]);
	for (const tx of [parent, child, grandchild]) expect(node.submitTransaction(tx.hex).success).toBe(true);
	return { node, parent, child, grandchild };
}

/** A block confirming `txs` alone, applied the way a consumer connects a block it did not mine. */
function blockOf(node: ReturnType<typeof createTestIndexer>, txs: TestTx[]): ProcessedBlock {
	const height = (node.getTip()?.height ?? 0) + 1;
	const hash = height.toString(16).padStart(64, "f");
	return {
		height,
		hash,
		header: {
			hash,
			height,
			version: 1,
			prevHash: "0".repeat(64),
			merkleRoot: "0".repeat(64),
			timestamp: 0,
			bits: 0,
			nonce: 0,
			hex: "",
		},
		transactions: txs.map(({ txid, hex }) => {
			const entry = node.getMempoolTx(txid);
			if (!entry) throw new Error(`${txid} is not in the mempool`);
			const spends = [...entry.entries.values()].flatMap((e) => [...e.confirmedSpends, ...e.unconfirmedSpends]);
			const outputs = [...entry.entries.values()].flatMap((e) => e.outputs);
			return {
				txid,
				rawHex: hex,
				inputs: spends.map((key) => ({ prevOutpoint: parseOutpointKey(key) })),
				outputs: outputs.map((key) => ({ outpointKey: key, utxo: { ...node.getMempoolUtxo(key)!, height } })),
			};
		}),
	};
}

describe("mempool parents", () => {
	it("links a mempool transaction to the mempool transactions it spends", () => {
		const { node, parent, child, grandchild } = family();
		expect([...(node.getMempoolTx(child.txid)?.parents ?? [])]).toEqual([parent.txid]);
		expect([...(node.getMempoolTx(parent.txid)?.children ?? [])]).toEqual([child.txid]);
		expect([...(node.getMempoolTx(grandchild.txid)?.parents ?? [])]).toEqual([child.txid]);
		expect(node.getMempoolTx(parent.txid)?.parents.size).toBe(0);
	});

	it("files a transaction with an unconfirmed parent at height -1, as Fulcrum does", async () => {
		const { node, parent, child, grandchild } = family();
		const mempool = (await node.request("blockchain.scripthash.get_mempool", [OP_TRUE_SCRIPTHASH])) as {
			tx_hash: string;
			height: number;
		}[];
		const heights = Object.fromEntries(mempool.map((entry) => [entry.tx_hash, entry.height]));
		expect(heights).toEqual({ [parent.txid]: 0, [child.txid]: -1, [grandchild.txid]: -1 });
	});

	it("removes a transaction's descendants with it", () => {
		const { node, parent } = family();
		node.storage.removeMempoolTx(parent.txid);
		expect(node.getMempoolTxids()).toEqual([]);
	});

	it("keeps a child in the mempool when a block confirms its parent, now at height 0", () => {
		const { node, parent, child, grandchild } = family();
		node.storage.applyBlock(blockOf(node, [parent]));

		expect(node.getMempoolTxids()).toEqual([child.txid, grandchild.txid]);
		expect(node.getMempoolTx(child.txid)?.parents.size).toBe(0);
		expect([...(node.getMempoolTx(child.txid)?.children ?? [])]).toEqual([grandchild.txid]);
		const heights = Object.fromEntries(node.getMempoolHistory(OP_TRUE_SCRIPTHASH).map((e) => [e.txHash, e.height]));
		expect(heights).toEqual({ [child.txid]: 0, [grandchild.txid]: -1 });
		// The parent's output the child spends is a confirmed coin now, still spent in the mempool
		expect(node.getUtxoByOutpoint(`${parent.txid}:0`)).toBeUndefined();
		expect(node.getUtxoByOutpoint(`${parent.txid}:1`)?.height).toBe(201);
		const spends = node.getMempoolTx(child.txid)?.entries.get(OP_TRUE_SCRIPTHASH);
		expect(spends).toMatchObject({ confirmedSpends: [`${parent.txid}:0`], unconfirmedSpends: [] });
	});
});
