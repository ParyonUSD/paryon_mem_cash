import {
	binToHex,
	conditionallyEvaluate,
	createVirtualMachine,
	createVirtualMachineBch2023,
	createVirtualMachineBch2025,
	createVirtualMachineBch2026,
	createVirtualMachineBchSpec,
	decodeTransactionBch,
	encodeTransactionBch,
	hashTransactionUiOrder,
	hexToBin,
	pushToStackChecked,
	pushToStackVmNumber,
	ripemd160,
	secp256k1,
	sha1,
	sha256,
	useTransactionOutput,
	useTransactionUtxo,
	type Output,
} from "@bitauth/libauth";
import { ConsensusBch2023 } from "@bitauth/libauth/build/lib/vm/instruction-sets/bch/2023/bch-2023-consensus.js";
import { ConsensusBch2025 } from "@bitauth/libauth/build/lib/vm/instruction-sets/bch/2025/bch-2025-consensus.js";
import { ConsensusBch2026 } from "@bitauth/libauth/build/lib/vm/instruction-sets/bch/2026/bch-2026-consensus.js";
import { ConsensusBchSpec } from "@bitauth/libauth/build/lib/vm/instruction-sets/bch/spec/bch-spec-consensus.js";
import { createInstructionSetBch2023 } from "@bitauth/libauth/build/lib/vm/instruction-sets/bch/2023/bch-2023-instruction-set.js";
import { createInstructionSetBch2025 } from "@bitauth/libauth/build/lib/vm/instruction-sets/bch/2025/bch-2025-instruction-set.js";
import { createInstructionSetBch2026 } from "@bitauth/libauth/build/lib/vm/instruction-sets/bch/2026/bch-2026-instruction-set.js";
import { createInstructionSetBchSpec } from "@bitauth/libauth/build/lib/vm/instruction-sets/bch/spec/bch-spec-instruction-set.js";
import { OpcodesBch2023 } from "@bitauth/libauth/build/lib/vm/instruction-sets/bch/2023/bch-2023-opcodes.js";
import {
	createOpActiveBytecode,
	createOpInputBytecode,
	createOpOutputBytecode,
	createOpUtxoBytecode,
} from "@bitauth/libauth/build/lib/vm/instruction-sets/common/inspection.js";
import { REJECT_INVALID, REJECT_MALFORMED, REJECT_NONSTANDARD } from "../types/index.js";
import {
	checkAbsurdFee,
	checkCoinbaseMaturity,
	checkDustOutputs,
	checkInputValueRanges,
	checkLocktimeFinality,
	checkMinRelayFee,
	checkNullPrevout,
	checkSequenceLocks,
	checkUnspendableInputs,
} from "./checks.js";
import {
	DEFAULT_MAX_FEE,
	DEFAULT_MIN_RELAY_FEE_PER_KB,
	DUST_RELAY_FEE_PER_KB,
	MAX_MONEY,
} from "./constants.js";
import type {
	ChainState,
	ConsensusOverrides,
	DebugInputResult,
	DebugResult,
	SourceOutput,
	Transaction,
	TxVerifier,
	TxVerifierConfig,
	ValidatedTransaction,
	VerifyResult,
	VmVersion,
} from "./types.js";

/** VM abstraction to unify the different version-specific types. */
export interface VmFacade {
	verify(resolved: { sourceOutputs: Output[]; transaction: unknown }): true | string;
	debugInput(program: { inputIndex: number; sourceOutputs: Output[]; transaction: unknown }): {
		success: boolean;
		error?: string;
	};
}

