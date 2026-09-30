// A block's header is 80 bytes that hash to the block's hash and name the previous block's hash, which is
// how a client following headers recognises a reorg. mine() emitted 80 zero bytes under a hash made from
// the height alone, and rewrote the last 11 headers after every block.

import { binToHex, hexToBin, sha256 } from "@bitauth/libauth";
import { describe, expect, it } from "vitest";
import { addCoin, buildTx, createTestIndexer } from "../testkit.js";

const doubleSha256 = (bytes: Uint8Array) => sha256.hash(sha256.hash(bytes));
const reversedHex = (hex: string) => binToHex(hexToBin(hex).reverse());
const uint32 = (hex: string, offset: number) =>
	new DataView(hexToBin(hex).buffer).getUint32(offset, true);

describe("mined headers", () => {
	it("are 80 bytes that hash to the block hash and link to the previous block", () => {
		const node = createTestIndexer(200);
		const before = node.getTip();
		node.mine();
		node.mine();
		const first = node.getHeader(201);
		const second = node.getHeader(202);
		for (const header of [first, second]) {
			expect(header?.hex).toHaveLength(160);
			expect(header?.hash).toBe(binToHex(doubleSha256(hexToBin(header?.hex ?? "")).reverse()));
		}
		expect(first?.prevHash).toBe(before?.hash);
		expect(second?.prevHash).toBe(first?.hash);
		expect(second?.hex.slice(8, 72)).toBe(reversedHex(first?.hash ?? ""));
		expect(uint32(second?.hex ?? "", 68)).toBe(second?.timestamp);
		expect(node.getHeaderByHash(first?.hash ?? "")).toEqual(first);
	});

	it("commit to the block's transactions in the merkle root", () => {
		const node = createTestIndexer(200);
		const a = buildTx([addCoin(node, "aa")], [49_000n, 50_000n]);
		const b = buildTx([addCoin(node, "bb")], [49_000n, 50_000n]);
		for (const tx of [a, b]) node.submitTransaction(tx.hex);
		node.mine();
		const header = node.getHeader(201);
		const root = doubleSha256(new Uint8Array([...hexToBin(a.txid).reverse(), ...hexToBin(b.txid).reverse()]));
		expect(header?.merkleRoot).toBe(binToHex(root.slice().reverse()));
		expect(header?.hex.slice(72, 136)).toBe(binToHex(root));
	});

	it("differ between blocks, and leave the headers before them alone", () => {
		const node = createTestIndexer(200);
		const genesisSide = node.getHeader(195);
		node.mine();
		const first = node.getHeader(201);
		node.mine();
		expect(node.getHeader(202)?.hash).not.toBe(first?.hash);
		expect(node.getHeader(201)).toEqual(first);
		expect(node.getHeader(195)).toEqual(genesisSide);
	});

	it("link from the headers setChainTip stores, as a client hashing them sees it", async () => {
		// setChainTip stored 80 zero bytes under a hash made from the height, so the tip's header hex
		// hashed to something other than the hash the first mined block named as its parent, and a client
		// checking linkage by hashing hex saw a reorg at the first block.
		const node = createTestIndexer(200);
		const hashOf = (hex: string) => binToHex(doubleSha256(hexToBin(hex)).reverse());
		const headerHex = async (height: number) => (await node.request("blockchain.block.header", [height])) as string;
		const hexes: string[] = [];
		for (let h = 190; h <= 200; h++) hexes.push(await headerHex(h));
		expect(new Set(hexes.map(hashOf)).size).toBe(hexes.length);
		for (let i = 1; i < hexes.length; i++) {
			expect(hexes[i]?.slice(8, 72)).toBe(reversedHex(hashOf(hexes[i - 1] ?? "")));
		}
		const tipHex = hexes.at(-1) ?? "";
		expect(node.getTip()?.hash).toBe(hashOf(tipHex));
		expect(uint32(tipHex, 68)).toBe(1_700_000_000);
		node.mine();
		const next = await headerHex(201);
		expect(next.slice(8, 72)).toBe(reversedHex(hashOf(tipHex)));
	});

	it("reach Electrum clients as they are stored", async () => {
		const node = createTestIndexer(200);
		const notified: unknown[] = [];
		await node.subscribe("blockchain.headers.subscribe", [], (data) => notified.push(data));
		node.mine();
		const tip = node.getTip();
		expect(notified.at(-1)).toEqual([{ height: 201, hex: tip?.hex }]);
		expect(await node.request("blockchain.block.header", [201])).toBe(tip?.hex);
	});
});
