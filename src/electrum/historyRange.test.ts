// get_history's from_height and to_height as Fulcrum reads them (Server::parseFromToBlockHeightCommon,
// Storage::getHistory): to_height is exclusive, -1 means no bound, and only without a bound does the
// mempool come in; a negative from_height, a to_height below -1 or below from_height is refused as
// invalid params. mem-cash took to_height as inclusive and any negative as no bound.

import { describe, expect, it } from "vitest";
import { getHistory } from "./scripthash.js";
import type { ProtocolContext } from "./types.js";
import { addCoin, buildTx, createTestIndexer, OP_TRUE_SCRIPTHASH } from "../testkit.js";

function twoBlocks() {
	const node = createTestIndexer(200);
	const first = buildTx([addCoin(node, "aa")], [99_000n]);
	node.submitTransaction(first.hex);
	node.mine();
	const second = buildTx([{ txid: first.txid, vout: 0 }], [98_000n]);
	node.submitTransaction(second.hex);
	node.mine();
	const pending = buildTx([{ txid: second.txid, vout: 0 }], [97_000n]);
	node.submitTransaction(pending.hex);
	return { node, first, second, pending };
}

const heights = (history: unknown) => (history as { height: number }[]).map((entry) => entry.height);

describe("get_history range", () => {
	it("excludes to_height itself, and the mempool with it", async () => {
		const { node } = twoBlocks();
		expect(heights(await node.request("blockchain.scripthash.get_history", [OP_TRUE_SCRIPTHASH, 0, 202]))).toEqual([
			201,
		]);
		expect(heights(await node.request("blockchain.scripthash.get_history", [OP_TRUE_SCRIPTHASH, 202, -1]))).toEqual([
			202, 0,
		]);
	});

	it("refuses a to_height below -1 or below from_height, and a negative from_height", () => {
		const { node } = twoBlocks();
		const ctx = { node } as unknown as ProtocolContext;
		const badTo = { error: { code: -32602, message: "Bad to_height argument" } };
		expect(getHistory(ctx, [OP_TRUE_SCRIPTHASH, 0, -5])).toEqual(badTo);
		expect(getHistory(ctx, [OP_TRUE_SCRIPTHASH, 202, 201])).toEqual(badTo);
		expect(getHistory(ctx, [OP_TRUE_SCRIPTHASH, -1])).toEqual({
			error: { code: -32602, message: "Bad from_height argument" },
		});
	});
});
