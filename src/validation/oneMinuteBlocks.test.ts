// CHIP-2025-03, one-minute blocks: the height-mode locktime, the height-mode sequence lock and the
// coinbase maturity count ticks once a chain has an activation height. The vectors are the CHIP's own,
// tests/timelock/timelock.json of gitlab.com/0353F40E/fablous at e5fc824, unchanged.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkCoinbaseMaturity, checkLocktimeFinality, checkSequenceLocks } from "./checks.js";
import { assertOneMinuteBlocksActivationHeight, tickAtHeight } from "./ticks.js";

interface Vector {
	name: string;
	schedule: string;
	kind: "locktime" | "sequence" | "maturity";
	args: Record<string, string>;
	subjectIsCoinbase: boolean;
	expected: {
		blocks: { block: string; result: boolean }[];
		mempool: { tip: string; result: boolean }[];
	};
}

const file = JSON.parse(
	readFileSync(new URL("./vectors/chip-2025-03-timelock.json", import.meta.url), "utf8"),
) as {
	schedules: { name: string; schedule: { height: string; tau: string }[] }[];
	vectors: Vector[];
	timeModeVectors: Vector[];
};

// A chain here has no upgrade or one activation to one-minute blocks, so the vectors of the schedule
// with several steps are left out; and so are those of a coinbase transaction's own locktime, which a
// mempool never holds.
const activationHeights = new Map<string, number | undefined>();
for (const { name, schedule } of file.schedules) {
	if (schedule.length === 0) activationHeights.set(name, undefined);
	if (schedule.length === 1 && schedule[0].tau === "60") activationHeights.set(name, Number(schedule[0].height));
}
const applies = (vector: Vector) => activationHeights.has(vector.schedule) && !vector.subjectIsCoinbase;
const vectors = file.vectors.filter(applies);
const timeModeVectors = file.timeModeVectors.filter(applies);

/** Whether the vector's lock is met in `block`. */
function metInBlock({ kind, args, schedule }: Vector, block: number): boolean {
	const activationHeight = activationHeights.get(schedule);
	if (kind === "locktime") {
		const inputs = [{ sequenceNumber: Number(args.inputSequence) }];
		const blockTime = Number(args.blockTime ?? 0);
		return checkLocktimeFinality(Number(args.lockTime), inputs, block, blockTime, activationHeight).ok;
	}
	if (kind === "sequence") {
		const input = { sequenceNumber: Number(args.relativeLock), height: Number(args.fundingBlock) };
		return checkSequenceLocks(2, [input], block, 0, activationHeight).ok;
	}
	return checkCoinbaseMaturity([{ isCoinbase: true, height: Number(args.creationBlock) }], block, activationHeight)
		.ok;
}

describe("the CHIP's time-lock vectors", () => {
	it("cover each kind of lock, with and without the activation", () => {
		const covered = new Set(vectors.map((vector) => `${vector.schedule} ${vector.kind}`));
		expect([...covered].sort()).toEqual([
			"activation_1M locktime",
			"activation_1M maturity",
			"activation_1M sequence",
			"empty locktime",
			"empty maturity",
			"empty sequence",
		]);
		expect(timeModeVectors.length).toBeGreaterThan(0);
	});

	it.each([...vectors, ...timeModeVectors])("$name", (vector) => {
		for (const { block, result } of vector.expected.blocks) {
			expect(metInBlock(vector, Number(block)), `block ${block}`).toBe(result);
		}
		// The mempool asks for the block after the tip
		for (const { tip, result } of vector.expected.mempool) {
			expect(metInBlock(vector, Number(tip) + 1), `mempool at tip ${tip}`).toBe(result);
		}
	});
});

describe("tickAtHeight", () => {
	it("adds 600 ticks a block up to the activation block and 60 after it", () => {
		// The CHIP's table, with the activation at height 1,000,000
		expect(tickAtHeight(999_999, 1_000_000)).toBe(599_999_400);
		expect(tickAtHeight(1_000_000, 1_000_000)).toBe(600_000_000);
		expect(tickAtHeight(1_000_001, 1_000_000)).toBe(600_000_060);
		expect(tickAtHeight(1_000_010, 1_000_000)).toBe(600_000_600);
	});

	it("adds 600 ticks a block on a chain without the upgrade", () => {
		expect(tickAtHeight(0)).toBe(0);
		expect(tickAtHeight(1_000_010)).toBe(600_006_000);
	});
});

describe("assertOneMinuteBlocksActivationHeight", () => {
	it("takes a positive block height, or none", () => {
		expect(() => assertOneMinuteBlocksActivationHeight(undefined)).not.toThrow();
		expect(() => assertOneMinuteBlocksActivationHeight(332_450)).not.toThrow();
	});

	it.each([0, -1, 1.5, Number.NaN, 2 ** 53])("refuses %s", (height) => {
		expect(() => assertOneMinuteBlocksActivationHeight(height)).toThrow("oneMinuteBlocksActivationHeight");
	});
});
