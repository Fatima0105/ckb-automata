# ADR 0010: Accumulate Harvest Compensation in an Owner Vault

- Status: Accepted
- Date: 2026-11-04
- Scope: DAO Harvest V2 compensation storage

## Context

A native CKB output must contain enough capacity for its lock, optional type, and data. Small DAO
compensation may be economically undesirable or structurally unable to create a new standard payout
Cell after every harvest. Combining unrelated users or jobs would create shared contention and a
larger trust and accounting surface.

## Decision

Every DAO Harvest V2 setup creates one mandatory Compensation Cell for that job. Its lock commits
the Job ID, owner lock hash, payout lock hash, V2 policy hash, and immutable-terms commitment.

The owner supplies a disclosed `compensation_seed_capacity` equal to the measured occupied capacity
plus any explicitly reviewed safety margin. The seed is a recoverable reserve, not a service fee.

Every valid claim consumes exactly one current Compensation Cell and creates exactly one successor
whose capacity is:

```text
successor_capacity = input_capacity + net_cycle_compensation
```

The policy and Compensation Vault Lock both validate the delta. The Cell never contains protected
DAO principal or operator fees.

The owner may:

- sweep accumulated compensation to the committed payout lock while recreating the Cell at the
  exact seed capacity;
- close the Cell when the automation is terminal, paying seed and accumulated value according to
  the committed owner and payout rules; or
- recover it from public chain data without CKAutomata services.

The accumulator is per job. It is never shared across users, jobs, or operators. V1 continues to
pay compensation directly to its committed payout lock.

## Alternatives considered

- Create a new payout Cell every cycle. This fails for small values and increases output count.
- Make the accumulator optional. Supporting two claim layouts doubles the contract and review
  surface without improving the initial V2 safety case.
- Store compensation in the Job Cell. This mixes user value with automation state and service
  accounting.
- Share one accumulator across jobs. This adds cross-job contention and ownership ambiguity.
- Leave accumulated compensation in the DAO vault. This confuses principal with liquid value and
  weakens exact principal accounting.

## Consequences

- Setup locks a small owner-recoverable reserve in addition to principal.
- Claim transactions gain one input and one output but avoid repeated dust-like payouts.
- The indexer must track the canonical Compensation Cell outpoint with the Job and DAO Cell.
- A sweep races an executor claim through ordinary CKB input contention; the losing transaction
  must rebuild from canonical state.
- Payout addresses with different lock sizes require an exact occupied-capacity quote before setup.

## Reversal cost

Making the Compensation Cell optional or changing its ownership requires a new script or policy
version. Existing V2 Cells must retain their original sweep, close, and recovery paths.
