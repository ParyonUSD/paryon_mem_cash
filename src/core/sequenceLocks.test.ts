// BIP68 counts a relative lock from the block that confirms the coin. BCHN takes a mempool coin to confirm
// in the next block (CheckSequenceLocks: MEMPOOL_HEIGHT is the tip's height + 1), so any height lock on an
// unconfirmed parent is not final yet. mem-cash counted it from height 1 and accepted it.

import { describe, expect, it } from "vitest";
import { addCoin, broadcast, buildTx, createTestIndexer, rejected } from "../testkit.js";

function withMempoolParent() {
	const node = createTestIndexer(200);
	const parent = buildTx([addCoin(node, "aa")], [49_000n, 50_000n]);
	expect(node.submitTransaction(parent.hex).success).toBe(true);
	return { node, parent };
}

describe("BIP68 on an unconfirmed parent", () => {
	it("refuses a relative height lock of 1 on a mempool coin", async () => {
		const { node, parent } = withMempoolParent();
		const child = buildTx([{ txid: parent.txid, vout: 0, sequence: 1 }], [48_000n]);
		expect(await broadcast(node, child.hex)).toBe(rejected("non-BIP68-final (code 64)"));
	});

	it("accepts a relative lock of 0, and a lock of 1 once the parent has confirmed", async () => {
		const { node, parent } = withMempoolParent();
		const unlocked = buildTx([{ txid: parent.txid, vout: 0, sequence: 0 }], [48_000n]);
		expect(await broadcast(node, unlocked.hex)).toBe(unlocked.txid);

		node.mine();
		const oneBlock = buildTx([{ txid: parent.txid, vout: 1, sequence: 1 }], [49_000n]);
		expect(await broadcast(node, oneBlock.hex)).toBe(oneBlock.txid);
	});

	it("ignores the lock of a version 1 transaction", async () => {
		const { node, parent } = withMempoolParent();
		const child = buildTx([{ txid: parent.txid, vout: 0, sequence: 1 }], [48_000n], { version: 1 });
		expect(await broadcast(node, child.hex)).toBe(child.txid);
	});
});

// A time lock counts from the median time past of the block before the coin's (BCHN CalculateSequenceLocks:
// GetAncestor(coinHeight - 1)->GetMedianTimePast()) and is met once the tip's median time past is that
// many 512-second units later; a mempool coin counts from the tip's. mem-cash never passed the coin's
// median time past to the verifier, which read it as 0, so every time lock was met.
const TIME_LOCK = 1 << 22;

describe("BIP68 time locks", () => {
	it("refuses a time lock on a confirmed coin until the median time past has moved on", async () => {
		const { node, parent } = withMempoolParent();
		node.mine();
		const locked = buildTx([{ txid: parent.txid, vout: 0, sequence: TIME_LOCK | 1 }], [48_000n]);
		expect(await broadcast(node, locked.hex)).toBe(rejected("non-BIP68-final (code 64)"));

		// Eleven blocks 1,000 seconds on move the median time past well past 512 seconds
		const start = node.getTip()?.timestamp ?? 0;
		for (let i = 1; i <= 11; i++) node.mine(start + 1_000 * i);
		expect(await broadcast(node, locked.hex)).toBe(locked.txid);
	});

	it("refuses a time lock on a mempool coin, and accepts a lock of 0", async () => {
		const { node, parent } = withMempoolParent();
		const locked = buildTx([{ txid: parent.txid, vout: 0, sequence: TIME_LOCK | 1 }], [48_000n]);
		expect(await broadcast(node, locked.hex)).toBe(rejected("non-BIP68-final (code 64)"));
		const unlocked = buildTx([{ txid: parent.txid, vout: 1, sequence: TIME_LOCK }], [49_000n]);
		expect(await broadcast(node, unlocked.hex)).toBe(unlocked.txid);
	});
});
