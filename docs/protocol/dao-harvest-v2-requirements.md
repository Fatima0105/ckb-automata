# DAO Harvest V2 Requirements

Status: Accepted design baseline; contracts not yet implemented

Network: CKB testnet only

## Authority statement

DAO Harvest V2 may prepare one committed DAO deposit, claim its mature withdrawal, preserve the
exact original amount in a new DAO deposit, settle capped fees for completed work from that cycle's
compensation, and accumulate the remaining compensation for the owner.

It cannot reduce or redirect principal, charge for work that was not completed, carry unpaid fees
into later value, add cycles, change the payout lock, spend unrelated owner cells, or require a
hosted service for owner recovery.

## Canonical value order

For every claim or owner completion:

1. Calculate `maximum_withdraw` from canonical deposit and prepare headers.
2. Require `maximum_withdraw >= principal_capacity` with checked `u128` intermediate arithmetic.
3. Re-deposit exactly `principal_capacity` before allocating any other value.
4. Define `gross_compensation = maximum_withdraw - principal_capacity`.
5. Settle a valid prepare credit up to `prepare_service_fee`.
6. Settle the successful claim executor up to `claim_service_fee`; use zero for owner completion.
7. Increase the owner Compensation Cell by every remaining shannon.

If compensation is insufficient, prepare is paid first, claim is paid second, and both may receive
partial or zero payment. No unpaid amount survives the transaction. Insufficient compensation can
make execution unattractive, but it cannot make an otherwise valid mature owner completion fail.

## Owned and recoverable values

| Value                    | Owner                              | Source                                    | Recovery rule                                      |
| ------------------------ | ---------------------------------- | ----------------------------------------- | -------------------------------------------------- |
| DAO principal            | User                               | Setup deposit                             | Exact re-deposit or owner exit; never a fee source |
| Compensation seed        | User                               | Setup funding                             | Returned on terminal close or recovery             |
| Accumulated compensation | User through committed payout rule | DAO compensation after service settlement | Sweep, close, or recover                           |
| Prepare service payment  | Confirmed preparer                 | Current cycle compensation                | Paid once, capped, no carry-forward debt           |
| Claim service payment    | Successful claim executor          | Current cycle compensation                | Zero for owner completion; capped and paid once    |
| Miner fee                | Transaction submitter              | Submitter fee inputs                      | Never silently deducted from principal or seed     |

## Operator authorization

### Prepare

- Preferred operator: exact full lock hash, authorized at `prepare_open`.
- Fallback operators: one through eight sorted unique lock hashes, authorized together at
  `prepare_takeover`.
- Owner: authorized at `prepare_takeover` and through separate recovery-safe paths.
- Public executors: never authorized for prepare.
- Every operator proves identity with a distinct co-spent input.
- `prepare_open < prepare_takeover < operational_cutoff` is required.
- The cutoff remains an executor rule because CKB has no upper-bound `since`.

### Claim

- The confirmed preparer is the preferred claimant at canonical DAO maturity.
- Any compatible executor may claim at `claim_takeover`.
- The owner may complete or recover at maturity without waiting for `claim_takeover`.
- `claim_takeover` must strictly follow maturity and use the same absolute epoch metric.
- Only the transaction that commits may receive the claim service payment.

## Compensation Cell rules

- Setup creates exactly one job-bound Compensation Cell.
- Its V2 lock commits the Job ID, owner lock hash, payout lock hash, policy script hash, and payload
  hash. The prototype encodes these as five 32-byte lock arguments.
- Every automated claim consumes exactly one and recreates exactly one.
- Its successor capacity increases by exactly net compensation.
- Its lock, Job ID, payout commitment, policy commitment, and seed never change automatically.
- A sweep recreates it with exactly the seed and sends the accumulated value to the payout lock.
- A terminal close creates no successor and returns all value under the committed owner/payout rules.
- No executor can use the Compensation Cell as a fee input or reward source.
- Competing spends resolve through ordinary CKB input uniqueness; applications reload canonical
  state after a conflict.

## Operator payment rules

An operator payment uses a declared identity input and a same-lock accumulator output. The output
capacity increase is exactly the amount assigned by the canonical value order. A new below-capacity
reward output is forbidden.

If the preparer and claimant use the same full lock, one accumulator receives their combined exact
payment. Otherwise each operator supplies one distinct identity input and receives one same-lock
successor. No operator accumulator is funded by the owner or shared with another lock.

