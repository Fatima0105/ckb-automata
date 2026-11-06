# ADR 0012: Use Bound Compensation and Same-Lock Operator Accumulators

- Status: Accepted
- Date: 2026-11-04
- Scope: DAO Harvest V2 Cell representations

## Context

DAO Harvest V2 must preserve small compensation amounts without creating dust and must pay a
preparer and claimant from compensation without requiring either payment to meet the occupied
capacity of a new Cell. The representation must also bind value to the real job and payload so a
shadow successor cannot redirect later compensation.

The prototype compared direct payout outputs, increases to existing operator Cells, a dedicated
owner Compensation Cell, a separate prepare receipt Cell, owner sweep, and terminal close.

## Decision

Each V2 job has one zero-data Compensation Cell under a V2 Compensation Vault Lock. Its 160-byte
args contain five 32-byte commitments:

1. Job ID;
2. owner lock hash;
3. payout lock hash;
4. policy script hash; and
5. payload hash.

The five bindings are mandatory. Omitting payload or policy identity would recreate the shadow-job
class fixed in V1. The prototype occupied capacity is 201 CKB. Setup commits a recoverable reserve
equal to the greater of the Compensation Cell minimum and the committed payout Cell minimum.

Net compensation increases this Cell in place. A sweep consumes it, recreates exactly the reserve,
and pays the accumulated delta only when that delta can form a valid payout Cell. Final close and
recovery create no successor and pay the full Cell capacity, including the reserve, to the committed
payout rule.

Owner-authorized operator rotation changes the immutable payload hash, so it also consumes and
recreates the Compensation Cell with the new payload-hash argument and exactly unchanged capacity.
No automated transition may change any Compensation Lock argument.

Operator payments increase an ordinary input Cell under the operator's exact full lock. The
successor keeps the same lock and increases capacity by the exact payment. This input also proves
operator identity. A payment may therefore be one shannon without creating a separate dust output.
If preparer and claimant are the same lock, one accumulator output receives the sum. Otherwise each
operator supplies a distinct identity input and receives one successor.

Prepare credit is persisted inside the authenticated Job successor rather than a separate receipt
Cell. Stage 4 defines its exact fields and bytes. At minimum it binds the Job ID, cycle, prepared DAO
identity, and preparer lock hash. A separate receipt was rejected because it adds occupied capacity,
one input, one output, and another live Cell without improving ownership.

## Contention rules

The Compensation Cell is job-local, so two claim, sweep, close, or recovery transactions for the
same job conflict on the same input and only one may commit. Operators must maintain enough
same-lock identity Cells for concurrent work. If two attempts use the same operator input, the loser
reloads and retries with another live Cell; it may not substitute a different lock or take value from
the Compensation Cell.

## Prototype evidence

- An empty lock with 0, 20, 128, and 160 argument bytes occupies 41, 61, 169, and 201 CKB.
- A 1 CKB payment is dust as a direct secp-style output but is a valid exact increase to a 61 CKB or
  larger same-lock input.
- Insufficient compensation produces partial prepare payment, then partial claim payment, then owner
  compensation, with exact conservation and no debt.
- Sweep conserves `input = reserve successor + payout`; final close conserves
  `input = recovered reserve + accumulated compensation` in one payout Cell.
- A reserve below either the Compensation Cell or payout Cell minimum rejects before setup.
- Successor capacity overflow and reserve underflow reject.

The Rust CKB data-structure tests and `contracts/benchmarks.json` independently measure the occupied
capacities. TypeScript prototype tests cover settlement, sweep, close, payout-lock sizes, overflow,
and conflict identity.

## Alternatives considered

- Direct operator output: rejected because normal service payments can be below occupied capacity.
- User-funded operator reward Cells: rejected because they increase setup funding and make ownership
  and unused reserve recovery more complex.
- Shared Compensation Cell: rejected because it mixes owners and creates cross-job contention.
- Compensation in Job Cell capacity: rejected because it mixes mutable owner value with executor
  state and makes principal/reward accounting harder to audit.
- Typed prepare receipt: rejected for the extra Cell, capacity, and contention surface.

## Consequences

- Setup reserves at least 201 CKB for the owner, recoverable on close or recovery.
- Executors need a pool of ordinary same-lock Cells for concurrent submissions.
- A sweep waits until the accumulated amount can create the committed payout output; close and
  recovery remain available because the reserve covers that output.
- The final schema must preserve all five Compensation Cell commitments and authenticated prepare
  credit. Removing either requires a new protocol version.
