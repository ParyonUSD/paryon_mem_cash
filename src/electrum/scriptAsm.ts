// A script as BCHN's getrawtransaction describes it, which Fulcrum passes on for a verbose
// blockchain.transaction.get: its asm (core_write.cpp ScriptToAsmStr), and for a locking script the type
// and addresses Solver and ExtractDestinations find (ScriptPubKeyToUniv).

import {
	binToHex,
	hash160,
	isPayToPublicKeyHash,
	isPayToScriptHash20,
	isPayToScriptHash32,
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
	/** Present only where BCHN extracts destinations: not for nulldata, pay-to-script or a nonstandard script. */
	readonly reqSigs?: number;
	readonly addresses?: string[];
}

/** MAX_P2S_SCRIPT_SIZE: since the May 2026 upgrade, any other locking script this short is pay-to-script. */
const MAX_P2S_SCRIPT_SIZE = 201;
const OP_1 = 0x51;
const OP_16 = 0x60;
const OP_CHECKSIG = 0xac;
const OP_CHECKMULTISIG = 0xae;

/** CScript::GetOp: the operation at `pc`, with its push data, or undefined where the script is truncated. */
function getOp(script: Uint8Array, pc: number): { opcode: number; data: Uint8Array; next: number } | undefined {
	const opcode = script[pc] as number;
	let at = pc + 1;
	if (opcode > OP_PUSHDATA4) return { opcode, data: new Uint8Array(), next: at };
	const lengthBytes = opcode === OP_PUSHDATA1 ? 1 : opcode === OP_PUSHDATA2 ? 2 : opcode === OP_PUSHDATA4 ? 4 : 0;
	if (at + lengthBytes > script.length) return undefined;
	let length = lengthBytes === 0 ? opcode : 0;
	for (let i = 0; i < lengthBytes; i++) length += (script[at + i] as number) * 256 ** i;
	at += lengthBytes;
	if (at + length > script.length) return undefined;
	return { opcode, data: script.slice(at, at + length), next: at + length };
}

/** CScript::IsPushOnly: readable to the end, and no operation above OP_16. */
function isPushOnlyFrom(script: Uint8Array, pc: number): boolean {
	while (pc < script.length) {
		const op = getOp(script, pc);
		if (op === undefined || op.opcode > OP_16) return false;
		pc = op.next;
	}
	return true;
}

/**
 * CPubKey::ValidSize: 33 bytes behind a 02 or 03, 65 behind a 04, 06 or 07. BCHN matches a key only if it
 * passes, which is also what CPubKey::IsValid checks before extracting an address, so every key a
 * template matched has one. libauth's isPayToPublicKey does not look at the first byte.
 */
function isValidKeySize(key: Uint8Array): boolean {
	const header = key[0];
	if (header === 2 || header === 3) return key.length === 33;
	if (header === 4 || header === 6 || header === 7) return key.length === 65;
	return false;
}

/** MatchPayToPubkey: a 65- or 33-byte key pushed directly, then OP_CHECKSIG. */
function matchPayToPubkey(script: Uint8Array): Uint8Array | undefined {
	const size = script.length - 2;
	if (size !== 65 && size !== 33) return undefined;
	if (script[0] !== size || script[script.length - 1] !== OP_CHECKSIG) return undefined;
	const key = script.slice(1, -1);
	return isValidKeySize(key) ? key : undefined;
}

/**
 * MatchMultisig: OP_m, keys pushed minimally, OP_n, OP_CHECKMULTISIG, with n the number of keys and
 * m at most n. libauth's isSimpleMultisig allowed an m above n.
 */
function matchMultisig(script: Uint8Array): { required: number; keys: Uint8Array[] } | undefined {
	if (script[script.length - 1] !== OP_CHECKMULTISIG) return undefined;
	const first = getOp(script, 0);
	if (first === undefined || first.opcode < OP_1 || first.opcode > OP_16) return undefined;
	const required = first.opcode - 0x50;
	const keys: Uint8Array[] = [];
	let op = getOp(script, first.next);
	while (op !== undefined && isValidKeySize(op.data)) {
		// A key's minimal push is the direct push of its length
		if (op.opcode !== op.data.length) return undefined;
		keys.push(op.data);
		op = op.next < script.length ? getOp(script, op.next) : undefined;
	}
	if (op === undefined || op.opcode < OP_1 || op.opcode > OP_16) return undefined;
	if (keys.length !== op.opcode - 0x50 || keys.length < required) return undefined;
	return op.next + 1 === script.length ? { required, keys } : undefined;
}

/**
 * Solver's type and ExtractDestinations' addresses, a public key's as its P2PKH address, with the flags
 * ScriptPubKeyToUniv passes (P2SH32 and the May 2026 upgrade on), in Solver's order.
 */
export function describeLockingScript(script: Uint8Array, prefix: string | undefined): LockingScriptDescription {
	const address = (bytecode: Uint8Array) => {
		const result = lockingBytecodeToCashAddress(
			prefix ? { bytecode, prefix: prefix as "bitcoincash" } : { bytecode },
		);
		return typeof result === "string" ? result : result.address;
	};
	const p2pkh = (publicKey: Uint8Array) =>
		address(Uint8Array.of(0x76, 0xa9, 0x14, ...hash160(publicKey), 0x88, 0xac));

	if (isPayToScriptHash20(script) || isPayToScriptHash32(script)) {
		return { type: "scripthash", reqSigs: 1, addresses: [address(script)] };
	}
	if (script[0] === OP_RETURN && isPushOnlyFrom(script, 1)) return { type: "nulldata" };
	const publicKey = matchPayToPubkey(script);
	if (publicKey !== undefined) return { type: "pubkey", reqSigs: 1, addresses: [p2pkh(publicKey)] };
	if (isPayToPublicKeyHash(script)) return { type: "pubkeyhash", reqSigs: 1, addresses: [address(script)] };
	const multisig = matchMultisig(script);
	if (multisig !== undefined) {
		return { type: "multisig", reqSigs: multisig.required, addresses: multisig.keys.map(p2pkh) };
	}
	// Pay-to-script has no address: "p2s txns have no address" (ExtractDestination)
	return { type: script.length <= MAX_P2S_SCRIPT_SIZE ? "script" : "nonstandard" };
}
