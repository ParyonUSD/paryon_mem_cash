// The Electrum protocol's scripthash is the sha256 of the locking bytecode with its bytes reversed. A
// client computes it that way, so a server keyed by the plain hash answers every such client with nothing.

import {
	binToHex,
	encodeTransactionBch,
	hexToBin,
	lockingBytecodeToCashAddress,
} from "@bitauth/libauth";
import { describe, expect, it } from "vitest";
import { createIndexer } from "./indexer.js";

// The example in the Electrum protocol's documentation (protocol-basics, "Script Hashes"): the P2PKH
// output of 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa and the scripthash a client asks for it.
const P2PKH = hexToBin("76a91462e907b15cbf27d5425399ebf6f0fb50ebb88f1888ac");
const ELECTRUM_SCRIPTHASH = "8b01df4e368ea28f8dc0423bcf7a4923e3a12d307c875e47a0cfbf90b5c39161";

const address = (() => {
	const encoded = lockingBytecodeToCashAddress({ bytecode: P2PKH, prefix: "bitcoincash" });
	if (typeof encoded === "string") throw new Error(encoded);
	return encoded.address;
})();

function setup() {
	const node = createIndexer();
	node.setChainTip(200, 1_700_000_000);
	node.addUtxo({ txid: "aa".repeat(32), vout: 0, satoshis: 10_000n, address, height: 100 });
	return node;
}

describe("Electrum scripthashes", () => {
	it("finds a coin by the scripthash an Electrum client computes", async () => {
		const node = setup();
		const coins = await node.request("blockchain.scripthash.listunspent", [ELECTRUM_SCRIPTHASH]);
		expect(coins).toEqual([{ tx_hash: "aa".repeat(32), tx_pos: 0, height: 100, value: 10_000 }]);
	});

	it("gives an address the scripthash an Electrum client computes", async () => {
		const node = setup();
		expect(await node.request("blockchain.address.get_scripthash", [address])).toBe(ELECTRUM_SCRIPTHASH);
		const info = (await node.request("blockchain.utxo.get_info", ["aa".repeat(32), 0])) as { scripthash: string };
		expect(info.scripthash).toBe(ELECTRUM_SCRIPTHASH);
	});

	it("files a mempool transaction's outputs and spends under the same scripthash", async () => {
		const node = setup();
		const spend = binToHex(
			encodeTransactionBch({
				version: 2,
				locktime: 0,
				inputs: [
					{
						outpointTransactionHash: hexToBin("aa".repeat(32)),
						outpointIndex: 0,
						unlockingBytecode: new Uint8Array(0),
						sequenceNumber: 0xffffffff,
					},
				],
				outputs: [{ lockingBytecode: P2PKH, valueSatoshis: 9_000n }],
			}),
		);
		const result = node.submitTransaction(spend);
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect([...result.affectedScriptHashes]).toEqual([ELECTRUM_SCRIPTHASH]);
		const mempool = await node.request("blockchain.scripthash.get_mempool", [ELECTRUM_SCRIPTHASH]);
		expect(mempool).toEqual([{ tx_hash: result.txid, height: 0, fee: 1_000 }]);
	});

	it("notifies an address subscriber and a scripthash subscriber of the same change", async () => {
		const node = setup();
		const byAddress: unknown[] = [];
		const byScriptHash: unknown[] = [];
		await node.subscribe("blockchain.address.subscribe", [address], (data) => byAddress.push(data));
		await node.subscribe("blockchain.scripthash.subscribe", [ELECTRUM_SCRIPTHASH], (data) =>
			byScriptHash.push(data),
		);
		await node.request("test.add_utxo", [address, { satoshis: 1_000 }]);
		expect(byAddress).toHaveLength(2);
		expect(byScriptHash).toHaveLength(2);
		expect(byScriptHash[1]).toEqual([ELECTRUM_SCRIPTHASH, expect.any(String)]);
	});
});
