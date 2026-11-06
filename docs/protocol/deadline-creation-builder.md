# Deadline Creation Builder

This V1 builder creates the legacy conditional deadline form: a campaign-backed
pay-or-refund outcome. It is not the long-term direct scheduled-payment policy.
See [ADR 0008](../architecture/0008-separate-plain-payments-from-campaigns.md).

New operator-bound creations use `job-lock-v3`, `deadline-policy-v2`, and the
[`OperatorPayloadV1` selection envelope](operator-selection-v1.md). The campaign rules and payout
commitments remain unchanged; only executor priority and delayed takeover are added. Existing V1
jobs continue to use this documented legacy path.

The deadline builder returns one normalized intent and an unsigned CKB
transaction whose first two outputs are immutable:

| Index | Output   | Capacity                                     |
| ----: | -------- | -------------------------------------------- |
|     0 | Campaign | measured campaign occupancy plus all pledges |
|     1 | Job Cell | measured Job Cell occupancy plus one reward  |

Pledge inputs are sorted by outpoint and form the required transaction-input
prefix. Input 0 and campaign output index 0 derive the unique campaign ID. The
full campaign type hash becomes the deadline policy args, so both outputs can
be created atomically without referring to the future transaction hash.

The first witness `output_type` contains the canonical 76-byte pledge records.
Each record is the packed source outpoint, refund lock hash, and amount. Every
amount must be large enough to create a plain refund output, and duplicate
outpoints are rejected before construction.

## Normalized Intent

The creation commitment is:

```text
H("ckb-automata/deadline-creation-intent/v1", normalized_intent_bytes)
```

The fixed-order bytes bind the network genesis and deployment manifest, anchor
outpoint, output indices, nonce, amounts, deadline, recipients, capacities,
campaign and policy hashes, payload and trigger hashes, and the complete pledge
records. This commitment feeds `job_id` with Job Cell output index 1.

## Wallet Completion

CCC may append owner funding inputs, append plain change outputs and replace the
first witness lock field with its signature. It must preserve the required
input prefix, both committed outputs and their data, required cell dependencies,
and witness 0 `output_type`. `assertDeadlineCompletion` verifies these rules
after wallet completion. The quote's maximum estimated fee remains available
as the caller's fee bound.

## Verification

- `contracts/fixtures/deadline_creation_v1.json` fixes the intent hash,
  campaign and job IDs, both data payloads, witness, and raw transaction bytes.
- Core tests prove pledge sorting, unsafe-input rejection, allowed wallet
  completion, and rejection of committed-output mutation.
- `scripts/verify-deadline-builder-local.mjs` completes, signs, and dry-runs the
  transaction against the verified local deployment.
