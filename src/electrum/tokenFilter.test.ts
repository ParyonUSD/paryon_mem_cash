// Fulcrum's token filter, the optional second parameter of listunspent and get_balance
// (Server::parseTokenFilterOptionCommon): "include_tokens", the default for a token-aware client,
// "exclude_tokens" or "tokens_only", trimmed and in any case; anything else is refused as invalid
// params. mem-cash ignored the parameter and listed every coin.

import { describe, expect, it } from "vitest";
import { getBalance, listUnspent } from "./scripthash.js";
import type { ProtocolContext } from "./types.js";
import { addCoin, createTestIndexer, OP_TRUE, OP_TRUE_SCRIPTHASH } from "../testkit.js";

function withTokenCoin() {
	const node = createTestIndexer(200);
	node.addUtxo({
		txid: "aa".repeat(32),
		vout: 0,
		satoshis: 1_000n,
		height: 100,
		lockingBytecode: OP_TRUE,
		scriptHash: OP_TRUE_SCRIPTHASH,
		tokenData: { category: "cc".repeat(32), amount: 5n },
	});
	addCoin(node, "bb", 2_000n);
	return node;
}

async function values(node: ReturnType<typeof createTestIndexer>, ...filter: string[]) {
	const utxos = (await node.request("blockchain.scripthash.listunspent", [OP_TRUE_SCRIPTHASH, ...filter] as never)) as {
		value: number;
	}[];
	return utxos.map((u) => u.value).sort((a, b) => a - b);
}

describe("token filter", () => {
	it("lists every coin by default and with include_tokens", async () => {
		const node = withTokenCoin();
		expect(await values(node)).toEqual([1_000, 2_000]);
		expect(await values(node, "include_tokens")).toEqual([1_000, 2_000]);
	});

	it("leaves out coins with tokens for exclude_tokens, and others for tokens_only", async () => {
		const node = withTokenCoin();
		expect(await values(node, "exclude_tokens")).toEqual([2_000]);
		expect(await values(node, " Tokens_Only ")).toEqual([1_000]);
	});

	it("filters get_balance the same way", async () => {
		const node = withTokenCoin();
		const balance = (filter: string) =>
			node.request("blockchain.scripthash.get_balance", [OP_TRUE_SCRIPTHASH, filter] as never);
		expect(await balance("exclude_tokens")).toEqual({ confirmed: 2_000, unconfirmed: 0 });
		expect(await balance("tokens_only")).toEqual({ confirmed: 1_000, unconfirmed: 0 });
	});

	it("refuses an unknown filter as invalid params", () => {
		const node = withTokenCoin();
		const ctx = { node } as unknown as ProtocolContext;
		for (const handler of [listUnspent, getBalance]) {
			expect(handler(ctx, [OP_TRUE_SCRIPTHASH, "bogus"])).toEqual({
				error: {
					code: -32602,
					message: 'Invalid token filtering option. Specify one of: "exclude_tokens", "include_tokens", "tokens_only"',
				},
			});
		}
	});
});
