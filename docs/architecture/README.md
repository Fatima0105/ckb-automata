# Architecture Decision Records

This directory records the technology and deployment decisions that define the
CKB Automata showcase. The records are accepted for the public testnet showcase
and apply until replaced by a later ADR.

| ADR                                                                          | Decision                              | Status   |
| ---------------------------------------------------------------------------- | ------------------------------------- | -------- |
| [0001](./0001-use-a-pnpm-monorepo.md)                                        | Use a pnpm monorepo                   | Accepted |
| [0002](./0002-keep-ccc-wallet-code-in-the-browser.md)                        | Keep CCC wallet code in the browser   | Accepted |
| [0003](./0003-separate-the-api-and-executor.md)                              | Separate the NestJS API and executor  | Accepted |
| [0004](./0004-use-postgresql-for-the-read-model.md)                          | Use PostgreSQL for the read model     | Accepted |
| [0005](./0005-use-redis-and-bullmq-for-durable-work.md)                      | Use Redis and BullMQ for durable work | Accepted |
| [0006](./0006-use-rust-for-ckb-scripts.md)                                   | Use Rust for CKB scripts              | Accepted |
| [0007](./0007-release-to-ckb-testnet-only.md)                                | Release to CKB testnet only           | Accepted |
| [0008](./0008-separate-plain-payments-from-campaigns.md)                     | Separate payments from campaigns      | Accepted |
| [0009](./0009-settle-harvest-service-fees-from-compensation.md)              | Settle harvest fees from compensation | Accepted |
| [0010](./0010-accumulate-harvest-compensation-in-an-owner-vault.md)          | Accumulate compensation per job       | Accepted |
| [0011](./0011-use-preferred-harvest-operators-with-delayed-fallback.md)      | Use preferred operators with fallback | Accepted |
| [0012](./0012-use-bound-compensation-and-same-lock-operator-accumulators.md) | Bind compensation and operator value  | Accepted |

## Record format

Each ADR states its context, decision, alternatives, consequences, and reversal
cost. A decision is changed by adding a new ADR that supersedes the old record;
accepted records are not rewritten to hide earlier constraints.

The acceptance baseline is the definition of done and scope boundary in
[`implementation.md`](../../implementation.md). These records do not imply that
the separate acceptance-owner approval gate has been completed.
