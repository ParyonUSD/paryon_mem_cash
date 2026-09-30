# src/core

Formerly `@mem-cash/core`; exported from `@paryonusd/mem-cash`.

Node engine, subscription manager, and mempool acceptance for mem-cash.

## Node

`createNode()` wires together in-memory storage with an optional transaction verifier:

```typescript
import { createNode } from "@paryonusd/mem-cash";
import { createTxVerifier } from "@paryonusd/mem-cash/validation";

const verifier = await createTxVerifier({ standard: false });
const node = createNode({ verifier });

node.setChainTip(200, 1700000000);
node.addUtxo({ txid, vout: 0, satoshis: 10_000n, scriptHash, height: 100 });

const result = node.submitTransaction(rawHex);
// { success: true, txid, fee, size, affectedScriptHashes }

// A refusal carries BCHN's reason and code, and the text sendrawtransaction answers with:
// { success: false, code: 18, error: "txn-mempool-conflict", message: "txn-mempool-conflict (code 18)" }

// Debug without accepting to mempool (per-input VM traces)
const debug = node.debugTransaction(rawHex);
// { success: true, txid, fee, size, inputResults: [...] }

// Blocks: the whole mempool, or chosen transactions, under a real 80-byte header
node.mine();
node.mine({ include: [txid] });

// A reorg: disconnect the last block, a double spend first so what it conflicts with drops out,
// then mine the longer branch
node.disconnectBlocks(1, { replacementTxs: [doubleSpendHex] });
node.mine();
node.mine();
```

## Subscription Manager

Tracks scripthash and header subscriptions, detects status changes, and dispatches notifications:

```typescript
const consumerId = node.subscriptions.addConsumer((notification) => {
  if (notification.type === "scripthash") {
    console.log(notification.scriptHash, notification.status);
  } else {
    console.log("new tip:", notification.header.height);
  }
});
```

Subscriber callbacks are isolated with try-catch -- a throwing callback is logged via `console.error` but does not prevent other subscribers from receiving their notifications.

## Mempool Acceptance

Two-phase pattern: the verifier validates (read-only), then `acceptToMempool` performs storage mutations and returns affected scripthashes for notification dispatch.
