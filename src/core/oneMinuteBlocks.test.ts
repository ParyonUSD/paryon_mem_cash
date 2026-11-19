// A node with oneMinuteBlocksActivationHeight follows CHIP-2025-03 from the block after it: a block
// adds 60 ticks where it added 600, and a height in a locktime, a sequence number or the coinbase
// maturity keeps meaning 600 ticks, so each takes ten blocks per unit. What is early is refused with
// the same reasons and codes as before the upgrade.

import { describe, expect, it } from "vitest";
import { createIndexer } from "../electrum/index.js";
import { addCoin, broadcast, buildTx, createTestIndexer, OP_TRUE, OP_TRUE_SCRIPTHASH, rejected } from "../testkit.js";

const ACTIVATION = 200;
const NON_FINAL = rejected("bad-txns-nonfinal, non-final transaction (code 64)");
const NON_BIP68_FINAL = rejected("non-BIP68-final (code 64)");

const activated = (height = ACTIVATION) => createTestIndexer(height, { oneMinuteBlocksActivationHeight: ACTIVATION });

function mineTo(node: ReturnType<typeof createTestIndexer>, height: number) {
	while ((node.getTip()?.height ?? 0) < height) node.mine();
}

describe("a height locktime after the activation", () => {
	it("is final ten blocks per unit past the activation block", async () => {
		const node = activated();
		// 201 names the tick 120,600, which block 211 is the first to pass
		const tx = buildTx([{ ...addCoin(node, "aa"), sequence: 0 }], [99_000n], { locktime: 201 });
		mineTo(node, 209);
		expect(await broadcast(node, tx.hex)).toBe(NON_FINAL);
		mineTo(node, 210);
		expect(await broadcast(node, tx.hex)).toBe(tx.txid);
	});

	it("leaves the mempool when a reorg takes the tip back below it", async () => {
		const node = activated();
		const tx = buildTx([{ ...addCoin(node, "aa"), sequence: 0 }], [99_000n], { locktime: 201 });
		mineTo(node, 210);
		expect(await broadcast(node, tx.hex)).toBe(tx.txid);
		node.disconnectBlocks(1);
		expect(node.storage.getMempoolTx(tx.txid)).toBeUndefined();
	});
});

describe("a height sequence lock after the activation", () => {
	it("is met ten blocks per unit after the coin's block", async () => {
		const node = activated();
		const parent = buildTx([addCoin(node, "aa")], [99_000n]);
		expect(node.submitTransaction(parent.hex).success).toBe(true);
		node.mine(); // the coin confirms at 201, the first block of 60 ticks
		const child = buildTx([{ txid: parent.txid, vout: 0, sequence: 1 }], [98_000n]);
		mineTo(node, 209);
		expect(await broadcast(node, child.hex)).toBe(NON_BIP68_FINAL);
		mineTo(node, 210);
		expect(await broadcast(node, child.hex)).toBe(child.txid);
	});

	it("counts a coin from before the activation by its own blocks' ticks", async () => {
		const node = activated();
		// Confirmed at 199: block 200 adds 600 ticks, and the other 600 take the ten blocks up to 210
		const coin = { ...addCoin(node, "aa", 100_000n, 199), sequence: 2 };
		const tx = buildTx([coin], [99_000n]);
		mineTo(node, 208);
		expect(await broadcast(node, tx.hex)).toBe(NON_BIP68_FINAL);
		mineTo(node, 209);
		expect(await broadcast(node, tx.hex)).toBe(tx.txid);
	});
});

describe("the coinbase maturity after the activation", () => {
	function withCoinbaseAt(coinbaseHeight: number, tip: number) {
		const node = activated(tip);
		const txid = "cb".repeat(32);
		node.addUtxo({
			txid,
			vout: 0,
			satoshis: 100_000n,
			height: coinbaseHeight,
			lockingBytecode: OP_TRUE,
			scriptHash: OP_TRUE_SCRIPTHASH,
			isCoinbase: true,
		});
		return { node, tx: buildTx([{ txid, vout: 0 }], [99_000n]) };
	}

	it("is 60,000 ticks, a thousand one-minute blocks", async () => {
		const { node, tx } = withCoinbaseAt(201, 1_199);
		expect(await broadcast(node, tx.hex)).toBe(
			rejected("bad-txns-premature-spend-of-coinbase, tried to spend coinbase at depth 999 (code 16)"),
		);
		node.mine();
		expect(await broadcast(node, tx.hex)).toBe(tx.txid);
	});

	it("counts the blocks before the activation at 600 ticks", async () => {
		// Fifty blocks of 600 ticks up to the activation, then 500 of 60
		const { node, tx } = withCoinbaseAt(150, 698);
		expect((await broadcast(node, tx.hex)).includes("bad-txns-premature-spend-of-coinbase")).toBe(true);
		node.mine();
		expect(await broadcast(node, tx.hex)).toBe(tx.txid);
	});
});

describe("the oneMinuteBlocksActivationHeight option", () => {
	it("leaves a node without it on the block-height rules", async () => {
		const node = createTestIndexer(200);
		const tx = buildTx([{ ...addCoin(node, "aa"), sequence: 0 }], [99_000n], { locktime: 201 });
		expect(await broadcast(node, tx.hex)).toBe(NON_FINAL);
		node.mine();
		expect(await broadcast(node, tx.hex)).toBe(tx.txid);
	});

	it("changes nothing up to the activation block", async () => {
		const node = createTestIndexer(100, { oneMinuteBlocksActivationHeight: ACTIVATION });
		const tx = buildTx([{ ...addCoin(node, "aa", 100_000n, 50), sequence: 0 }], [99_000n], { locktime: 101 });
		expect(await broadcast(node, tx.hex)).toBe(NON_FINAL);
		node.mine();
		expect(await broadcast(node, tx.hex)).toBe(tx.txid);
	});

	it.each([0, -5, 1.5])("refuses %s as a height", (height) => {
		expect(() => createIndexer({ oneMinuteBlocksActivationHeight: height })).toThrow(
			"oneMinuteBlocksActivationHeight",
		);
	});
});
