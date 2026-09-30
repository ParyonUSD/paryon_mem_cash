// Consensus refusals in BCHN's words and place (consensus/tx_check.cpp CheckTransactionCommon,
// consensus/tx_verify.cpp ContextualCheckTransaction): the checks on the transaction alone come before
// its inputs are looked up, and the contextual ones, which the mempool re-codes 64 as it does finality,
// right after finality. libauth's VM made them last, in its own words, wrapped as a script failure.

import { binToHex, encodeTransactionBch, hexToBin } from "@bitauth/libauth";
import { describe, expect, it } from "vitest";
import { addCoin, broadcast, buildTx, createTestIndexer, OP_TRUE, rejected } from "../testkit.js";

const MAX_MONEY = 2_100_000_000_000_000n;
const unknownInput = { txid: "bb".repeat(32), vout: 0 };

describe("CheckTransactionCommon", () => {
	it("refuses a transaction without inputs as bad-txns-vin-empty", async () => {
		const node = createTestIndexer(200);
		const tx = binToHex(encodeTransactionBch({
			version: 2,
			locktime: 0,
			inputs: [],
			outputs: [{ lockingBytecode: new Uint8Array(60).fill(0x51), valueSatoshis: 1_000n }],
		}));
		expect(await broadcast(node, tx)).toBe(rejected("bad-txns-vin-empty (code 16)"));
	});

	it("refuses an output above 21 million BCH as bad-txns-vout-toolarge, before looking up inputs", async () => {
		const node = createTestIndexer(200);
		const tx = buildTx([unknownInput], [MAX_MONEY + 1n]);
		expect(await broadcast(node, tx.hex)).toBe(rejected("bad-txns-vout-toolarge (code 16)"));
	});

	it("refuses outputs summing above 21 million BCH as bad-txns-txouttotal-toolarge", async () => {
		const node = createTestIndexer(200);
		const tx = buildTx([unknownInput], [MAX_MONEY, 1n]);
		expect(await broadcast(node, tx.hex)).toBe(rejected("bad-txns-txouttotal-toolarge (code 16)"));
	});
});

describe("ContextualCheckTransaction", () => {
	it("refuses a version 3 transaction as bad-txns-version when standardness is off", async () => {
		const node = createTestIndexer(200);
		const tx = buildTx([addCoin(node, "aa")], [99_000n], { version: 3 });
		expect(await broadcast(node, tx.hex)).toBe(rejected("bad-txns-version (code 64)"));
	});

	it("refuses a transaction under 65 bytes as bad-txns-undersize", async () => {
		const node = createTestIndexer(200);
		const coin = addCoin(node, "aa");
		const tx = binToHex(encodeTransactionBch({
			version: 2,
			locktime: 0,
			inputs: [{
				outpointTransactionHash: hexToBin(coin.txid),
				outpointIndex: 0,
				unlockingBytecode: new Uint8Array(0),
				sequenceNumber: 0xffffffff,
			}],
			outputs: [{ lockingBytecode: OP_TRUE, valueSatoshis: 99_000n }],
		}));
		expect(hexToBin(tx).length).toBeLessThan(65);
		expect(await broadcast(node, tx)).toBe(rejected("bad-txns-undersize (code 64)"));
	});
});

describe("CheckTxInputs", () => {
	it("gives bad-txns-in-belowout's amounts in BCH, as BCHN's FormatMoney does", async () => {
		const node = createTestIndexer(200);
		const small = buildTx([addCoin(node, "aa", 100_000n)], [200_000n]);
		expect(await broadcast(node, small.hex)).toBe(
			rejected("bad-txns-in-belowout, value in (0.001) < value out (0.002) (code 16)"),
		);
		const whole = buildTx([addCoin(node, "bb", 100_000_000n)], [100_000_001n]);
		expect(await broadcast(node, whole.hex)).toBe(
			rejected("bad-txns-in-belowout, value in (1.00) < value out (1.00000001) (code 16)"),
		);
	});
});
