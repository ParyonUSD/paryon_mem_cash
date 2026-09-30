// A non-standard transaction is refused as BCHN's IsStandardTx and AreInputsStandard refuse it
// (policy/policy.cpp): the reason alone, code 64, and before finality, inputs and fees. libauth's
// standard VM made the same checks inside script verification, in its own words, wrapped as a script
// failure ("non-mandatory-script-verify-flag (Unable to verify standard transaction: ...)", or
// mandatory with code 16 for the version).

import { describe, expect, it } from "vitest";
import {
	addCoin,
	addP2shCoin,
	broadcast,
	buildTx,
	createTestIndexer,
	OP_TRUE,
	rejected,
	toP2sh,
} from "../testkit.js";

const standardNode = () => createTestIndexer(200, { standard: true });
const opReturn = (dataBytes: number) => ({
	lockingBytecode: Uint8Array.of(0x6a, 0x4c, dataBytes, ...new Uint8Array(dataBytes)),
	valueSatoshis: 0n,
});

describe("IsStandardTx", () => {
	it("refuses a version 3 transaction as version", async () => {
		const node = standardNode();
		const tx = buildTx([addP2shCoin(node, "aa")], [toP2sh(99_000n)], { version: 3 });
		expect(await broadcast(node, tx.hex)).toBe(rejected("version (code 64)"));
	});

	it("refuses a transaction over 100,000 bytes as tx-size", async () => {
		const node = standardNode();
		const big = { lockingBytecode: new Uint8Array(100_001).fill(0x51), valueSatoshis: 1_000n };
		const tx = buildTx([addP2shCoin(node, "aa")], [big]);
		expect(await broadcast(node, tx.hex)).toBe(rejected("tx-size (code 64)"));
	});

	it("refuses an unlocking script over 1,650 bytes as scriptsig-size", async () => {
		const node = standardNode();
		const push = Uint8Array.of(0x4d, 0x72, 0x06, ...new Uint8Array(1_650));
		const tx = buildTx([{ ...addP2shCoin(node, "aa"), unlocking: push }], [toP2sh(99_000n)]);
		expect(await broadcast(node, tx.hex)).toBe(rejected("scriptsig-size (code 64)"));
	});

	it("refuses an unlocking script with a non-push operation as scriptsig-not-pushonly", async () => {
		const node = standardNode();
		const coin = addP2shCoin(node, "aa");
		const tx = buildTx([{ ...coin, unlocking: Uint8Array.of(0x61, 0x01, 0x51) }], [toP2sh(99_000n)]);
		expect(await broadcast(node, tx.hex)).toBe(rejected("scriptsig-not-pushonly (code 64)"));
	});

	it("refuses an output that matches no standard template as scriptpubkey", async () => {
		const node = standardNode();
		const tx = buildTx([addP2shCoin(node, "aa")], [{ lockingBytecode: OP_TRUE, valueSatoshis: 99_000n }]);
		expect(await broadcast(node, tx.hex)).toBe(rejected("scriptpubkey (code 64)"));
	});

	it("refuses data carrier outputs over 223 bytes as oversize-op-return", async () => {
		const node = standardNode();
		// Two OP_RETURN outputs of 3 + 110 and 3 + 109 bytes: 225 bytes of script
		const tx = buildTx([addP2shCoin(node, "aa")], [toP2sh(99_000n), opReturn(110), opReturn(109)]);
		expect(await broadcast(node, tx.hex)).toBe(rejected("oversize-op-return (code 64)"));
	});

	it("refuses a non-standard output before a locktime not reached", async () => {
		const node = standardNode();
		const coin = { ...addP2shCoin(node, "aa"), sequence: 0 };
		const tx = buildTx([coin], [{ lockingBytecode: OP_TRUE, valueSatoshis: 99_000n }], { locktime: 205 });
		expect(await broadcast(node, tx.hex)).toBe(rejected("scriptpubkey (code 64)"));
	});
});

describe("AreInputsStandard", () => {
	it("refuses spending a coin that matches no standard template as bad-txns-nonstandard-inputs", async () => {
		const node = standardNode();
		const tx = buildTx([addCoin(node, "aa")], [toP2sh(99_000n)]);
		expect(await broadcast(node, tx.hex)).toBe(rejected("bad-txns-nonstandard-inputs (code 64)"));
	});
});

describe("data carrier bytes", () => {
	// BCHN sums the size of every data carrier output's script (nDataSize) against -datacarriersize, 223 by
	// default; libauth counts one more byte per output (its serialized length prefix) and refused both.
	it("accepts one OP_RETURN output of exactly 223 bytes of script", async () => {
		const node = standardNode();
		const tx = buildTx([addP2shCoin(node, "aa")], [toP2sh(99_000n), opReturn(220)]);
		expect(await broadcast(node, tx.hex)).toBe(tx.txid);
	});

	it("accepts two OP_RETURN outputs of 223 bytes of script together", async () => {
		const node = standardNode();
		const tx = buildTx([addP2shCoin(node, "aa")], [toP2sh(99_000n), opReturn(108), opReturn(109)]);
		expect(await broadcast(node, tx.hex)).toBe(tx.txid);
	});
});