/** Create a libauth VM for the given version. */
export function createVmFacade(
	version: VmVersion,
	standard: boolean,
	consensusOverrides?: ConsensusOverrides,
): VmFacade {
	if (consensusOverrides === undefined) {
		switch (version) {
			case "BCH_2023_05":
				return facade(createVirtualMachineBch2023(standard));
			case "BCH_2025_05":
				return facade(createVirtualMachineBch2025(standard));
			case "BCH_2026_05":
				return facade(createVirtualMachineBch2026(standard));
			case "BCH_SPEC":
				return facade(
					createVirtualMachineBchSpec(standard) as unknown as ReturnType<typeof createVirtualMachineBch2025>,
				);
		}
	}
	const crypto = { ripemd160, secp256k1, sha1, sha256 };
	const instructionSet = (() => {
		switch (version) {
			case "BCH_2023_05": return createInstructionSetBch2023(standard, { ...crypto, consensus: { ...ConsensusBch2023, ...consensusOverrides } } as never);
			case "BCH_2025_05": return createInstructionSetBch2025(standard, { ...crypto, consensus: { ...ConsensusBch2025, ...consensusOverrides } } as never);
			case "BCH_2026_05": return createInstructionSetBch2026(standard, { ...crypto, consensus: { ...ConsensusBch2026, ...consensusOverrides } } as never);
			case "BCH_SPEC": return createInstructionSetBchSpec(standard, { ...crypto, consensus: { ...ConsensusBchSpec, ...consensusOverrides } } as never);
		}
	})();
	const maximumStackItemLength = consensusOverrides.maximumStackItemLength;
	if (maximumStackItemLength !== undefined) {
		// The operations table is a union of the spec and the common instruction sets' state types, and
		// these rebuilt operations go into it for every VM version, so no narrower type fits all of them.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		type State = any;
		const pushCommitment = (state: State, output: { token?: { nft?: { commitment: Uint8Array } } }) => (
			output.token?.nft === undefined
				? pushToStackVmNumber(state, 0n)
				: pushToStackChecked(state, output.token.nft.commitment, { maximumStackItemLength })
		);
		instructionSet.operations[OpcodesBch2023.OP_UTXOTOKENCOMMITMENT] = conditionallyEvaluate(
			(state: State) => useTransactionUtxo(state, (nextState, [utxo]) => pushCommitment(nextState, utxo)),
		);
		instructionSet.operations[OpcodesBch2023.OP_OUTPUTTOKENCOMMITMENT] = conditionallyEvaluate(
			(state: State) => useTransactionOutput(state, (nextState, [output]) => pushCommitment(nextState, output)),
		);
		// Libauth's inspection operations capture ConsensusCommon.maximumStackItemLength when the instruction set
		// is created, so merging a consensus override is insufficient for bytecode values returned at runtime.
		// Rebuild each bytecode-pushing operation with the requested limit, matching the token-commitment overrides.
		instructionSet.operations[OpcodesBch2023.OP_ACTIVEBYTECODE] = conditionallyEvaluate(
			createOpActiveBytecode({ maximumStackItemLength }) as (state: State) => State,
		);
		instructionSet.operations[OpcodesBch2023.OP_UTXOBYTECODE] = conditionallyEvaluate(
			createOpUtxoBytecode({ maximumStackItemLength }) as (state: State) => State,
		);
		instructionSet.operations[OpcodesBch2023.OP_INPUTBYTECODE] = conditionallyEvaluate(
			createOpInputBytecode({ maximumStackItemLength }) as (state: State) => State,
		);
		instructionSet.operations[OpcodesBch2023.OP_OUTPUTBYTECODE] = conditionallyEvaluate(
			createOpOutputBytecode({ maximumStackItemLength }) as (state: State) => State,
		);
	}
	return facade(createVirtualMachine(instructionSet as never));
}

function facade(vm: ReturnType<typeof createVirtualMachineBch2025>): VmFacade {
	return {
		verify(resolved) {
			return vm.verify(resolved as Parameters<typeof vm.verify>[0]);
		},
		debugInput(program) {
			const debugTrace = vm.debug(program as Parameters<typeof vm.debug>[0]);
			const keys = Object.keys(debugTrace);
			const stateCount = keys.length;
			if (stateCount === 0) {
				return { success: false, error: "No execution states produced" };
			}
			const lastState = (debugTrace as Record<number, unknown>)[stateCount - 1];
			const stateResult = (vm.stateSuccess as (state: unknown) => true | string)(lastState);
			if (stateResult === true) {
				return { success: true };
			}
			return { success: false, error: stateResult };
		},
	};
}

/** Strip consensus metadata from SourceOutput[], keeping only libauth Output fields. */
function toVmOutputs(sourceOutputs: readonly SourceOutput[]): Output[] {
	return sourceOutputs.map((so) => {
		const output: Output = {
			lockingBytecode: so.lockingBytecode,
			valueSatoshis: so.valueSatoshis,
		};
		if (so.token) {
			(output as { token: NonNullable<Output["token"]> }).token = so.token;
		}
		return output;
	});
}

