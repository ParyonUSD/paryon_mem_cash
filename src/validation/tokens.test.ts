// Token refusals as BCHN's CheckTxTokens (consensus/tokens.cpp) words them: the reason, and for most a
// debug message quoting the offending output's token::OutputData, code 16. libauth answered its own
// "Transaction violates token validation: ..." wrapped as a script failure.

import { hexToBin } from "@bitauth/libauth";
import { describe, expect, it } from "vitest";
import { broadcast, buildTx, createTestIndexer, OP_TRUE, OP_TRUE_SCRIPTHASH, rejected } from "../testkit.js";
import type { TokenData } from "../types/index.js";

const CATEGORY = "4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a";

function tokenCoin(node: ReturnType<typeof createTestIndexer>, seed: string, tokenData: TokenData, vout = 0) {
	const txid = seed.repeat(32);
	const scriptHash = OP_TRUE_SCRIPTHASH;
	node.addUtxo({ txid, vout, satoshis: 10_000n, height: 100, lockingBytecode: OP_TRUE, scriptHash, tokenData });
	return { txid, vout };
}

type TestToken = {
	category: string;
	amount: bigint;
	nft?: { capability: "none" | "mutable" | "minting"; commitment: string };
};

const withToken = (token: TestToken, valueSatoshis = 1_000n) => ({
	lockingBytecode: OP_TRUE,
	valueSatoshis,
	token: {
		category: hexToBin(token.category),
		amount: token.amount,
		...(token.nft ? { nft: { capability: token.nft.capability, commitment: hexToBin(token.nft.commitment) } } : {}),
	},
});

describe("CheckTxTokens", () => {
	it("refuses more fungible tokens out than in as bad-txns-token-in-belowout", async () => {
		const node = createTestIndexer(200);
		const coin = tokenCoin(node, "aa", { category: CATEGORY, amount: 1n });
		const tx = buildTx([coin], [withToken({ category: CATEGORY, amount: 2n })]);
		expect(await broadcast(node, tx.hex)).toBe(rejected(
			"bad-txns-token-in-belowout, CheckTxTokens: token (token::OutputData(id=4bf5122f344554c53bde2ebb8cd2b7, " +
				"bitfield=10, amount=2, commitment=)) value in < value out (code 16)",
		));
	});

	it("refuses tokens of a category no input holds or may create as bad-txns-token-invalid-category", async () => {
		const node = createTestIndexer(200);
		// Output 1 of a transaction cannot create its category: a genesis spends output 0
		const coin = tokenCoin(node, "cc", { category: CATEGORY, amount: 1n }, 1);
		const tx = buildTx([coin], [withToken({ category: "cc".repeat(32), amount: 5n })]);
		expect(await broadcast(node, tx.hex)).toBe(rejected("bad-txns-token-invalid-category (code 16)"));
	});

	it("refuses an NFT no input can back as bad-txns-token-nft-ex-nihilo", async () => {
		const node = createTestIndexer(200);
		const coin = tokenCoin(node, "aa", { category: CATEGORY, amount: 10n });
		const nft = withToken({ category: CATEGORY, amount: 10n, nft: { capability: "none", commitment: "beef" } });
		const tx = buildTx([coin], [nft]);
		expect(await broadcast(node, tx.hex)).toBe(rejected(
			"bad-txns-token-nft-ex-nihilo, CheckTxTokens: token (token::OutputData(id=4bf5122f344554c53bde2ebb8cd2b7, " +
				"bitfield=70, amount=10, commitment=beef)) nft output cannot be created out of thin air (code 16)",
		));
	});

	it("accepts a genesis, a transfer and an NFT a minting input backs", async () => {
		const node = createTestIndexer(200);
		const genesisCoin = tokenCoin(node, "dd", { category: CATEGORY, amount: 1n });
		const genesis = buildTx([genesisCoin], [
			withToken({ category: "dd".repeat(32), amount: 1_000n, nft: { capability: "minting", commitment: "" } }),
			withToken({ category: CATEGORY, amount: 1n }),
		]);
		expect(await broadcast(node, genesis.hex)).toBe(genesis.txid);
		const minted = buildTx([{ txid: genesis.txid, vout: 0 }], [
			withToken({ category: "dd".repeat(32), amount: 1_000n, nft: { capability: "minting", commitment: "" } }, 400n),
			withToken({ category: "dd".repeat(32), amount: 0n, nft: { capability: "none", commitment: "01" } }, 400n),
		]);
		expect(await broadcast(node, minted.hex)).toBe(minted.txid);
	});
});
