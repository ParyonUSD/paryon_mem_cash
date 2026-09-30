// Fulcrum reads a txid or scripthash parameter as hex in either case (QByteArray::fromHex), so a client
// sending upper case finds what it asks for. mem-cash compared the string as given, so upper case found
// nothing.

import { describe, expect, it } from "vitest";
import { addCoin, buildTx, createTestIndexer, OP_TRUE_SCRIPTHASH } from "../testkit.js";

describe("hex parameters in upper case", () => {
	it("finds a transaction and a scripthash's coins", async () => {
		const node = createTestIndexer(200);
		const tx = buildTx([addCoin(node, "aa")], [99_000n]);
		expect(node.submitTransaction(tx.hex).success).toBe(true);

		expect(await node.request("blockchain.transaction.get", [tx.txid.toUpperCase()])).toBe(tx.hex);
		const utxos = await node.request("blockchain.scripthash.listunspent", [OP_TRUE_SCRIPTHASH.toUpperCase()]);
		expect(utxos).toMatchObject([{ tx_hash: tx.txid, tx_pos: 0 }]);
	});
});
