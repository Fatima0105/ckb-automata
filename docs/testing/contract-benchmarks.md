# Contract Cycle and Capacity Benchmarks

`contracts/benchmarks.json` is the machine-readable cost baseline for contract
execution and occupied capacity. It is measured with `ckb-testtool` `1.1.1`
against the release-mode RISC-V binaries.

The cycle cases include every supported Job Lock operation, campaign creation,
both deadline outcomes, a recurring successor, and a recurring final run. Each
family also includes a late invalid transaction. Invalid costs are found by
binary-searching the smallest cycle limit that reaches the expected script
rejection instead of the VM cycle-limit error.

Run the committed comparison after building the contracts:

```text
npx --yes pnpm@12.5.1 contracts:build
npx --yes pnpm@12.5.1 contracts:bench
```

When an intentional contract change affects cost, regenerate the report and
review every changed measurement and its 25 percent rounded budget:

```text
npx --yes pnpm@12.5.1 contracts:bench:update
```

Normal contract tests compare path identity, outcomes, capacities, and payload
sizes exactly, then fail when a fresh cycle measurement exceeds its committed
budget. Exact secp verification cost can vary with the synthetic fixture
outpoints and signed transaction hash, so `measuredCycles` records the reviewed
sample while `budgetCycles` is the stable gate. `@ckb-automata/core` reads the
committed cell measurements for Job Cell and campaign funding minima, so
transaction quotes do not depend on hand-maintained capacity constants.

The report is local deterministic CKB-VM evidence. It is not a public testnet
fee measurement and does not include an executor fee-rate estimate.

The capacity report also includes Stage 3 prototype measurements for a zero-argument payout Cell and
the five-hash, 160-byte-args DAO Harvest V2 Compensation Cell. Prototype entries are occupied-capacity
evidence only; they do not claim that a V2 contract binary is already implemented.

DAO Harvest V2's complete-transaction budgets and pre-signing guard are documented in
[`dao-harvest-v2-transaction-boundaries.md`](./dao-harvest-v2-transaction-boundaries.md). The V1
policy measurements in this report are the comparable baseline, not evidence that unimplemented V2
paths have already been measured.
