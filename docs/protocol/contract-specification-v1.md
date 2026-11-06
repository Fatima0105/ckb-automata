# Contract Specification V1

This document is the implementer entry point for the CKB Automata proof-of-concept
contracts. It is normative for protocol V1 unless it explicitly labels a statement
as operational or advisory. The checked-in Molecule files remain the only inputs to
binding generation, and the Rust scripts remain authoritative when prose and code
cannot be reconciled.

The public testnet manifest registers `job-lock`, `deadline-policy`,
`recurring-policy`, `demo-campaign-type`, `campaign-lock`,
`harvest-vault-lock`, and `dao-harvest-policy`, with immutable deployment
outpoints and binary digests. V1 is for local development and CKB testnet
evaluation; no mainnet deployment is supported.

The DAO Harvest payload and scripts have CKB-VM conformance evidence and a
manifest-pinned public testnet deployment. Source changes made after the pinned
binary digests, including new owner operations, are not live until a new
deployment and integrity-checked manifest revision are published.

## Encoding and Hashing

- Integers are unsigned little-endian values with the width declared by the schema.
- Capacity values are shannons. Code must not convert a capacity or chain counter
  through an IEEE-754 JavaScript `number`.
- Byte hashes are 32 bytes. Script hashes use CKB's canonical serialized `Script`.
- Protocol hashes use BLAKE2b-256 with personalization `ckb-default-hash` over
  `utf8(domain) || 0x00 || uint32_le(body_length) || body`.
- A field table below gives the canonical field order inside a Molecule table. It is
  not permission to concatenate fields without the Molecule table header and offsets.

## Canonical Schemas

