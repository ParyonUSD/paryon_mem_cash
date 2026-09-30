// A verbose blockchain.transaction.get describes scripts as BCHN's getrawtransaction does, which Fulcrum
// passes on (core_write.cpp ScriptToAsmStr, ScriptPubKeyToUniv): asm for every script, pushes of up to 8
// bytes as numbers and a signature's sighash type named, and a locking script's type and addresses, P2SH32
// among the script hashes. mem-cash gave asm only for OP_RETURN, as hex, and called P2SH32 nonstandard.

import { describe, expect, it } from "vitest";
import { blockOf, buildTx, createTestIndexer } from "../testkit.js";

const P2SH32 = Uint8Array.of(0xaa, 0x20, ...new Uint8Array(32).fill(0xcc), 0x87);
const P2PKH = Uint8Array.of(0x76, 0xa9, 0x14, ...new Uint8Array(20).fill(0x11), 0x88, 0xac);
const signature = [...new Uint8Array(64).fill(0x22), 0x41];
const publicKey = [0x02, ...new Uint8Array(32).fill(0x33)];

describe("verbose transaction scripts", () => {
	it("gives BCHN's asm, type and addresses", async () => {
		const node = createTestIndexer(200);
		const tx = buildTx(
			[{ txid: "aa".repeat(32), vout: 0, unlocking: Uint8Array.of(65, ...signature, 33, ...publicKey) }],
			[
				{ lockingBytecode: P2SH32, valueSatoshis: 1_000n },
				{ lockingBytecode: P2PKH, valueSatoshis: 2_000n },
				{ lockingBytecode: Uint8Array.of(0x6a, 0x02, 0x6d, 0x02), valueSatoshis: 0n },
				{ lockingBytecode: Uint8Array.of(0x51), valueSatoshis: 3_000n },
			],
		);
		// A block from elsewhere holds it, so its input need not exist
		node.storage.applyBlock(blockOf(node, [tx]));
		const verbose = (await node.request("blockchain.transaction.get", [tx.txid, true])) as {
			vin: { scriptSig: { asm: string } }[];
			vout: { scriptPubKey: object }[];
		};

		expect(verbose.vin[0]?.scriptSig.asm).toBe(`${"22".repeat(64)}[ALL|FORKID] 02${"33".repeat(32)}`);
		expect(verbose.vout.map((output) => output.scriptPubKey)).toEqual([
			{
				asm: `OP_HASH256 ${"cc".repeat(32)} OP_EQUAL`,
				hex: `aa20${"cc".repeat(32)}87`,
				reqSigs: 1,
				type: "scripthash",
				addresses: ["bitcoincash:p0xvenxvenxvenxvenxvenxvenxvenxvenxvenxvenxvenxvenxvcm6gz4t77"],
			},
			{
				asm: `OP_DUP OP_HASH160 ${"11".repeat(20)} OP_EQUALVERIFY OP_CHECKSIG`,
				hex: `76a914${"11".repeat(20)}88ac`,
				reqSigs: 1,
				type: "pubkeyhash",
				addresses: ["bitcoincash:qqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zye3kwllue"],
			},
			{ asm: "OP_RETURN 621", hex: "6a026d02", type: "nulldata" },
			{ asm: "1", hex: "51", type: "nonstandard" },
		]);
	});
});
