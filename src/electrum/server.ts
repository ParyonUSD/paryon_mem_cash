import {
	ERR_BAD_REQUEST,
	err,
	type HandlerResult,
	invalidParams,
	ok,
	type ProtocolContext,
} from "./types.js";

type Version = [major: number, minor: number, revision: number];

/**
 * Parse a protocol version the way Fulcrum does: "1", "1.4" or "1.4.3", a missing part being 0.
 * Returns null if invalid. Upstream took two parts only, refusing the "1.5.0" clients send.
 */
function parseVersion(v: string): Version | null {
	if (!/^\d+(\.\d+){0,2}$/.test(v)) return null;
	const [major = 0, minor = 0, revision = 0] = v.split(".").map(Number);
	return [major, minor, revision];
}

/** Compare two versions. Returns negative, 0, or positive. */
function compareVersions(a: Version, b: Version): number {
	return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** Fulcrum's form of a version: the revision only when it is not 0 ("1.5" for 1.5.0). */
function formatVersion([major, minor, revision]: Version): string {
	return revision === 0 ? `${major}.${minor}` : `${major}.${minor}.${revision}`;
}

/** server.version */
export function version(ctx: ProtocolContext, params: unknown[]): HandlerResult {
	if (params.length < 2) return invalidParams("Expected [client_name, protocol_version]");

	// params[0] is client name (informational)
	// params[1] is either a version string or [min, max] array
	const clientVersionParam = params[1];

	let clientMin: string;
	let clientMax: string;

	if (typeof clientVersionParam === "string") {
		clientMin = clientVersionParam;
		clientMax = clientVersionParam;
	} else if (
		Array.isArray(clientVersionParam) &&
		clientVersionParam.length === 2 &&
		typeof clientVersionParam[0] === "string" &&
		typeof clientVersionParam[1] === "string"
	) {
		clientMin = clientVersionParam[0];
		clientMax = clientVersionParam[1];
	} else {
		return invalidParams("Invalid protocol version parameter");
	}

	const serverMin = parseVersion(ctx.protocolMin);
	const serverMax = parseVersion(ctx.protocolMax);
	const cMin = parseVersion(clientMin);
	const cMax = parseVersion(clientMax);

	if (!serverMin || !serverMax || !cMin || !cMax) {
		return err(ERR_BAD_REQUEST, "Version negotiation failed");
	}

	// Negotiate: find the highest version supported by both sides
	// Overlap exists if cMax >= serverMin && serverMax >= cMin
	if (compareVersions(cMax, serverMin) < 0 || compareVersions(serverMax, cMin) < 0) {
		return err(ERR_BAD_REQUEST, "Version negotiation failed — no compatible protocol version");
	}

	// Negotiated version = min(cMax, serverMax)
	const negotiated = compareVersions(cMax, serverMax) <= 0 ? cMax : serverMax;

	return ok([ctx.serverVersion, formatVersion(negotiated)]);
}

/** server.ping */
export function ping(_ctx: ProtocolContext, _params: unknown[]): HandlerResult {
	return ok(null);
}

/** server.features */
export function features(ctx: ProtocolContext, _params: unknown[]): HandlerResult {
	return ok({
		genesis_hash: ctx.genesisHash,
		server_version: ctx.serverVersion,
		protocol_min: ctx.protocolMin,
		protocol_max: ctx.protocolMax,
		hash_function: ctx.hashFunction,
		pruning: null,
	});
}

/** blockchain.estimatefee */
export async function estimateFee(ctx: ProtocolContext, params: unknown[]): Promise<HandlerResult> {
	const blocks = params[0];
	if (typeof blocks !== "number" || !Number.isInteger(blocks) || blocks < 1) {
		return invalidParams("Invalid number of blocks");
	}

	if (!ctx.estimateFee) {
		return ok(-1);
	}

	try {
		const fee = await ctx.estimateFee(blocks);
		return ok(fee);
	} catch {
		return ok(-1);
	}
}

/** server.banner */
export function banner(ctx: ProtocolContext, _params: unknown[]): HandlerResult {
	return ok(ctx.banner ?? "");
}

/** server.donation_address */
export function donationAddress(ctx: ProtocolContext, _params: unknown[]): HandlerResult {
	return ok(ctx.donationAddress ?? "");
}

/** server.add_peer — stub (P2P not implemented). */
export function addPeer(_ctx: ProtocolContext, _params: unknown[]): HandlerResult {
	return ok(false);
}

/** server.peers.subscribe — stub (P2P not implemented). */
export function peersSubscribe(_ctx: ProtocolContext, _params: unknown[]): HandlerResult {
	return ok([]);
}

/** blockchain.relayfee */
export function relayFee(ctx: ProtocolContext, _params: unknown[]): HandlerResult {
	if (!ctx.getRelayFee) {
		// Default BCH relay fee: 1000 sat/kB = 0.00001 BCH/kB
		return ok(0.00001);
	}

	return ok(ctx.getRelayFee());
}