| Type                  | Canonical source                                                   | Fields in order                                                                                                                                                                                                                                                                                                                             |
| --------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JobDataV1`           | [`job_v1.mol`](../../contracts/schemas/job_v1.mol)                 | `version:u16`, `flags:u16`, `job_id:byte32`, `sequence:u64`, `state:u8`, `trigger_kind:u16`, `trigger_params_hash:byte32`, `policy_script_hash:byte32`, `payload_hash:byte32`, `reward:u64`, `remaining_budget:u64`, `not_before:u64`, `not_after:u64`, `remaining_runs:u32`, `cancel_lock_hash:byte32`                                     |
| `RecurringPayloadV1`  | [`recurring_v1.mol`](../../contracts/schemas/recurring_v1.mol)     | `version:u16`, `owner_lock_hash:byte32`, `recipient_lock_hash:byte32`, `amount:u64`, `interval_blocks:u64`, `first_not_before:u64`, `total_runs:u32`, `reward:u64`, `final_refund_kind:u8`                                                                                                                                                  |
| `CampaignDataV1`      | [`campaign_v1.mol`](../../contracts/schemas/campaign_v1.mol)       | `version:u16`, `state:u8`, `campaign_id:byte32`, `pledged:u64`, `pledge_count:u32`, `target:u64`, `deadline_since:u64`, `success_lock_hash:byte32`, `refund_commitment:byte32`                                                                                                                                                              |
| `DaoHarvestPayloadV1` | [`dao_harvest_v1.mol`](../../contracts/schemas/dao_harvest_v1.mol) | `version:u16`, `owner_lock_hash:byte32`, `payout_lock_hash:byte32`, `vault_lock_hash:byte32`, `dao_type_hash:byte32`, `principal_capacity:u64`, `prepare_executor_set_hash:byte32`, `executor_reward:u64`, `min_compensation:u64`, `prepare_buffer_epochs:u64`, `confirmation_margin_epochs:u64`, `total_cycles:u32`, `end_epoch_since:u64` |
| `OperatorPayloadV1`   | [`operator_v1.mol`](../../contracts/schemas/operator_v1.mol)       | `version:u16`, `preferred_executor_lock_hash:byte32`, `takeover_delay_blocks:u64`, `application_payload:bytes`                                                                                                                                                                                                                              |

The generated Rust and TypeScript bindings and the JSON fixtures under
`contracts/fixtures` are checked representations of these sources. See
[`job-data-v1.md`](job-data-v1.md),
[`recurring-payload-v1.md`](recurring-payload-v1.md), and
[`campaign-state-v1.md`](campaign-state-v1.md) for deployed field semantics. See
[`dao-harvest-v1.md`](dao-harvest-v1.md) for the Harvest payload and
transaction layouts.

The versioned scheduled and recurring operator-selection extension is documented in
[`operator-selection-v1.md`](operator-selection-v1.md). It uses `job-lock-v3`,
`deadline-policy-v2`, and `recurring-policy-v2` without changing existing V1 jobs.

## Witness Envelopes

Scripts read CKB `WitnessArgs`; the byte layouts below are the contents of its
optional fields, not complete serialized `WitnessArgs` values. The relevant witness
is the first witness for the script group unless stated otherwise.

### Job Lock `input_type`

| First byte | Operation                    | Remaining bytes                                                                                                                  |
| ---------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `0`        | Execute                      | `reward_output_index:u32`, `executor_lock_hash:byte32`, `controlled_count:u8`, then that many distinct `output_index:u32` values |
| `1`        | Cancel                       | None; total payload length is one byte                                                                                           |
| `2`        | Recover                      | None; total payload length is one byte                                                                                           |
| `3`        | Top up                       | `successor_output_index:u32`; total payload length is five bytes                                                                 |
| `4`        | Rotate DAO prepare executors | `successor_output_index:u32`; owner-authorized and DAO Harvest only                                                              |

Execute has an exact length of `38 + controlled_count * 4`, where the count is
from 1 through 16. The reward index must be in the controlled set. The executor
lock hash must also appear on a distinct co-spent input so its own lock group
authorizes the transaction.

### Policy and Campaign Payloads

| Script and action               | Witness field | Bytes                                                                                                                 |
| ------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------- |
| Recurring policy create/execute | `output_type` | Complete canonical `RecurringPayloadV1`                                                                               |
| Campaign create                 | `output_type` | Ordered 76-byte pledge records containing `tx_hash:32`, `output_index:u32`, `refund_lock_hash:32`, and `amount:u64`   |
| Campaign refund finalization    | `input_type`  | The same ordered pledge records committed at creation                                                                 |
| Deadline policy finalization    | `input_type`  | The Job Lock execute request; the policy reads and independently checks its reward index and executor lock commitment |
| DAO harvest policy              | `output_type` | Canonical payload; rotation carries old payload, new payload, then the new sorted executor-set proof                  |
| Harvest vault automation        | `lock`        | `mode:0`, operation `0` or `1`, and the bound global Job input index as `u32`                                         |
| Harvest vault owner exit        | `lock`        | `mode:1` and owner operation `2`, `3`, or `4`; DAO `input_type` remains reserved for the deposit-header index         |

Pledge records are strictly ordered by transaction hash and then output index.
Their checked amount sum equals `pledged`, their count equals `pledge_count`, and
their domain-separated hash equals `refund_commitment`.

## Script Invariants

### Job Lock

- A supported live input is V1, flags zero, state `LIVE`, trigger kind 1 through
  6, and has at least one remaining run.
- The input type-script hash equals `policy_script_hash`.
- Execution uses the exact committed `since`, pays exactly one plain reward to
  the witness-committed executor, and conserves the entire Job Cell capacity
  across the declared controlled outputs.
- A one-shot execution creates no Job Lock successor. A recurring execution
  creates exactly one successor, increments sequence by one, decrements runs by
  one, decreases budget, preserves immutable intent, and advances its trigger.
- Cancel, recover, top up, and DAO executor rotation require a distinct co-spent input whose full lock
  hash equals `cancel_lock_hash`.
- Cancel validates a supported live job and returns the complete Job Cell to the
  owner. Recover permits unsupported or invalid but structurally decodable job
  metadata and returns the same complete value. Neither creates a successor or
  pays a job-funded reward.
- Top up creates one owner-selected successor, preserves intent and progress,
  and only increases reward, budget, or both with sufficient added capacity.
  Recurring jobs keep reward unchanged because it is committed by
  `RecurringPayloadV1`; they may increase remaining budget only.
- DAO executor rotation creates one equal-capacity Job successor, preserves all
  job fields except `payload_hash`, and permits the new payload to change only
  `prepare_executor_set_hash`. It neither spends the DAO vault nor pays a reward.

### Recurring Policy

- The policy script has empty args and its full script hash is committed by the
  Job Cell. The immutable payload hash binds owner, recipient, payout amount,
  cadence, total runs, reward, and final-refund behavior.
- Every execution uses a valid absolute block lower bound derived as
  `first_not_before + sequence * interval_blocks` with checked arithmetic.
- A non-final run pays one plain recipient output and creates one constrained
  successor. Its controlled list is exactly reward, payout, and successor; its capacity decreases
  by exactly the reward and payout, and its remaining budget decreases by exactly the reward. A
  final run pays the executor and recipient and returns the exact residual to the owner without a
  successor.

### Deadline Policy and Campaign

- Deadline policy args and payload bind the full type-script hash of the one
  campaign it may finalize.
- Campaign creation has one type-group output. Its type args and `campaign_id`
  equal the hash of input 0's outpoint and the campaign output index; it also
  has canonical pledge records and spendable capacity exactly equal to `pledged`.
- Finalization co-spends the open campaign and one-shot deadline Job Cell at the
  committed absolute block lower bound.
- `pledged >= target` deterministically selects success; success pays the exact
  pledged value to `success_lock_hash`. Otherwise the transaction produces the
  exact committed refunds. Both paths retain a terminal campaign marker at only
  its occupied capacity.

### DAO Harvest Vault and Policy

- Vault args bind the immutable Job ID, owner lock hash, and deployed Job Lock
  hash. Automation spends require that exact co-spent Job Cell; owner spends
  require a distinct input with the committed owner lock hash.
- The policy commits the exact vault and Nervos DAO type script hashes. Setup
  creates one deposited vault cell and an even action count of two per cycle.
- Prepare requires a canonical approved executor proof and preserves the exact
  principal, vault lock, and DAO type while changing eight zero data bytes to a
  withdrawal deposit-block marker.
- Roll uses the linked deposit and withdrawal headers to calculate maximum DAO
  withdrawal capacity. It atomically creates a fresh zero-data deposit with the
  exact principal and one plain payout containing all compensation.
- `min_compensation` is a pre-prepare scheduling preference. Executors should
  not prepare when projected compensation is below it, but once preparation
  fixes the compensation, the value cannot block the claim and re-deposit
  transition.
- Rewards remain in the Job Cell accounting. The vault never pays an executor
  and does not consume `input_type`, which remains available to the DAO script.

The detailed transition rules are indexed in
[`job-lock-execution-mode.md`](job-lock-execution-mode.md),
[`job-lock-owner-mode.md`](job-lock-owner-mode.md),
[`job-lock-top-up.md`](job-lock-top-up.md),
[`recurring-payout-validation.md`](recurring-payout-validation.md),
[`campaign-creation.md`](campaign-creation.md),
[`deadline-creation-builder.md`](deadline-creation-builder.md),
[`recurring-creation-builder.md`](recurring-creation-builder.md),
[`campaign-success-finalization.md`](campaign-success-finalization.md), and
[`campaign-failure-finalization.md`](campaign-failure-finalization.md).

## Output Ordering Policy

Full transaction output order is semantic only where listed here. Everywhere
else an output is located by its witness index, unique lock hash, or type group;
builders should still use the order below for deterministic review.

| Operation                    | Required or canonical order                                                                                                                                     |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Execute, non-final recurring | Controlled list: executor reward, recipient payout, successor. The scripts identify the unique payout and successor independently.                              |
| Execute, final recurring     | Controlled list must be exactly executor reward, recipient payout, owner residual.                                                                              |
| Cancel or recover            | Full transaction output index `0` is the complete plain owner refund.                                                                                           |
| Top up                       | Witness points to the only Job Lock successor; no other output position is consensus-significant.                                                               |
| DAO executor rotation        | Witness points to the only Job Lock successor; the DAO vault is not spent and remains at its existing outpoint.                                                 |
| Campaign creation            | The campaign is the only output in its type group; pledge records, not transaction outputs, use strict outpoint ordering.                                       |
| Campaign success             | Canonical Job-controlled order is executor reward, owner refund. The unique success payout and terminal marker are found by lock/type identity.                 |
| Campaign refund              | Canonical Job-controlled order is executor reward, owner refund. Campaign refunds are contiguous in pledge-record order immediately before the terminal marker. |
| DAO prepare                  | Canonical order is successor vault, executor reward, successor Job Cell, executor change; scripts locate protected outputs by identity.                         |
| DAO roll                     | Canonical order is new vault deposit, executor reward, compensation payout, optional owner residual, executor change.                                           |

When the DAO compensation payout and owner are the same lock, the exact compensation
output remains required and the additional plain owner residual is permitted.

Executor fee inputs and change are outside the job-controlled set. Their placement
does not permit omission, duplication, or redirection of contract-controlled value.

## Error Codes

An on-chain rejection returns one stable signed-byte exit value. The canonical
copy and off-chain ranges are in [`error-codes.md`](error-codes.md) and
`packages/core/src/errors.ts`.

| Code | Rust variant                 | Meaning                                                     |
| ---: | ---------------------------- | ----------------------------------------------------------- |
| `10` | `InvalidData`                | Malformed or internally inconsistent data                   |
| `11` | `UnsupportedVersion`         | Unsupported schema version                                  |
| `12` | `ReservedFlags`              | A reserved Job flag is set                                  |
| `13` | `InvalidState`               | Invalid on-chain state marker                               |
| `14` | `UnsupportedTrigger`         | Unsupported trigger kind                                    |
| `15` | `InvalidWitnessMode`         | Invalid operation or witness byte layout                    |
| `16` | `MissingOwnerAuthorization`  | Required owner input is absent or wrong                     |
| `17` | `PolicyHashMismatch`         | Policy type script differs from the commitment              |
| `18` | `TriggerHashMismatch`        | Trigger commitment or next trigger is wrong                 |
| `19` | `PayloadHashMismatch`        | Policy payload or pledge records differ from the commitment |
| `20` | `JobIdMismatch`              | Job or campaign identity changed                            |
| `21` | `SequenceMismatch`           | Successor sequence is not exactly next                      |
| `22` | `NotYetEligible`             | Required eligibility evidence is not mature                 |
| `23` | `InvalidSince`               | Invalid, unsupported, or mismatched `since`                 |
| `24` | `SuccessorCountMismatch`     | Missing, extra, or forbidden successor                      |
| `25` | `SuccessorInvariantMismatch` | Protected successor field changed                           |
| `26` | `BudgetIncrease`             | Execution increased remaining budget                        |
| `27` | `RunsIncrease`               | Execution failed to decrement remaining runs                |
| `28` | `CapacityNotConserved`       | Contract-controlled capacity is missing or misallocated     |
| `29` | `RewardAmountMismatch`       | Reward capacity differs from the commitment                 |
| `30` | `RewardRecipientMismatch`    | Reward lock differs from the authorized executor            |
| `31` | `RewardForbidden`            | An owner exit attempted a job-funded reward                 |
| `32` | `InvalidApplicationState`    | Policy-specific state or output shape is invalid            |
| `33` | `MissingHeader`              | A required transaction header dependency is absent          |
| `34` | `ArithmeticOverflow`         | A protected amount, counter, or schedule overflowed         |
| `35` | `UnsupportedRecovery`        | The requested recovery path is unavailable                  |
| `36` | `InvalidDaoCell`             | A DAO cell is malformed, unrelated, or in the wrong phase   |
| `37` | `PrincipalMismatch`          | The protected original amount changed                       |
| `38` | `PayoutMismatch`             | Compensation has the wrong recipient or amount              |
| `39` | `UnauthorizedExecutor`       | An unapproved executor attempted DAO preparation            |
| `40` | `CompensationBelowMinimum`   | Reserved legacy code; V1 roll no longer emits this error    |
| `41` | `CycleLimitReached`          | A cycle or end-epoch limit forbids the transition           |
| `42` | `InvalidExecutorSet`         | The prepare executor proof differs from the approved set    |
| `43` | `MissingBoundJob`            | A vault spend omitted or substituted its exact Job Cell     |

## Deployment Manifest

`deploy/manifests/local.json` and `deploy/manifests/testnet.json` are the
published SDK targets. Consumers select one only by the connected chain's exact
genesis hash and must reject an unsupported `schemaVersion`, wrong
`genesisHash`, unknown `hashType`, binary hash mismatch, missing contract, or
malformed outpoint.

| Path                                      | Requirement                                                    |
| ----------------------------------------- | -------------------------------------------------------------- |
| `network`, `rpcUrl`, `genesisHash`        | Network label, published RPC default, and exact chain identity |
| `consensus`                               | Active hardfork name and activation epoch                      |
| `nodeVersion`                             | Node build that accepted the deployment                        |
| `artifacts.sourceRevision`                | Git revision used for the reproducible contract binaries       |
| `artifacts.schemaSha256`                  | Aggregate hash of the four canonical Molecule schemas          |
| `secp256k1Blake160`                       | Local signing lock code hash, hash type, and dependency group  |
| `contracts.<name>.codeHash`               | CKB BLAKE2b-256 data hash of the deployed binary               |
| `contracts.<name>.hashType`               | `data1` for every V1 contract                                  |
| `contracts.<name>.cellDep`                | Deployment transaction outpoint and `code` dependency type     |
| `contracts.<name>.binarySha256/sizeBytes` | Independent artifact integrity and size metadata               |
| `deployment`                              | Committed deployment transaction and block                     |
| `verification`                            | Committed deployment or execution evidence plus verifier kind  |

The wallet warning is metadata, not an SDK credential. It publishes only a lock
argument used to identify the deployment account.

The public Pudge deployment is transaction
`0xef471574d2f58c38d3e9d9380d98f853c9bcf5388730a767ac6f1ff35ab8cc64`
in block
`0xad1ef7544eec0c1701cf917a0f92acfb1393eff6b5d5f178c10272c00182c365`.
Run `pnpm contracts:verify:testnet` to resolve every published cell and system
dependency, verify the on-chain bytes and hashes, and execute one CKB-VM fixture
for each script.

The deployed `campaign-lock` is intentionally permissionless and has empty
args. It is used only on a cell whose `demo-campaign-type` script independently
enforces every allowed transition.

## Recovery Recipes

### Normal owner cancellation

1. Load the live Job Cell and decode `JobDataV1`.
2. Co-spend one wallet cell whose full lock hash equals `cancel_lock_hash`.
3. Put byte `0x01` in the first Job Lock group witness `input_type`.
4. Create output zero as a plain cell at `cancel_lock_hash`, with the complete
   Job Cell capacity, no type script, and empty data.
5. Create no Job Lock successor. Fund fees and optional change only from the
   owner wallet input.

### Escape unsupported job metadata

Use the same shape with `input_type = 0x02`. The Job Cell must remain Molecule-
decodable so the script can recover `cancel_lock_hash`. Recovery relaxes Job V1
and policy checks only; every co-spent application cell still runs its own scripts.

### Stale transaction

If either owner recipe loses a race, discard it, query the outpoint, and rebuild
only if a live successor exists. Never retarget a signed recovery transaction to
another outpoint or infer success from mempool absence.

## Reproducible Vectors

From the repository root, the valid vector below creates a canonical campaign
cell and expects the compiled campaign script to return success:

```powershell
cargo test-native --locked campaign_creation::deterministic_campaign_fixture_can_be_created -- --exact
```

Expected result: one test passes and no script error is returned.

The invalid vector mutates target/deadline data and expects stable rejection
codes `10` and `23`:

```powershell
cargo test-native --locked campaign_creation::campaign_creation_rejects_malformed_target_and_deadline -- --exact
```

Expected result: one test passes because every malformed transaction is rejected
with its asserted code. These are native CKB-VM vectors; the local manifest's
`verification` object separately records a real-node campaign-creation transaction
against the deployed code cell.
