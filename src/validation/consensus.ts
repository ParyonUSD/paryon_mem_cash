// BCHN's consensus checks of a transaction on its own (consensus/tx_check.cpp CheckTransactionCommon), in
// the context of the next block (consensus/tx_verify.cpp ContextualCheckTransaction) and of its tokens
// (consensus/tokens.cpp CheckTxTokens), with BCHN's reject reasons. libauth's VM makes them too, but last
// and in its own words; these run where BCHN runs them.

import { binToHex, type Output } from "@bitauth/libauth";
import { REJECT_INVALID } from "../types/index.js";
import type { CheckResult } from "./checks.js";
import { MAX_MONEY } from "./constants.js";
import type { Transaction } from "./types.js";

/** The limits of libauth's consensus table these checks read, overrides applied. */
export interface ConsensusLimits {
	readonly minimumConsensusVersion: number;
	readonly maximumConsensusVersion: number;
	readonly minimumTransactionLengthBytes: number;
	readonly maximumTransactionLengthBytes: number;
	readonly maximumTokenCommitmentLength: number;
}

const invalid = (error: string): CheckResult => ({ ok: false, code: REJECT_INVALID, error });

/** BCHN CheckTransactionCommon: inputs and outputs present, the size limit, output values in range. */
export function checkTransactionCommon(transaction: Transaction, length: number, limits: ConsensusLimits): CheckResult {
	if (transaction.inputs.length === 0) return invalid("bad-txns-vin-empty");
	if (transaction.outputs.length === 0) return invalid("bad-txns-vout-empty");
	if (length > limits.maximumTransactionLengthBytes) return invalid("bad-txns-oversize");
	let total = 0n;
	for (const output of transaction.outputs) {
		if (output.valueSatoshis > MAX_MONEY) return invalid("bad-txns-vout-toolarge");
		total += output.valueSatoshis;
		if (total > MAX_MONEY) return invalid("bad-txns-txouttotal-toolarge");
	}
	return { ok: true };
}

/**
 * BCHN ContextualCheckTransaction after finality: the minimum size and the consensus versions. The
 * mempool re-codes these 64 as it does finality; this answers the consensus code 16.
 */
export function checkContextual(transaction: Transaction, length: number, limits: ConsensusLimits): CheckResult {
	if (length < limits.minimumTransactionLengthBytes) return invalid("bad-txns-undersize");
	if (transaction.version < limits.minimumConsensusVersion || transaction.version > limits.maximumConsensusVersion) {
		return invalid("bad-txns-version");
	}
	return { ok: true };
}

type Token = NonNullable<Output["token"]>;

const MAX_TOKEN_AMOUNT = 2n ** 63n - 1n;

/** BCHN token::OutputData::ToString, which its token refusals quote: id and commitment cut to 30 digits. */
function describeToken(token: Token): string {
	const capability = { none: 0, mutable: 1, minting: 2 }[token.nft?.capability ?? "none"];
	const commitment = token.nft?.commitment ?? new Uint8Array(0);
	const bitfield = (token.amount > 0n ? 0x10 : 0) | (token.nft ? 0x20 : 0) | (commitment.length > 0 ? 0x40 : 0) |
		capability;
	const id = binToHex(token.category).slice(0, 30);
	return `token::OutputData(id=${id}, bitfield=${bitfield.toString(16)}, amount=${token.amount}, ` +
		`commitment=${binToHex(commitment).slice(0, 30)})`;
}

const tokenRefusal = (error: string, debugMessage?: string): CheckResult =>
	debugMessage === undefined
		? { ok: false, code: REJECT_INVALID, error }
		: { ok: false, code: REJECT_INVALID, error, debugMessage };

/**
 * BCHN CheckTxTokens (consensus/tokens.cpp): the inputs' tokens tallied by category, then each output's
 * debited from its category, or credited to a genesis (an input spending output 0 of the transaction
 * whose id is the category), and each non-genesis NFT matched to an immutable, then a mutable, then a
 * minting input. It walks the outputs in order, so the first offending output decides the reason.
 * libauth checks the same rules by category totals and words them its own way.
 */
export function checkTokens(
	transaction: Transaction,
	sourceOutputs: readonly Output[],
	maximumCommitmentLength: number,
): CheckResult {
	const oversized = (token: Token) =>
		tokenRefusal(
			"bad-txns-token-commitment-oversized",
			`CheckTokenData: token ${describeToken(token)} has nft commitment that is oversized ` +
				`${token.nft?.commitment.length}`,
		);
	const genesisIds = new Set(
		transaction.inputs
			.filter((input) => input.outpointIndex === 0)
			.map((input) => binToHex(input.outpointTransactionHash)),
	);
	const inputAmounts = new Map<string, bigint>();
	const mintingIds = new Set<string>();
	const mutables = new Map<string, number>();
	const immutables = new Map<string, number>();
	for (const { token } of sourceOutputs) {
		if (!token) continue;
		if ((token.nft?.commitment.length ?? 0) > maximumCommitmentLength) return oversized(token);
		const id = binToHex(token.category);
		const amount = (inputAmounts.get(id) ?? 0n) + token.amount;
		if (amount > MAX_TOKEN_AMOUNT) return tokenRefusal("bad-txns-token-amount-overflow");
		inputAmounts.set(id, amount);
		if (token.nft?.capability === "none") {
			const key = `${id}:${binToHex(token.nft.commitment)}`;
			immutables.set(key, (immutables.get(key) ?? 0) + 1);
		} else if (token.nft?.capability === "mutable") {
			mutables.set(id, (mutables.get(id) ?? 0) + 1);
		} else if (token.nft?.capability === "minting") {
			mintingIds.add(id);
		}
	}

	const genesisAmounts = new Map<string, bigint>();
	for (const { token } of transaction.outputs) {
		if (!token) continue;
		if ((token.nft?.commitment.length ?? 0) > maximumCommitmentLength) return oversized(token);
		const id = binToHex(token.category);
		const isGenesis = genesisIds.has(id);
		if (isGenesis && inputAmounts.has(id)) {
			const debug = `CheckTxTokens: token ${describeToken(token)} has a duped genesis`;
			return tokenRefusal("bad-txns-token-dupe-genesis", debug);
		}
		if (isGenesis) {
			const amount = (genesisAmounts.get(id) ?? 0n) + token.amount;
			if (amount > MAX_TOKEN_AMOUNT) return tokenRefusal("bad-txns-token-amount-overflow");
			genesisAmounts.set(id, amount);
			continue;
		}
		const available = inputAmounts.get(id);
		if (available === undefined) return tokenRefusal("bad-txns-token-invalid-category");
		inputAmounts.set(id, available - token.amount);
		if (available - token.amount < 0n) {
			return tokenRefusal(
				"bad-txns-token-in-belowout",
				`CheckTxTokens: token (${describeToken(token)}) value in < value out`,
			);
		}
		if (!token.nft) continue;
		const immutableKey = `${id}:${binToHex(token.nft.commitment)}`;
		if (token.nft.capability === "none" && (immutables.get(immutableKey) ?? 0) > 0) {
			immutables.set(immutableKey, (immutables.get(immutableKey) ?? 0) - 1);
		} else if (token.nft.capability !== "minting" && (mutables.get(id) ?? 0) > 0) {
			mutables.set(id, (mutables.get(id) ?? 0) - 1);
		} else if (!mintingIds.has(id)) {
			return tokenRefusal(
				"bad-txns-token-nft-ex-nihilo",
				`CheckTxTokens: token (${describeToken(token)}) nft output cannot be created out of thin air`,
			);
		}
	}
	return { ok: true };
}
