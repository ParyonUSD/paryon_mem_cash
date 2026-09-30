# src/validation

Formerly `@mem-cash/validation`; exported from `@paryonusd/mem-cash/validation` on its own, and from `@paryonusd/mem-cash`.

Stateless transaction evaluator for Bitcoin Cash. Validates raw transaction hex against consensus rules, policy checks, and libauth VM script verification.

## Usage

```typescript
import { createTxVerifier } from "@paryonusd/mem-cash/validation";

const verifier = await createTxVerifier({
  vmVersion: "BCH_2025_05",
  standard: true,
});

const result = verifier.verify(rawHex, sourceOutputs, chainState);
if (result.success) {
  console.log(result.txid, result.fee, result.validatedTx);
} else {
  console.log(result.code, result.error); // BCHN reject code + reason
}
```

Private and test networks may override libauth consensus limits without changing production defaults:

```typescript
const verifier = createTxVerifier({
  vmVersion: "BCH_2026_05",
  consensus: {
    maximumBytecodeLength: 1_000_000,
    maximumStackItemLength: 1_000_000,
    maximumTransactionLengthBytes: 10_000_000,
  },
});
```

## Verification Pipeline

Matches BCHN's `AcceptToMemoryPoolWorker` order (the fork's; upstream's order and words differed, see
the fork's CHANGELOG):

1. Decode transaction hex (`TX decode failed`)
2. `CheckRegularTransaction`: `bad-txns-vin-empty`, `bad-txns-vout-empty`, `bad-txns-oversize`,
   `bad-txns-vout-toolarge`, `bad-txns-txouttotal-toolarge`, `bad-txns-prevout-null`,
   `bad-txns-inputs-duplicate`
3. `IsStandardTx` (standard only): `version`, `tx-size`, `scriptsig-size`, `scriptsig-not-pushonly`,
   `scriptpubkey`, `dust`, `oversize-op-return`
4. Locktime finality (`bad-txns-nonfinal`), then `bad-txns-undersize` and `bad-txns-version`, all code 64
   as the mempool re-codes them

   Steps 1 to 4 need no source outputs: `checkBeforeInputs` runs them alone, and the node runs it before
   it looks the inputs up, so they win over a conflict or a missing input.
5. Validate sourceOutputs count matches inputs (`bad-txns-inputs-missingorspent`)
6. BIP68 sequence locks (`non-BIP68-final`), height and time based
7. `CheckTxInputs`: `bad-txns-premature-spend-of-coinbase`, `bad-txns-input-scriptpubkey-unspendable`,
   `bad-txns-inputvalues-outofrange`, `bad-txns-in-belowout`
8. `AreInputsStandard` (standard only, `bad-txns-nonstandard-inputs`), min relay fee (`min relay fee not
   met`), absurd fee guard (`absurdly-high-fee`), `CheckTxTokens` (`bad-txns-token-*`)
9. VM script verification (`mandatory-script-verify-flag-failed` / `non-mandatory-script-verify-flag`)

Reasons and codes are BCHN's, and so is the debug message where BCHN gives one that does not depend on
its internals. Script failures are the exception: they keep libauth's words inside BCHN's
`mandatory-script-verify-flag-failed (...)`. The verifier implements BCHN's two-pass script verification
to distinguish mandatory from non-mandatory failures.

## Config Validation

`createTxVerifier` rejects non-positive `minRelayFeePerKb` and `maxFee` values at construction time to prevent bypassing fee policy checks.
