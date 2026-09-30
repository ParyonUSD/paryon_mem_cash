// BCHN's relay policy for a transaction and the coins it spends (policy/policy.cpp IsStandardTx and
// AreInputsStandard), answered with BCHN's reject reasons. libauth's standard VM makes the same checks
// but words them its own way and makes them later, inside script verification, where another refusal
// can win first; these run where BCHN runs them.

import {
	isArbitraryDataOutput,
	isPushOnly,
	isSimpleMultisig,
	isStandardOutputBytecode2023,
	isStandardUtxoBytecode2023,
} from "@bitauth/libauth";
import { REJECT_NONSTANDARD } from "../types/index.js";
import { type CheckResult, getDustThreshold } from "./checks.js";
import type { SourceOutput, Transaction } from "./types.js";

/** The limits of libauth's consensus table the policy reads, overrides applied. */
export interface PolicyLimits {
	readonly minimumConsensusVersion: number;
	readonly maximumConsensusVersion: number;
	readonly maximumStandardTransactionSize: number;
	readonly maximumStandardUnlockingBytecodeLength: number;
	/** -1 before 2026: only the standard templates are standard. From 2026 any script up to this length. */
	readonly maximumStandardLockingBytecodeLength: number;
	readonly maximumDataCarrierBytes: number;
}

const nonstandard = (error: string): CheckResult => ({ ok: false, code: REJECT_NONSTANDARD, error });

function isStandardOutput(lockingBytecode: Uint8Array, limits: PolicyLimits): boolean {
	const { maximumStandardLockingBytecodeLength: maximum } = limits;
	if (maximum === -1) return isStandardOutputBytecode2023(lockingBytecode);
	return lockingBytecode.length <= maximum || isArbitraryDataOutput(lockingBytecode);
}

/** BCHN IsStandardTx, in its order; each refusal is REJECT_NONSTANDARD with BCHN's reason. */
export function checkStandardTransaction(
	transaction: Transaction,
	length: number,
	limits: PolicyLimits,
	dustRelayFeePerKb: bigint,
): CheckResult {
	if (transaction.version < limits.minimumConsensusVersion || transaction.version > limits.maximumConsensusVersion) {
		return nonstandard("version");
	}
	if (length > limits.maximumStandardTransactionSize) return nonstandard("tx-size");
	for (const input of transaction.inputs) {
		if (input.unlockingBytecode.length > limits.maximumStandardUnlockingBytecodeLength) {
			return nonstandard("scriptsig-size");
		}
		if (!isPushOnly(input.unlockingBytecode)) return nonstandard("scriptsig-not-pushonly");
	}
	// BCHN sums the whole script of every data carrier output, OP_RETURN included
	let dataCarrierBytes = 0;
	for (const output of transaction.outputs) {
		if (!isStandardOutput(output.lockingBytecode, limits)) return nonstandard("scriptpubkey");
		if (isArbitraryDataOutput(output.lockingBytecode)) {
			dataCarrierBytes += output.lockingBytecode.length;
		} else if (output.valueSatoshis < getDustThreshold(output, dustRelayFeePerKb)) {
			return nonstandard("dust");
		}
	}
	if (dataCarrierBytes > limits.maximumDataCarrierBytes) return nonstandard("oversize-op-return");
	return { ok: true };
}

/** BCHN AreInputsStandard: every coin spent matches a standard template. */
export function checkInputsStandard(sourceOutputs: readonly SourceOutput[], limits: PolicyLimits): CheckResult {
	const { maximumStandardLockingBytecodeLength: maximum } = limits;
	for (const { lockingBytecode } of sourceOutputs) {
		const standard = maximum === -1
			? isStandardUtxoBytecode2023(lockingBytecode)
			: lockingBytecode.length <= maximum || isSimpleMultisig(lockingBytecode) !== false;
		if (!standard) return nonstandard("bad-txns-nonstandard-inputs");
	}
	return { ok: true };
}
