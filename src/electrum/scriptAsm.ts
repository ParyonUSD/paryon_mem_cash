// A script as BCHN's getrawtransaction describes it, which Fulcrum passes on for a verbose
// blockchain.transaction.get: its asm (core_write.cpp ScriptToAsmStr), and for a locking script the type
// and addresses Solver and ExtractDestinations find (ScriptPubKeyToUniv).

import {
	binToHex,
	hash160,
	isPayToPublicKey,
	isPayToPublicKeyHash,
	isPayToScriptHash20,
	isPayToScriptHash32,
	isPushOnly,
	isSimpleMultisig,
	isValidSignatureEncodingDER,
	lockingBytecodeToCashAddress,
	OpcodesBch2023,
} from "@bitauth/libauth";

const OP_PUSHDATA1 = 0x4c;
const OP_PUSHDATA2 = 0x4d;
const OP_PUSHDATA4 = 0x4e;
const OP_RETURN = 0x6a;
/** CScriptNum::MAXIMUM_ELEMENT_SIZE_64_BIT: a push this short reads as a number. */
const MAX_SCRIPT_NUM_SIZE = 8;

/** BCHN's names for the sighash types a signature may carry (core_write.cpp mapSigHashTypes). */
const SIGHASH_NAMES = new Map<number, string>();
for (const [base, name] of [[1, "ALL"], [2, "NONE"], [3, "SINGLE"]] as const) {
	for (const [flags, suffix] of [[0, ""], [0x80, "|ANYONECANPAY"], [0x20, "|UTXOS"]] as const) {
		SIGHASH_NAMES.set(base | flags, `${name}${suffix}`);
		SIGHASH_NAMES.set(base | 0x40 | flags, `${name}|FORKID${suffix}`);
	}
}

/** BCHN GetOpName, which names OP_0 to OP_16 by their number. libauth's names are BCHN's otherwise. */
function opName(opcode: number): string {
	if (opcode === 0x4f) return "-1";
	if (opcode >= 0x51 && opcode <= 0x60) return String(opcode - 0x50);
	const name = OpcodesBch2023[opcode] ?? "OP_UNKNOWN";
	return name.startsWith("OP_UNKNOWN") ? "OP_UNKNOWN" : name;
}

/** CScriptNum: little-endian, the top bit of the last byte the sign. */
function scriptNum(bytes: Uint8Array): bigint {
	if (bytes.length === 0) return 0n;
	let value = 0n;
	bytes.forEach((byte, i) => {
		value |= BigInt(i === bytes.length - 1 ? byte & 0x7f : byte) << BigInt(8 * i);
	});
	return (bytes[bytes.length - 1] ?? 0) & 0x80 ? -value : value;
}

/** A signature's sighash type, as ScriptToAsmStr appends it: only for an encoding a signature can have. */
function sighashSuffix(push: Uint8Array): string | undefined {
	const name = SIGHASH_NAMES.get(push[push.length - 1] ?? 0);
	if (name === undefined) return undefined;
	const signature = push.slice(0, -1);
	return signature.length === 64 || isValidSignatureEncodingDER(signature) ? `[${name}]` : undefined;
}

/**
 * BCHN ScriptToAsmStr: pushes of up to 8 bytes as numbers, longer ones as hex (a signature in an unlocking
 * script with its sighash type named), other operations by name, and "[error]" where the script stops
 * being readable.
 */
export function scriptToAsm(script: Uint8Array, attemptSighashDecode: boolean): string {
	const parts: string[] = [];
	const unspendable = script[0] === OP_RETURN;
	let pc = 0;
	while (pc < script.length) {
		const opcode = script[pc++] as number;
		if (opcode > OP_PUSHDATA4) {
			parts.push(opName(opcode));
			continue;
		}
		const lengthBytes = opcode === OP_PUSHDATA1 ? 1 : opcode === OP_PUSHDATA2 ? 2 : opcode === OP_PUSHDATA4 ? 4 : 0;
		if (pc + lengthBytes > script.length) return [...parts, "[error]"].join(" ");
		let length = lengthBytes === 0 ? opcode : 0;
		for (let i = 0; i < lengthBytes; i++) length += (script[pc + i] as number) * 256 ** i;
		pc += lengthBytes;
		if (pc + length > script.length) return [...parts, "[error]"].join(" ");
		const push = script.slice(pc, pc + length);
		pc += length;
		if (push.length <= MAX_SCRIPT_NUM_SIZE) {
			parts.push(scriptNum(push).toString());
		} else {
			const suffix = attemptSighashDecode && !unspendable ? sighashSuffix(push) : undefined;
			parts.push(suffix === undefined ? binToHex(push) : `${binToHex(push.slice(0, -1))}${suffix}`);
		}
	}
	return parts.join(" ");
}

/** The fields of a locking script BCHN's ScriptPubKeyToUniv gives besides asm and hex. */
export interface LockingScriptDescription {
	readonly type: string;
	/** Present only where BCHN extracts destinations: not for nulldata or a nonstandard script. */
	readonly reqSigs?: number;
	readonly addresses?: string[];
}

/** Solver's type and ExtractDestinations' addresses, a public key's as its P2PKH address. */
export function describeLockingScript(script: Uint8Array, prefix: string | undefined): LockingScriptDescription {
	const address = (bytecode: Uint8Array) => {
		const result = lockingBytecodeToCashAddress(
			prefix ? { bytecode, prefix: prefix as "bitcoincash" } : { bytecode },
		);
		return typeof result === "string" ? result : result.address;
	};
	const p2pkh = (publicKey: Uint8Array) =>
		address(Uint8Array.of(0x76, 0xa9, 0x14, ...hash160(publicKey), 0x88, 0xac));

	if (isPayToPublicKeyHash(script)) return { type: "pubkeyhash", reqSigs: 1, addresses: [address(script)] };
	if (isPayToScriptHash20(script) || isPayToScriptHash32(script)) {
		return { type: "scripthash", reqSigs: 1, addresses: [address(script)] };
	}
	if (isPayToPublicKey(script)) return { type: "pubkey", reqSigs: 1, addresses: [p2pkh(script.slice(1, -1))] };
	const multisig = isSimpleMultisig(script);
	if (multisig !== false) {
		return { type: "multisig", reqSigs: multisig.m, addresses: multisig.publicKeys.map(p2pkh) };
	}
	if (script[0] === OP_RETURN && isPushOnly(script.slice(1))) return { type: "nulldata" };
	return { type: "nonstandard" };
}
