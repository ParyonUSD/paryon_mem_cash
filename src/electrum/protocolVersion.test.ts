// Fulcrum 1.x speaks protocol 1.4 to 1.5.3 and parses versions of up to three parts. Clients send three
// (ElectrumClient asks for '1.5.0', electrum-session for '1.5.2'), so a server that only knows two-part
// 1.6 refuses them all at the handshake.

import { describe, expect, expectTypeOf, it } from "vitest";
import { createIndexer } from "./indexer.js";

async function negotiate(requested: string | [string, string]) {
	const node = createIndexer();
	return node.request("server.version", ["client", requested]);
}

describe("server.version", () => {
	it("accepts the three-part versions clients send, answering as Fulcrum formats them", async () => {
		expect((await negotiate("1.5.2"))[1]).toBe("1.5.2");
		expect((await negotiate("1.4.3"))[1]).toBe("1.4.3");
		// Fulcrum leaves out a revision of 0; clients accept that form of their own version
		expect((await negotiate("1.5.0"))[1]).toBe("1.5");
		expect((await negotiate("1.4"))[1]).toBe("1.4");
	});

	it("negotiates a range down to the highest version Fulcrum speaks", async () => {
		expect((await negotiate(["1.4", "1.6"]))[1]).toBe("1.5.3");
		expect((await negotiate(["1.2", "1.4.2"]))[1]).toBe("1.4.2");
	});

	it("refuses versions outside 1.4 to 1.5.3", async () => {
		await expect(negotiate("1.3")).rejects.toThrow();
		await expect(negotiate("1.6")).rejects.toThrow();
		await expect(negotiate(["1.5.4", "1.7"])).rejects.toThrow();
		await expect(negotiate("1.5.x")).rejects.toThrow();
	});

	it("advertises the range in server.features", async () => {
		const features = await createIndexer().request("server.features", []);
		expect(features.protocol_min).toBe("1.4");
		expect(features.protocol_max).toBe("1.5.3");
	});

	it("answers blockchain.block.headers in the 1.5 shape it negotiated, and types it so", async () => {
		const node = createIndexer();
		node.setChainTip(10, 1_700_000_000);
		const headers = await node.request("blockchain.block.headers", [9, 2]);
		expectTypeOf(headers).toEqualTypeOf<
			| { count: number; hex: string; max: number }
			| { count: number; hex: string; max: number; root: string; branch: string[] }
		>();
		expect(headers).toEqual({ count: 2, hex: "0".repeat(320), max: 2016 });
	});
});
