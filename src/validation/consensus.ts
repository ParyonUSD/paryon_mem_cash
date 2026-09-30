// BCHN's consensus checks of a transaction on its own (consensus/tx_check.cpp CheckTransactionCommon) and
// in the context of the next block (consensus/tx_verify.cpp ContextualCheckTransaction), with BCHN's
// reject reasons. libauth's VM makes them too, but last and in its own words; these run where BCHN runs
// them, before the inputs are looked up.

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
