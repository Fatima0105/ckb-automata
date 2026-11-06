# Recurring Creation Builder

The recurring builder creates one Job Cell at output 0. Its capacity is the
measured Job Cell occupancy plus every scheduled payout and executor reward.
The Job Lock has empty args, and the type script is the verified recurring
policy deployment with empty V1 args.

New operator-bound creations use `job-lock-v3`, `recurring-policy-v2`, and the
[`OperatorPayloadV1` selection envelope](operator-selection-v1.md). Each successor advances the
preferred execution block and takeover block from the immutable schedule. Existing V1 jobs remain
valid and continue on their original scripts.

The canonical `RecurringPayloadV1` bytes bind the owner, recipient, payout,
block interval, first eligible block, run count, reward, and owner-only final
refund. They are stored in witness 0 `output_type`, and their policy-separated
hash is committed by `JobDataV1`. The builder rejects schedules whose last run
would exceed the absolute block-number range and payouts or rewards that cannot
form plain CKB outputs.

## Wallet Completion

The unsigned skeleton intentionally has no inputs. CCC may select owner funding
inputs, add their signatures, and append plain change outputs without changing
Job Cell output 0 or witness 0 `output_type`. `assertRecurringCompletion`
checks these boundaries after completion. Funding outpoints therefore do not
affect the normalized intent hash or the displayed automation terms.

## Independent Reconstruction

`reconstructRecurringDisplayIntent` decodes the completed transaction rather
than trusting API display data. It verifies the deployed Job Lock and recurring
policy, payload and policy hashes, trigger hash, initial sequence and run count,
remaining budget, owner path, and exact Job Cell capacity. It then returns the
job ID, owner, recipient, payout, schedule, rewards, final-refund rule, and
policy commitments shown during review.

## Verification

- `contracts/fixtures/recurring_creation_v1.json` fixes the deployed policy
  hash, payload hash, intent hash, job ID, payload, Job data, and raw transaction
  bytes.
- Core tests cover reconstruction, wallet completion, committed-output mutation,
  unfundable payouts, zero runs, and schedule overflow.
- `scripts/verify-recurring-builder-local.mjs` adds a live owner input and
  change, signs the transaction, reconstructs its display intent, and dry-runs
  the compiled Job Lock and recurring policy together.
