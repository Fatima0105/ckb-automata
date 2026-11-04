# ADR 0011: Use Preferred Harvest Operators with Delayed Fallback

- Status: Accepted
- Date: 2026-11-04
- Scope: DAO Harvest V2 operator authorization

## Context

Opening every action to all executors immediately creates duplicated work and fee races. Restricting
every action to one operator creates an availability dependency. DAO preparation also has a special
risk: CKB `since` enforces a lower bound but cannot make a valid prepare transaction expire after an
operational cutoff.

## Decision

DAO Harvest V2 uses operation-specific preferred and fallback paths with exact absolute epoch
lower bounds.

For prepare:

- the selected preferred operator may act at `prepare_open`;
- the owner and any member of a committed fallback set may act at `prepare_takeover`;
- the fallback set contains one through eight sorted, unique full lock hashes and opens
  simultaneously; and
- arbitrary permissionless prepare is never enabled.

Both lower bounds must be before the operational cutoff. The executor stops building and submitting
at the cutoff. Because the cutoff is not enforceable on-chain, the preferred and fallback prepare
operators retain the documented late-submission trust and can be rotated by the owner.

For claim:

- the operator credited by the confirmed prepare receives the first opportunity at DAO maturity;
- compatible executors may act at `claim_takeover`; and
- the committed owner may complete or recover at maturity without waiting for the operator grace
  period.

The owner pays no claim service fee when completing the claim. A valid prepare credit is still
settled from realized compensation. Each branch uses an exact `since` value and a proven lock
identity; changing the time metric or identity is invalid.

## Alternatives considered

- Fully permissionless execution from the first eligible block. This increases duplicated work and
  makes late prepare griefing available to everyone.
- One exclusive operator forever. This turns operator failure into an availability failure.
- An on-chain upper cutoff. CKB `since` has no upper-bound semantics, so this cannot be promised.
- Prevent the owner from acting during the preferred claim period. This weakens recovery without
  adding contract safety.
- Open fallback operators one at a time. Ordered activation adds payload and state complexity; the
  bounded fallback set already limits prepare competition.

## Consequences

- Prepare availability improves without making the timing-sensitive action permissionless.
- Claim eventually becomes open to compatible executors.
- The successful preparer must be committed in successor progress for later claim preference and
  settlement.
- The UI must distinguish a preferred operator period from a fallback period without implying that
  a pending transaction can be cancelled.
- The owner can preempt an operator through normal input contention and must be warned when an
  operator transaction is already pending.

## Reversal cost

Changing actor priority, fallback-set semantics, or owner timing changes authorization and requires
a new policy version and new wallet review.