Prepare credit is tied to the confirmed prepare transition and the exact Job ID/cycle. It cannot be
copied to another job, cycle, operator, or payout. The final persistence representation is selected
only after the Stage 3 local-chain prototype and Stage 4 schema review.

## Transaction rules

- One job and one transition per transaction.
- No cross-user or cross-job batching.
- Exact operation-specific byte, cycle, and fee ceilings are mandatory before public submission.
- The minimum preferred-operator interval is `1/20` of a canonical epoch; applications may commit a
  longer interval but never a shorter one.
- Executors reload inputs and headers, rebuild only their fee inputs/change, dry-run, and sign once.
- After broadcast, executors observe the transaction and do not promise cancellation.
- A conflicting owner or executor transaction may win; the loser reloads canonical state and does
  not report completion.

## Scenario walkthroughs

### Operator A prepares and operator B claims

Operator A proves its preferred or fallback identity and confirms prepare. The successor commits A's
prepare credit. At claim takeover, operator B proves its identity and completes claim. The transaction
re-deposits principal, pays A up to the prepare cap, pays B up to the claim cap, and accumulates the
remainder for the owner.

### Owner completes the claim

At maturity, the owner proves the committed owner lock and completes the claim. Principal is
re-deposited or exited according to the selected owner operation. The valid prepare credit is paid,
the claim service payment is zero, and all remaining compensation belongs to the owner.

### Compensation is below total fees

The transaction re-deposits principal first. The preparer receives up to the available compensation;
the claimant receives only what remains up to its cap; the owner's net addition may be zero. The
claim remains valid, and no shortfall is carried forward.

### Preferred operator is unavailable

Before takeover, other executors wait. At prepare takeover, a committed fallback or the owner may
act. At claim takeover, any compatible executor may act. The owner can rotate prepare operators or
recover without CKAutomata services.

### The preparation window is missed

Executors stop at the operational cutoff and schedule the next safe DAO boundary. They do not submit
late merely because the lower-bound `since` remains valid. The owner may rotate an operator or use an
owner path. The residual trust in approved prepare operators is displayed and documented.

### The automation finishes

The terminal automated claim re-deposits the exact principal under the owner-bound Harvest Vault but
creates no next Job, so no executor can begin another cycle. The owner can later use the documented
vault exit path. The owner closes the Compensation Cell, receiving its recoverable seed and
accumulated compensation under the committed payout rules. No service can keep the principal or
terminal reserve.

## User-facing vocabulary

| Protocol term                | UI wording            | Meaning                                                               |
| ---------------------------- | --------------------- | --------------------------------------------------------------------- |
| `preferred_operator`         | Preferred operator    | The first service allowed to perform the action                       |
| `fallback_operator`          | Backup operator       | An approved service allowed to take over after the waiting period     |
| `prepare_service_fee`        | Preparation charge    | Maximum payment for a confirmed preparation action                    |
| `claim_service_fee`          | Completion charge     | Maximum payment to the executor that completes the mature claim       |
| `compensation_seed_capacity` | Recoverable reserve   | Owner-funded capacity required to keep the Compensation Cell valid    |
| `compensation_cell`          | Compensation balance  | Job-bound Cell that accumulates the user's net compensation           |
| `claim_takeover`             | Backup available time | Earliest chain time at which compatible executors may take over claim |

The complete transaction ceilings and takeover rationale are maintained in
[`dao-harvest-v2-transaction-boundaries.md`](../testing/dao-harvest-v2-transaction-boundaries.md).

The UI must not call the recoverable reserve a charge, describe a maximum charge as guaranteed, or
claim that a broadcast transaction can be cancelled.

## Compatibility

- V1 jobs retain pre-funded rewards and direct compensation payouts.
- V2 code hashes and payload versions are distinct.
- Indexers, executors, API responses, UI, and recovery tooling route by exact script identity.
- No automatic migration is allowed.
- Any V1-to-V2 move requires a new owner-reviewed and owner-signed transaction.

## Normative decisions

- [ADR 0009: Settle Harvest Service Fees from Compensation](../architecture/0009-settle-harvest-service-fees-from-compensation.md)
- [ADR 0010: Accumulate Harvest Compensation in an Owner Vault](../architecture/0010-accumulate-harvest-compensation-in-an-owner-vault.md)
- [ADR 0011: Use Preferred Harvest Operators with Delayed Fallback](../architecture/0011-use-preferred-harvest-operators-with-delayed-fallback.md)
- [ADR 0012: Use Bound Compensation and Same-Lock Operator Accumulators](../architecture/0012-use-bound-compensation-and-same-lock-operator-accumulators.md)
