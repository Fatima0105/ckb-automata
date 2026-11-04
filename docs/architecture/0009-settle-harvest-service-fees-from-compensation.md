# ADR 0009: Settle Harvest Service Fees from Compensation

- Status: Accepted
- Date: 2026-11-04
- Scope: DAO Harvest V2 economics

## Context

DAO Harvest V1 requires the owner to fund one fixed executor reward for every prepare and claim
action when the job is created. The arrangement makes each reward independently available, but it
locks more CKB up front and pays prepare before the related compensation becomes liquid.

The reviewed alternative is to pay operators from compensation after work is completed. A prepare
operator and claim operator may be different. Compensation can also be lower than predicted, so a
fee design must not make a mature claim impossible or reduce the protected DAO principal.

## Decision

DAO Harvest V2 service fees are capped fixed amounts committed during setup. They are settled from
the gross compensation of the cycle in which the work was completed.

The exact priority is:

1. preserve `principal_capacity` in full;
2. pay the credited prepare operator up to `prepare_service_fee`;
3. pay the successful claim operator up to `claim_service_fee`, unless the owner completed the
   claim; and
4. add all remaining compensation to the owner's Compensation Cell.

Partial service payments are allowed when gross compensation is insufficient. A partial amount is
final for that cycle: no debt carries into principal, the compensation seed, a future cycle, or an
owner wallet cell. Zero compensation and zero remaining compensation are valid outcomes.

Prepare credit is created only by a confirmed, policy-valid prepare transition. Claim credit is
created only by the transaction that completes the claim. Owner completion pays no claim service
fee, but it still settles valid prepare work before assigning the remainder to the owner.

Operators provide their own network-fee inputs. A committed service fee may price in expected
network costs, but the contract never reads a wall-clock fee quote and never deducts miner fees from
principal.

V1 keeps its pre-funded reward rules. No existing payload or job changes meaning.

## Alternatives considered

- Keep all rewards pre-funded. This remains the V1 compatibility path but does not address the
  reviewer's concern about up-front service funding.
- Pay a percentage of compensation. Percentages make review less predictable and add rounding and
  upper-bound complexity.
- Reject a claim when compensation cannot cover every fee. This creates a liveness failure after
  prepare and is forbidden.
- Carry unpaid fees into later cycles. This creates hidden debt and could consume compensation from
  work that a different operator performs.
- Deduct fees or miner costs from principal. This violates the central value-preservation promise.

## Consequences

- A preparer accepts settlement delay and compensation shortfall risk.
- The scheduler should avoid prepare when projected compensation is below total service fees, but
  that preference is never an on-chain claim blocker.
- The protocol needs an authenticated prepare credit and capacity-valid operator accumulators.
- The UI must show fees as maximum service charges, not guaranteed operator income.
- Owner recovery remains live even when no operator expects a profitable fee.

## Reversal cost

Changing fee priority or carrying debt later requires a new payload and policy version. It must not
be introduced by changing application copy or executor behavior alone.
