# CKAutomata Reviewer Feedback Implementation Plan

> A testnet-first plan for smaller transactions, compensation-funded service payments, preferred
> operators with fallback execution, compensation accumulation, and independently operated
> executors.

**Document type:** Focused implementation and audit plan

**Planning snapshot:** 4 November 2026

**Target:** CKAutomata public CKB testnet deployment; not a mainnet or audited release

**Review source:**
[CKBuilder project review by joii2020](https://github.com/Nervos-Community-Catalyst/CKBuilder-projects/issues/43#issuecomment-6625976874)

**Current protocol specification:** [DAO Harvest Protocol V1](./docs/protocol/dao-harvest-v1.md)

**Current security review:** [DAO Harvest Security Review](./docs/security/dao-harvest-review.md)

---

## 1. Purpose

This plan converts the review into independently testable implementation work. It addresses five
connected concerns:

1. A broadcast CKB transaction cannot be reliably cancelled, so every automation transaction must
   remain small, predictable, economical, and easy to include.
2. Small compensation payments may be better accumulated in a dedicated Cell instead of creating
   a separate payout Cell after every harvest.
3. DAO Harvest service payments should come from compensation earned by the completed work where
   practical, rather than requiring the user to pre-fund every executor payment.
4. A preferred operator should receive the first opportunity to execute, while the owner or another
   operator can take over after a defined delay.
5. An independent person must be able to run an executor and complete the flow without using
   CKAutomata's hosted executor services.

The implementation must preserve the project's primary security rule: the user's original Nervos
DAO deposit is never a source of service payments, transaction fees, or operator compensation.

## 2. Current Baseline

DAO Harvest V1 currently:

- creates a vault-controlled Nervos DAO deposit and a separately funded Job Cell;
- preserves the exact principal through prepare and claim/re-deposit;
- pays one fixed, pre-funded reward after each executor action;
- restricts prepare to an owner-approved executor set;
- allows compatible executors to complete a mature claim;
- supports owner-authorized executor-set rotation, stop, exit, and recovery; and
- treats `min_compensation` as an off-chain scheduling preference so it cannot block a prepared
  claim.

The deployed v1 scripts are immutable. Existing v1 jobs must remain discoverable, executable, and
owner-recoverable. This work therefore introduces a versioned v2 protocol instead of silently
changing the meaning of v1 payloads or witnesses.

## 3. Required Outcomes

The work is complete only when all of the following are true:

- Every automated transition spends one job only; jobs are never batched into one transaction.
- Transaction byte size, CKB-VM cycles, fee rate, and maximum fee are measured before submission.
- The original DAO principal is preserved exactly before any service payment is calculated.
- A service payment is owed only for an on-chain action that was completed successfully.
- Prepare and claim work can be credited to different operators.
- A low compensation amount cannot permanently block the owner from claiming or recovering funds.
- A preferred operator has a clear first-execution period.
- A configured fallback operator, the owner, or an open executor can take over according to the
  operation-specific rules.
- The preparation path does not become permissionless in a way that worsens the existing late-
  preparation risk.
- Small net compensation can accumulate without creating an invalid below-capacity output.
- Existing v1 jobs continue to work without migration.
- A fresh external operator can install, configure, discover, simulate, submit, and confirm a v2 job
  without access to CKAutomata's hosted API, Redis, database, or private configuration.

## 4. Non-Goals

- Cancelling or replacing a transaction after it has been broadcast.
- Combining several users' jobs into one transaction.
- Paying service charges from the protected DAO principal.
- Guaranteeing that compensation will always cover service costs.
- Allowing a wall clock, API row, queue, or operator receipt to authorize a transaction.
- Making DAO preparation fully permissionless while CKB `since` cannot enforce an upper cutoff.
- Migrating an existing v1 job without an explicit owner-signed transaction.
- Mainnet activation, economic guarantees, or a claim of independent security audit.

## 5. Fixed Design Principles

| Area                | Decision                                                                                                              |
| ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Compatibility       | Deploy new v2 scripts and retain the v1 registry, indexer, executor adapter, UI, and recovery paths                   |
| Transaction scope   | One job and one protocol transition per transaction; no job batching                                                  |
| Principal           | Preserve exact `principal_capacity` before calculating fees, rewards, change, or compensation                         |
| Fee source          | Use realized DAO compensation for completed service work; never reduce principal                                      |
| Network fee         | The submitting operator provides network-fee inputs; its service payment may reimburse the bounded expected cost      |
| Prepare payment     | Credit the successful preparer on-chain, but settle its payment when compensation becomes liquid during claim         |
| Claim payment       | Pay only the operator that completes the valid claim, unless the owner completes it directly                          |
| Owner action        | Owner completion pays no claim-service fee; already completed prepare work may still receive its committed fee        |
| Small compensation  | Accumulate net compensation in an owner-bound Compensation Cell when a direct payout would be uneconomical or invalid |
| Preferred execution | Give one selected operator the first opportunity, then open an operation-specific fallback after an exact lower bound |
| Prepare fallback    | Owner and approved fallback operators only; do not open late preparation to arbitrary executors                       |
| Claim fallback      | Preferred claimant first, then compatible executors after a grace period; owner recovery remains independent          |
| Authority           | CKB cells, headers, input `since`, scripts, and signatures remain authoritative                                       |

## 6. Proposed V2 Protocol

### 6.1 Versioned scripts and data

Introduce separate deployments for:

- `job-lock-v2` or a narrowly versioned Job Lock execution mode;
- `dao-harvest-policy-v2`;
- `harvest-vault-lock-v2`; and
- `compensation-vault-lock-v1`.

The schema must not reinterpret `DaoHarvestPayloadV1`. Add a new payload containing at least:

```text
table DaoHarvestPayloadV2 {
  version: Uint16,
  owner_lock_hash: Byte32,
  payout_lock_hash: Byte32,
  vault_lock_hash: Byte32,
  compensation_vault_lock_hash: Byte32,
  dao_type_hash: Byte32,
  principal_capacity: Uint64,
  preferred_prepare_executor_lock_hash: Byte32,
  fallback_prepare_executor_set_hash: Byte32,
  prepare_service_fee: Uint64,
  claim_service_fee: Uint64,
  prepare_takeover_delay: Uint64,
  claim_takeover_delay: Uint64,
  compensation_seed_capacity: Uint64,
  min_prepare_compensation: Uint64,
  prepare_buffer_epochs: Uint64,
  confirmation_margin_epochs: Uint64,
  total_cycles: Uint32,
  end_epoch_since: Uint64,
}
```

Field names and encodings are provisional until the schema review. Every value must have an exact
unit, byte order, range, hash domain, and mutation rule.

### 6.2 Single-action transactions

Every prepare, claim, owner completion, rotation, sweep, or recovery is a separate transaction.
An executor must not combine unrelated jobs merely to save fees.

Before signing, the executor must:

1. reload every input and canonical header;
2. rebuild only its own fee inputs and change;
3. calculate serialized transaction size;
4. run `dry_run_transaction` against the configured RPC;
5. compare measured cycles with the contract-specific maximum;
6. calculate the fee from a bounded configured fee rate;
7. reject a transaction above the operation's byte, cycle, or fee ceiling; and
8. broadcast once, then observe rather than constructing competing replacements automatically.

### 6.3 Compensation and service-payment accounting

For a mature DAO withdrawal:

```text
maximum_withdraw = canonical Nervos DAO maximum-withdraw calculation
principal        = immutable principal_capacity
gross_comp       = maximum_withdraw - principal

prepare_due = prepare_service_fee if a valid prepare credit exists else 0
claim_due   = claim_service_fee if an executor performs claim else 0

service_due = prepare_due + claim_due
service_paid = min(gross_comp, service_due), subject to valid output capacity
net_comp     = gross_comp - service_paid
```

The claim must not fail solely because `gross_comp < service_due`. Principal remains exact, the
claim remains live, and unpaid service fees do not become a claim against principal or a later
owner deposit. The scheduler should avoid preparation when projected compensation cannot cover the
expected service cost, but that check remains off-chain.

The exact shortfall rule must be deterministic. The recommended order is:

1. preserve principal;
2. credit completed prepare work up to its cap;
3. credit completed claim work up to its cap;
4. assign the remainder to the user Compensation Cell; and
5. pay no amount that cannot be represented by a valid output or accumulator increase.

No arbitrary percentage, floating-point value, or operator-provided amount may enter the contract.

### 6.4 Crediting prepare and claim operators

Prepare happens before compensation is liquid, so its operator cannot be paid from that cycle's
compensation immediately. The prepare successor must commit the successful preparer's reward lock
hash in mutable progress that the claim transition can verify.

The implementation must use one canonical mechanism, selected after the schema prototype:

- a domain-separated commitment in the successor Job Cell trigger/progress hash; or
- a small typed prepare-receipt Cell consumed by the matching claim.

The commitment approach is preferred if it can be proven without weakening generic Job Lock
invariants. The claim witness supplies the credited lock, and the policy checks its hash before
allowing payment. A copied transaction cannot substitute another reward lock.

The claim executor proves its own identity with a co-spent input. If preparer and claimant are the
same identity, the contract may permit one combined reward output. If they differ, each payment must
be independently bound and capacity-valid.

### 6.5 Operator reward accumulators

A small service fee may be below the occupied capacity required for a new standard-lock output.
The executor may therefore supply an existing ordinary reward Cell as its identity input. The
transaction recreates that Cell under the same lock with capacity increased by exactly the service
fee. This both proves control and accumulates small payments without creating dust outputs.

The contract must reject:

- a changed reward lock;
- an increase larger than the committed service fee;
- payment to an identity that did not complete the credited work;
- payment from principal or the user's Compensation Cell seed; and
- an executor-controlled output not declared in the controlled-output set.

### 6.6 User Compensation Cell

Setup creates one Compensation Cell bound to:

- the Job ID;
- the owner lock hash;
- the approved payout lock hash;
- the v2 policy script hash; and
- a recoverable seed capacity.

The seed exists only to satisfy occupied-capacity requirements. It is not a service charge and must
remain owner-recoverable.

Each claim consumes the current Compensation Cell and recreates exactly one successor whose
capacity increases by `net_comp`. This makes small compensation cumulative and avoids creating a
new payout Cell after every cycle.

Owner operations must support:

- **Sweep:** send accumulated compensation to the payout address while recreating the Cell with its
  exact seed capacity so later cycles can continue.
- **Close:** after the automation ends, send the seed and accumulated compensation according to the
  committed owner/payout rules and create no successor.
- **Recover:** allow an owner-authorized exit without the hosted API or executor.

The Compensation Cell is a single-use state object. Competing claims cannot both consume it. The
indexer must treat its canonical outpoint as part of the live harvest state.

### 6.7 Preferred operator and fallback windows

The policy uses separate lower bounds rather than an unenforceable cancellation promise:

```text
prepare_open       = selected safe preparation start
prepare_takeover   = prepare_open + prepare_takeover_delay
claim_maturity     = canonical DAO claim maturity
claim_takeover     = claim_maturity + claim_takeover_delay
```

Authorization rules:

| Operation window                 | Authorized actor                                                           | Payment                                                  |
| -------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------- |
| Prepare at `prepare_open`        | Preferred prepare operator                                                 | Prepare fee credited for later settlement                |
| Prepare at `prepare_takeover`    | Owner or committed fallback prepare operator                               | Successful preparer credited                             |
| Prepare after operational cutoff | Executor must refuse off-chain; owner can rotate or wait for a later cycle | None unless a valid prepare is confirmed                 |
| Claim at `claim_maturity`        | Credited/preferred claimant                                                | Claim fee if it completes the claim                      |
| Claim at `claim_takeover`        | Any compatible executor satisfying the v2 proof                            | Claim fee to the successful executor                     |
| Owner completion or recovery     | Committed owner                                                            | No claim fee; completed prepare fee may still be settled |

The contract must require the exact absolute epoch `since` associated with the selected branch. A
primary executor cannot claim fallback authority early by changing its identity or time metric.

Because `since` has no upper bound, preparation remains restricted to the preferred and committed
fallback set. Permissionless fallback is allowed only for the mature claim, where later execution
does not worsen the DAO preparation timing.

### 6.8 Rotation and service discontinuation

The owner can rotate the preferred and fallback prepare operators without moving the DAO deposit.
Rotation must preserve principal, payout, fees, cycles, current state, Compensation Cell identity,
and every other immutable economic term.

If the preferred operator stops:

- an approved fallback may prepare after `prepare_takeover`;
- any compatible executor may claim after `claim_takeover`;
- the owner may complete, rotate, sweep, close, or recover using public chain data; and
- API, database, Redis, and CKAutomata executor outages cannot change authorization.

## 7. Repository Changes

| Boundary         | Expected work                                                                                                                           |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Molecule         | Add v2 payload/progress fixtures and Compensation Cell data without changing v1 schemas                                                 |
| Contracts        | Add versioned Job, Harvest Policy, Vault, and Compensation Vault behavior plus stable error codes                                       |
| Core SDK         | Add v2 math, builders, review intent, transaction diff validation, sweep, close, rotation, and recovery                                 |
| Executor         | Add size/cycle/fee gates, preferred/fallback scheduling, credited-work settlement, and v1/v2 adapters                                   |
| API              | Add v2 quotes/builds, canonical multi-cell projection, independent pending-submission reconciliation, and OpenAPI changes               |
| Database         | Add additive v2 columns/tables and reversible migrations; do not rewrite v1 records                                                     |
| Frontend         | Explain compensation-funded charges, preferred operator, fallback timing, accumulated compensation, and owner actions in plain language |
| Operator tooling | Add a standalone discovery/configuration command and a fresh-checkout external-operator guide                                           |
| Documentation    | Add v2 protocol, economics, threat model, deployment manifest, runbook, and independent drill evidence                                  |

## 8. Delivery Sequence

Each stage is implemented, tested, audited, and corrected before dependent work begins.

| Stage                                   | Status   | Evidence                                                             |
| --------------------------------------- | -------- | -------------------------------------------------------------------- |
| 1. Requirements and economic rules      | Complete | ADRs 0009-0011, V2 requirements, vocabulary and documentation tests  |
| 2. Transaction boundaries               | Complete | Signed-byte, dry-run cycle, fee, shape and one-job guards documented |
| 3. Compensation and reward prototypes   | Complete | Bound owner Cell and same-lock operator accumulator selected         |
| 4. V2 schemas and fixtures              | Pending  | Not started                                                          |
| 5. V2 contracts                         | Pending  | Not started                                                          |
| 6. SDK builders and wallet review       | Pending  | Not started                                                          |
| 7. Executor scheduling and submission   | Pending  | Not started                                                          |
| 8. API, indexer and database            | Pending  | Not started                                                          |
| 9. User interfaces                      | Pending  | Not started                                                          |
| 10. External operator package and drill | Pending  | Not started                                                          |
| 11. Testnet deployment and soak         | Pending  | Not started                                                          |

### Stage 1: Freeze Requirements and Economic Rules

**Implement:** Record exact fee ownership, shortfall behavior, accumulator seed ownership, preferred
and fallback authorization, v1 compatibility, and user-facing terminology. Add architecture decision
records for compensation-funded fees and the Compensation Cell.

**Verify:** Walk through prepare by operator A, claim by operator B, owner claim, insufficient
compensation, operator outage, missed prepare window, and final close.

**Exit gate:** No flow can reduce principal, leave fee priority ambiguous, or require a hosted
service for owner recovery.

### Stage 2: Benchmark Transaction Boundaries

**Implement:** Measure current and proposed setup, prepare, claim, sweep, rotation, and recovery
transactions. Define maximum bytes, cycles, fee rate, inputs, outputs, headers, and dependencies for
each operation.

**Verify:** Use CKB-VM tests and RPC dry-run fixtures. Test near-limit transactions and reject
oversized or over-cycle builds before signing.

**Exit gate:** Every operation has a documented ceiling and remains one-job-per-transaction.

### Stage 3: Prototype Compensation and Reward Cells

**Implement:** Build local-chain prototypes for the user Compensation Cell and operator reward
accumulator. Compare direct payout, accumulator increase, owner sweep, and final close.

**Verify:** Prove occupied-capacity validity, exact capacity deltas, contention behavior, seed
recovery, different payout lock sizes, and insufficient-compensation handling.

**Exit gate:** Select one representation with no dust output and no ambiguous ownership.

### Stage 4: Define V2 Schemas and Cross-Language Fixtures

**Implement:** Add final Molecule schemas, operation codes, hash domains, witness layouts, error
codes, and canonical Rust/TypeScript/JSON fixtures. Define the prepare-credit representation.

**Verify:** Cross-language encoding and mutation tests cover every field, output index, identity,
time branch, fee, counter, and accumulator value.

**Exit gate:** Every persistent byte and permitted mutation has one versioned definition.

### Stage 5: Implement V2 Contracts

**Implement:** Add setup, preferred prepare, fallback prepare, preferred claim, open fallback claim,
owner completion, sweep, close, rotation, and recovery validation. Bind vault and Compensation Cell
to the same immutable terms.

**Verify:** Contract tests reject principal diversion, fee inflation, reward redirection, forged
prepare credit, early fallback, changed `since` metric, accumulator theft, duplicate successors,
shadow jobs, controlled-output expansion, header substitution, and v1/v2 confusion.

**Exit gate:** Native tests, CKB-VM tests, fuzzing, cycle benchmarks, reproducible builds, and manual
security review pass with no unresolved critical or high-severity finding.

### Stage 6: Implement SDK Builders and Wallet Review

**Implement:** Add deterministic v2 builders and strict wallet-completion validation. Produce a
plain-language review separating original amount, expected compensation, completed-work charges,
network fee, recoverable seed, accumulated compensation, and total locked amount.

**Verify:** Mutation tests change every reviewed input, output, fee, identity, header, witness, and
change output. The validator must reject anything outside permitted wallet funding and change.

**Exit gate:** The wallet signs exactly the reviewed authority and economics.

### Stage 7: Implement Executor Scheduling and Submission Safety

**Implement:** Add preferred/fallback clocks derived from canonical epochs, per-operation queue keys,
profitability checks, dry-run limits, bounded fee selection, stale-input reload, contention handling,
and v1/v2 adapter separation.

**Verify:** Test preferred success, preferred timeout, fallback takeover, owner race, two fallback
executors, stale fee inputs, dropped transactions, restarts, reorgs, missed windows, and low
compensation. Only one canonical successor may be accepted.

**Exit gate:** The executor cannot execute early, exceed limits, claim another operator's work, or
turn an operational outage into a loss of owner control.

### Stage 8: Extend API, Indexer, and Database

**Implement:** Project the Job, DAO Vault, Compensation Cell, prepare credit, service settlement,
operator window, and canonical transaction status. Add additive migrations and v2 endpoints while
preserving v1 responses.

**Verify:** Rebuild the complete read model from chain data. Test partial indexing, missing cells,
reorg rollback, duplicate events, pending submissions, API outage, and a database reset.

**Exit gate:** No API or database field can authorize spending or hide a chain contradiction.

### Stage 9: Add Simple User Interfaces

**Implement:** Update setup, review, list, detail, activity, sweep, close, rotation, and recovery
screens. Use simple terms: preferred operator, backup operator, earned compensation, service charge,
network fee, recoverable reserve, and available to withdraw.

**Verify:** Desktop/mobile browser tests, keyboard and screen-reader checks, slow/error states, wallet
rejection, stale review, fallback transition, and owner recovery. Do not expose raw epochs or block
numbers as primary copy.

**Exit gate:** A nontechnical user can explain who acts first, when another operator can take over,
which charges are paid, and why the original amount remains protected.

### Stage 10: External Operator Package and Drill

**Implement:** Publish a versioned executor package or container, example configuration, manifest
verification, funding guidance, health checks, metrics, discovery command, and recovery-safe
shutdown procedure. Hosted API access must be optional.

**Verify:** Give a fresh machine and testnet fee Cell to someone unfamiliar with the project. They
must independently discover a job, verify deployed scripts, dry-run, execute a fallback claim, and
confirm payment using public RPC/indexer endpoints.

**Exit gate:** Publish the exact version, setup time, commands, transaction hashes, failures, and
operator feedback. A project developer may observe but must not provide private configuration or run
the transaction for them.

### Stage 11: Deploy and Soak on Testnet

**Implement:** Deploy reproducible immutable binaries, update manifests and deployment hashes, run
database migrations, deploy API/executors/frontend, and retain v1 service support.

**Verify:** Compare deployed output bytes with audited binaries, complete at least one full v2 DAO
cycle, exercise preferred and fallback executors, sweep compensation, perform owner recovery, and
run a minimum 30-day reliability soak.

**Exit gate:** Public evidence covers uptime, latency, retries, conflicts, dropped transactions,
reorg handling, missed windows, fee/cycle observations, service settlements, and owner exits.

## 9. Mandatory Test Matrix

| Category          | Required cases                                                                                                   |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| Principal         | Exact preservation, minimum capacity, maximum uint64, overflow, attempted fee deduction                          |
| Compensation      | Zero, below fees, equal fees, above fees, below payout capacity, multiple accumulated cycles                     |
| Service payment   | Same operator, different operators, owner claim, absent prepare credit, forged credit, redirected output         |
| Timing            | Before primary window, exact primary bound, before fallback, exact fallback bound, changed metric, missed cutoff |
| Operators         | Preferred online, preferred offline, fallback online, all offline, rotation, compromised removed operator        |
| Compensation Cell | Setup, increment, sweep, close, stale outpoint, duplicate successor, seed theft, wrong payout                    |
| Transactions      | Size ceiling, cycle ceiling, fee ceiling, stale inputs, conflicting spend, dropped tx, no rebroadcast loop       |
| Reorgs            | Prepare reorg, claim reorg, accumulator rollback, reward rollback, canonical reinclusion                         |
| Compatibility     | V1 discovery/execution/recovery, V2 isolation, wrong script version, mixed v1/v2 cells                           |
| Independence      | No hosted API, empty database, empty Redis, project executors offline, public RPC/indexer only                   |

## 10. Security Review Checklist

Before every implementation commit or deployment candidate, review:

- Can any controlled output receive more than its exact permitted delta?
- Can a copied job or shadow payload pair with a real DAO or Compensation Cell?
- Can an executor redirect principal, compensation, another operator's payment, or the seed reserve?
- Can a fallback executor act before its exact lower bound?
- Can an approved prepare executor deliberately execute late, and is that residual risk documented?
- Can low compensation create a permanent claim failure?
- Can an owner recover with API, database, Redis, and executors unavailable?
- Can two successful transactions claim the same work or create two live successors?
- Does every integer use checked arithmetic and canonical encoding?
- Does every changed script have mutation tests, fuzz coverage, benchmark evidence, and a
  reproducible binary?

## 11. Deployment and Compatibility Rules

1. Do not overwrite or reinterpret the v1 manifest.
2. Register v1 and v2 code hashes simultaneously.
3. Route jobs by exact policy code hash and payload version.
4. Keep v1 executor and recovery support until every v1 job is terminal or owner-recovered.
5. Do not auto-migrate funds. A v1-to-v2 migration requires a separate owner-reviewed transaction.
6. Verify each testnet deployment transaction is committed and sufficiently confirmed.
7. Compare every deployed output byte-for-byte with the audited local binary before updating
   manifests.
8. Update registry, API, database, executor, frontend, and public verification tools atomically.
9. Roll back application services if identity hashes disagree; immutable contracts remain deployed
   but inactive.
10. Keep mainnet disabled until an independent audit and a separate release decision.

## 12. Operational Evidence

The final report must publish:

- transaction size, cycles, fee rate, and paid fee for every operation type;
- preferred-operator response time and fallback activation time;
- executor collisions and losing fee cost;
- compensation, prepare payment, claim payment, net user amount, and seed balance;
- missed-window and low-compensation decisions;
- reorg, drop, retry, and restart outcomes;
- owner sweep, close, and service-independent recovery evidence;
- external operator setup and execution evidence; and
- exact deployed code hashes, cell deps, source revision, and binary SHA-256 values.

## 13. Decision Checkpoints

| Decision                        | Status              | Resolution or closing stage                                                                    |
| ------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------- |
| Prepare-credit representation   | Accepted for schema | Authenticated Job successor commitment; no separate typed receipt Cell                         |
| Compensation Cell requirement   | Accepted            | Mandatory per-job Cell with owner-recoverable seed under ADR 0010                              |
| Fee shortfall                   | Accepted            | Principal first, then partial prepare fee, partial claim fee, then owner compensation; no debt |
| Operator payment representation | Accepted            | Same-lock ordinary identity accumulator; exact delta proven without dust output                |
| Preferred claimant              | Accepted            | The confirmed preparer receives the first claim window                                         |
| Prepare fallback set            | Accepted            | One through eight sorted unique operators opening simultaneously at takeover                   |
| Safe takeover interval          | Accepted            | Minimum `1/20` canonical epoch plus pending-transaction and canonical-input reload guards      |
| Owner claim timing              | Accepted            | Owner completion and recovery are available at maturity without waiting for fallback           |

Every pending decision requires written reasoning, adversarial cases, occupied-capacity impact, and
a test fixture before contract implementation proceeds.

## 14. Work and Commit Rules

For every stage:

1. implement only that stage's scope;
2. add focused positive, negative, boundary, and mutation tests;
3. run affected unit, integration, contract, type, lint, format, and secret checks;
4. audit authorization, value conservation, timing, versioning, stale inputs, and recovery;
5. fix all findings before moving forward;
6. distinguish local fixtures from public testnet evidence; and
7. do not commit or deploy unless explicitly requested by the repository owner.

If commits are requested later, each stage should remain independently auditable, and commit
messages must not use the prohibited project sequencing term.

---

This plan is a design and implementation guide, not evidence that the changes already exist. The
current v1 behavior remains authoritative until v2 contracts, applications, independent operation,
and public testnet evidence pass every gate above.