/** Pipeline failure with BCHN reject code. */
interface PipelineFailure {
	ok: false;
	code: number;
	error: string;
	debugMessage?: string;
}

/** Pipeline success. */
interface PipelineSuccess {
	ok: true;
	decoded: Transaction;
	txid: string;
	encodedBytes: Uint8Array;
	fee: bigint;
}

type PipelineResult = PipelineSuccess | PipelineFailure;

/**
 * Create a stateless transaction verifier.
 * All context (source outputs, chain state) is provided per call.
 *
 * Pipeline order (matching BCHN AcceptToMemoryPool):
 *  1. Decode tx hex
 *  2. Null prevout check
 *  3. Validate sourceOutputs length
 *  4. Locktime finality check
 *  5. Coinbase maturity check
 *  6. Unspendable inputs check
 *  7. Input value ranges check
 *  8. Compute fee
 *  9. BIP68 sequence locks check
 * 10. Min relay fee check (policy, before VM)
 * 11. Absurd fee guard (policy, before VM)
 * 12. Dust output check (policy, standard only)
 * 13. VM verify (most expensive — last)
 * 14. Build ValidatedTransaction
 */
export function createTxVerifier(config?: TxVerifierConfig): TxVerifier {
	const version = config?.vmVersion ?? "BCH_2025_05";
	const standard = config?.standard ?? true;
	const minRelayFeePerKb = config?.minRelayFeePerKb ?? DEFAULT_MIN_RELAY_FEE_PER_KB;
	const maxFee = config?.maxFee ?? DEFAULT_MAX_FEE;
	const skipFeePolicy = config?.skipFeePolicy ?? false;
	const dustRelayFeePerKb = config?.dustRelayFeePerKb ?? DUST_RELAY_FEE_PER_KB;
	if (minRelayFeePerKb <= 0n) {
		throw new Error("minRelayFeePerKb must be positive");
	}
	if (maxFee <= 0n) {
		throw new Error("maxFee must be positive");
	}
	for (const [name, value] of Object.entries(config?.consensus ?? {})) {
		if (!Number.isSafeInteger(value) || value <= 0) {
			throw new Error(`consensus.${name} must be a positive safe integer`);
		}
	}
	const vm = createVmFacade(version, standard, config?.consensus);
	// Consensus-only VM for two-pass script verification (BCHN CheckInputs pattern).
	// When standard=true, a script failure is re-checked with consensus-only flags to
	// distinguish mandatory vs non-mandatory violations.
	const consensusVm = standard ? createVmFacade(version, false, config?.consensus) : null;

	/** Run pre-VM pipeline steps 1-12. Returns validated data or error. */
	function preVmPipeline(
		rawHex: string,
		sourceOutputs: readonly SourceOutput[],
		chainState: ChainState,
	): PipelineResult {
		const spendHeight = chainState.height + 1;

		// 1. Decode tx hex
		const rawBytes = hexToBin(rawHex);
		const decoded = decodeTransactionBch(rawBytes);
		if (typeof decoded === "string") {
			return {
				ok: false,
				code: REJECT_MALFORMED,
				error: "TX decode failed",
				debugMessage: decoded,
			};
		}

		// 2. Null prevout check
		const prevoutInputs = decoded.inputs.map((inp) => ({
			txid: binToHex(inp.outpointTransactionHash),
			vout: inp.outpointIndex,
		}));
		const nullCheck = checkNullPrevout(prevoutInputs);
		if (!nullCheck.ok) return nullCheck;

		// 3. Validate sourceOutputs count matches inputs
		if (sourceOutputs.length !== decoded.inputs.length) {
			return {
				ok: false,
				code: REJECT_INVALID,
				error: "bad-txns-inputs-missingorspent",
				debugMessage: `sourceOutputs length (${sourceOutputs.length}) does not match inputs length (${decoded.inputs.length})`,
			};
		}

		// 4. Locktime finality check
		const locktimeCheck = checkLocktimeFinality(
			decoded.locktime,
			decoded.inputs,
			spendHeight,
			chainState.medianTimePast,
		);
		// The mempool refuses a transaction that is not final yet as non-standard (64), not invalid: it may
		// be valid in a later block (BCHN AcceptToMemoryPoolWorker re-codes ContextualCheckTransaction's)
		if (!locktimeCheck.ok) return { ...locktimeCheck, code: REJECT_NONSTANDARD };

		// Re-encode to get canonical bytes for size and txid
		const encodedBytes = encodeTransactionBch(decoded);
		const txid = binToHex(hashTransactionUiOrder(encodedBytes));

		// 5. Coinbase maturity check
		const maturityCheck = checkCoinbaseMaturity(
			sourceOutputs.map((so) => ({
				isCoinbase: so.isCoinbase,
				height: so.height ?? 1,
			})),
			spendHeight,
		);
		if (!maturityCheck.ok) return maturityCheck;

		// 6. Unspendable inputs check
		const unspendableCheck = checkUnspendableInputs(sourceOutputs);
		if (!unspendableCheck.ok) return unspendableCheck;

		// 7. Input value ranges check
		const valueCheck = checkInputValueRanges(sourceOutputs.map((so) => so.valueSatoshis));
		if (!valueCheck.ok) return valueCheck;

		// 8. Compute fee (validate output values first)
		let inputSum = 0n;
		for (const so of sourceOutputs) {
			inputSum += so.valueSatoshis;
		}
		let outputSum = 0n;
		for (const output of decoded.outputs) {
			if (output.valueSatoshis < 0n || output.valueSatoshis > MAX_MONEY) {
				return {
					ok: false,
					code: REJECT_INVALID,
					error: "bad-txns-outputvalues-outofrange",
				};
			}
			outputSum += output.valueSatoshis;
			if (outputSum > MAX_MONEY) {
				return {
					ok: false,
					code: REJECT_INVALID,
					error: "bad-txns-outputvalues-outofrange",
				};
			}
		}
		const fee = inputSum - outputSum;
		if (fee < 0n) {
			return {
				ok: false,
				code: REJECT_INVALID,
				error: "bad-txns-in-belowout",
				debugMessage: `value in (${inputSum}) < value out (${outputSum})`,
			};
		}

		// 9. BIP68 sequence locks check
		const seqCheck = checkSequenceLocks(
			decoded.version,
			sourceOutputs.map((so, idx) => {
				// A mempool coin (height 0) counts as confirmed in the next block, as BCHN's CheckSequenceLocks
				// takes it, so a relative height lock on an unconfirmed parent is not final yet
				const input: { sequenceNumber: number; height: number; medianTimePast?: number } = {
					sequenceNumber: decoded.inputs[idx]?.sequenceNumber ?? 0xffffffff,
					height: so.height === 0 ? spendHeight : (so.height ?? 1),
				};
				if (so.medianTimePast != null) input.medianTimePast = so.medianTimePast;
				return input;
			}),
			spendHeight,
			chainState.medianTimePast,
		);
		if (!seqCheck.ok) return seqCheck;

		// 10-11. Fee policy checks (min-relay + absurd-fee). Skipped for unfunded txs.
		if (!skipFeePolicy) {
			const size = encodedBytes.length;
			const feeCheck = checkMinRelayFee(fee, size, minRelayFeePerKb);
			if (!feeCheck.ok) return feeCheck;

			const absurdCheck = checkAbsurdFee(fee, maxFee);
			if (!absurdCheck.ok) return absurdCheck;
		}

		// 12. Dust output check (policy, matches BCHN IsStandardTx). Uses the fixed dust relay fee.
		if (standard) {
			const dustCheck = checkDustOutputs(decoded.outputs, dustRelayFeePerKb);
			if (!dustCheck.ok) return dustCheck;
		}

		return { ok: true, decoded, txid, encodedBytes, fee };
	}

	/**
	 * Classify a VM script error as mandatory or non-mandatory by re-checking
	 * with the consensus-only VM (BCHN CheckInputs two-pass pattern).
	 */
	function classifyScriptError(
		primaryError: string,
		consensusCheck: () => true | string,
	): { code: number; error: string } {
		if (consensusVm) {
			const consensusResult = consensusCheck();
			if (consensusResult === true) {
				return {
					code: REJECT_NONSTANDARD,
					error: `non-mandatory-script-verify-flag (${primaryError})`,
				};
			}
			return {
				code: REJECT_INVALID,
				error: `mandatory-script-verify-flag-failed (${consensusResult})`,
			};
		}
		return {
			code: REJECT_INVALID,
			error: `mandatory-script-verify-flag-failed (${primaryError})`,
		};
	}

	/** Convert a pipeline failure to a result failure, avoiding undefined in optional fields. */
	function pipelineToFailure(f: PipelineFailure): {
		success: false;
		code: number;
		error: string;
		debugMessage?: string;
	} {
		const result: { success: false; code: number; error: string; debugMessage?: string } = {
			success: false,
			code: f.code,
			error: f.error,
		};
		if (f.debugMessage != null) result.debugMessage = f.debugMessage;
		return result;
	}

	function verify(
		rawHex: string,
		sourceOutputs: readonly SourceOutput[],
		chainState: ChainState,
	): VerifyResult {
		const pipeline = preVmPipeline(rawHex, sourceOutputs, chainState);
		if (!pipeline.ok) return pipelineToFailure(pipeline);

		const { decoded, txid, encodedBytes, fee } = pipeline;

		// 13. VM verify (most expensive — last)
		const vmOutputs = toVmOutputs(sourceOutputs);
		const verifyResult = vm.verify({ sourceOutputs: vmOutputs, transaction: decoded });
		if (verifyResult !== true) {
			const { code, error } = classifyScriptError(verifyResult, () =>
				consensusVm
					? consensusVm.verify({ sourceOutputs: vmOutputs, transaction: decoded })
					: verifyResult,
			);
			return { success: false, code, error };
		}

		// 14. Build ValidatedTransaction
		const size = encodedBytes.length;
		const validatedTx: ValidatedTransaction = {
			txid,
			rawHex,
			fee,
			size,
			transaction: decoded,
			sourceOutputs,
		};

		return { success: true, txid, fee, size, validatedTx };
	}

	function debug(
		rawHex: string,
		sourceOutputs: readonly SourceOutput[],
		chainState: ChainState,
	): DebugResult {
		const pipeline = preVmPipeline(rawHex, sourceOutputs, chainState);
		if (!pipeline.ok) return pipelineToFailure(pipeline);

		const { decoded, txid, encodedBytes, fee } = pipeline;
		const vmOutputs = toVmOutputs(sourceOutputs);

		// 13. Debug each input individually
		const inputResults: DebugInputResult[] = [];
		for (let i = 0; i < decoded.inputs.length; i++) {
			try {
				const result = vm.debugInput({
					inputIndex: i,
					sourceOutputs: vmOutputs,
					transaction: decoded,
				});

				if (result.success) {
					inputResults.push({ inputIndex: i, success: true });
				} else {
					const scriptError = result.error ?? "Script evaluation failed";
					inputResults.push({ inputIndex: i, success: false, error: scriptError });
					const { code, error } = classifyScriptError(scriptError, () =>
						consensusVm
							? (() => {
									const r = consensusVm.debugInput({
										inputIndex: i,
										sourceOutputs: vmOutputs,
										transaction: decoded,
									});
									return r.success ? true : (r.error ?? scriptError);
								})()
							: scriptError,
					);
					return { success: false as const, code, error, inputResults };
				}
			} catch (e: unknown) {
				const errorMsg = e instanceof Error ? e.message : "Unknown VM error";
				inputResults.push({ inputIndex: i, success: false, error: errorMsg });
				return {
					success: false as const,
					code: REJECT_INVALID,
					error: `mandatory-script-verify-flag-failed (${errorMsg})`,
					inputResults,
				};
			}
		}

		const verifyResult = vm.verify({ sourceOutputs: vmOutputs, transaction: decoded });
		if (verifyResult !== true) {
			const { code, error } = classifyScriptError(verifyResult, () =>
				consensusVm
					? consensusVm.verify({ sourceOutputs: vmOutputs, transaction: decoded })
					: verifyResult,
			);
			return { success: false, code, error, inputResults };
		}

		// 14. Build ValidatedTransaction
		const size = encodedBytes.length;
		const validatedTx: ValidatedTransaction = {
			txid,
			rawHex,
			fee,
			size,
			transaction: decoded,
			sourceOutputs,
		};

		return { success: true, txid, fee, size, validatedTx, inputResults };
	}

	return { verify, debug };
}
