// Which refusal wins when several apply. BCHN's AcceptToMemoryPoolWorker (validation.cpp) checks a
// transaction on its own first (CheckRegularTransaction, IsStandardTx, finality), then looks for
// conflicts and missing inputs, and only then at what the inputs hold. A client classifies the answer:
// the transaction service retries "Missing inputs", which a lagging server explains, but not a
// transaction that is not final yet.

import { describe, expect, it } from "vitest";
import { addCoin, addP2shCoin, broadcast, buildTx, createTestIndexer, rejected, toP2sh } from "../testkit.js";

const NON_FINAL = rejected("bad-txns-nonfinal, non-final transaction (code 64)");

describe("finality before inputs", () => {
	// A locktime of the tip plus five is final five blocks from now; sequence 0 makes it count
	const notFinal = { locktime: 205 };

	it("refuses a non-final transaction whose input the node does not know as non-final", async () => {
		const node = createTestIndexer(200);
		const tx = buildTx([{ txid: "bb".repeat(32), vout: 0, sequence: 0 }], [1_000n], notFinal);
		expect(await broadcast(node, tx.hex)).toBe(NON_FINAL);
		expect(node.submitTransaction(tx.hex)).toMatchObject({ code: 64, error: "bad-txns-nonfinal" });
	});

	it("refuses a non-final transaction that conflicts with the mempool as non-final", async () => {
		const node = createTestIndexer(200);
		const coin = addCoin(node, "aa");
		expect(node.submitTransaction(buildTx([coin], [99_000n]).hex).success).toBe(true);
		const tx = buildTx([{ ...coin, sequence: 0 }], [98_000n], notFinal);
		expect(await broadcast(node, tx.hex)).toBe(NON_FINAL);
	});

	it("refuses a non-final transaction with an unmet relative lock as non-final", async () => {
		const node = createTestIndexer(200);
		const parent = buildTx([addCoin(node, "aa")], [49_000n, 50_000n]);
		expect(node.submitTransaction(parent.hex).success).toBe(true);
		const tx = buildTx([{ txid: parent.txid, vout: 0, sequence: 1 }], [48_000n], notFinal);
		expect(await broadcast(node, tx.hex)).toBe(NON_FINAL);
	});

	it("still answers Missing inputs for a final transaction whose input the node does not know", async () => {
		const node = createTestIndexer(200);
		const tx = buildTx([{ txid: "bb".repeat(32), vout: 0, sequence: 0 }], [1_000n], { locktime: 200 });
		expect(await broadcast(node, tx.hex)).toBe(rejected("Missing inputs"));
	});

	it("answers debugTransaction in the same order", () => {
		const node = createTestIndexer(200);
		const tx = buildTx([{ txid: "bb".repeat(32), vout: 0, sequence: 0 }], [1_000n], notFinal);
		expect(node.debugTransaction(tx.hex)).toMatchObject({ success: false, error: "bad-txns-nonfinal" });
	});
});

describe("BCHN's check order", () => {
	it("refuses a dust output before a fee too low (IsStandardTx comes first)", async () => {
		const node = createTestIndexer(200, { standard: true });
		const tx = buildTx([addP2shCoin(node, "aa")], [toP2sh(99_900n), toP2sh(100n)]);
		expect(await broadcast(node, tx.hex)).toBe(rejected("dust (code 64)"));
	});

	it("refuses a dust output before a locktime not reached", async () => {
		const node = createTestIndexer(200, { standard: true });
		const coin = { ...addP2shCoin(node, "aa"), sequence: 0 };
		const tx = buildTx([coin], [toP2sh(98_000n), toP2sh(100n)], { locktime: 205 });
		expect(await broadcast(node, tx.hex)).toBe(rejected("dust (code 64)"));
	});

	it("refuses a duplicate input as bad-txns-inputs-duplicate before anything else", async () => {
		const node = createTestIndexer(200);
		const coin = { ...addCoin(node, "aa"), sequence: 0 };
		const tx = buildTx([coin, coin], [99_000n], { locktime: 205 });
		expect(await broadcast(node, tx.hex)).toBe(rejected("bad-txns-inputs-duplicate (code 16)"));
	});

	it("refuses an unmet relative lock before outputs exceeding inputs (sequence locks precede CheckTxInputs)", async () => {
		const node = createTestIndexer(200);
		const coin = addCoin(node, "aa", 1_000n, 200);
		const tx = buildTx([{ ...coin, sequence: 2 }], [2_000n]);
		expect(await broadcast(node, tx.hex)).toBe(rejected("non-BIP68-final (code 64)"));
	});
});
