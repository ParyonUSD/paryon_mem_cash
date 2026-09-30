// The error codes and texts Fulcrum answers with (Servers.cpp): a refused broadcast is code 1
// (Code_App_BadRequest) wrapping the node's words, and transaction.get of an unknown txid is code 2
// (Code_App_DaemonError) with bitcoind's error in ElectrumX's DaemonError form. mem-cash had them the
// other way round and gave the unknown txid bitcoind's bare message.

import { describe, expect, it } from "vitest";
import { broadcast, get } from "./transaction.js";
import type { ProtocolContext } from "./types.js";
import { buildTx, createTestIndexer } from "../testkit.js";

const context = () => ({ node: createTestIndexer(200) }) as unknown as ProtocolContext;

describe("Fulcrum error codes", () => {
	it("refuses a broadcast with code 1", () => {
		const orphan = buildTx([{ txid: "bb".repeat(32), vout: 0 }], [1_000n]);
		expect(broadcast(context(), [orphan.hex])).toEqual({
			error: { code: 1, message: "the transaction was rejected by network rules.\n\nMissing inputs\n" },
		});
	});

	it("answers an unknown txid with code 2 and bitcoind's error as a DaemonError", () => {
		expect(get(context(), ["cd".repeat(32)])).toEqual({
			error: {
				code: 2,
				message:
					"daemon error: DaemonError({'code': -5, 'message': 'No such mempool or blockchain transaction. " +
					"Use gettransaction for wallet transactions.'})",
			},
		});
	});
});
