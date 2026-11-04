# DAO Harvest V2 Transaction Boundaries

Status: Pre-implementation budget baseline

These limits are signing and submission gates for DAO Harvest V2. They are deliberately separate
from V1 and do not change any deployed transaction. `@ckb-automata/core` measures the complete
Molecule-serialized transaction, including witnesses, and rejects a build before signing when any
limit is exceeded.

## Operation ceilings

| Operation | Bytes |    Cycles | Fee rate (shannons/KB) | Fee (shannons) | Inputs | Outputs | Headers | Cell deps | Job Cells               |
| --------- | ----: | --------: | ---------------------: | -------------: | -----: | ------: | ------: | --------: | ----------------------- |
| Setup     | 4,096 | 3,000,000 |                100,000 |        409,600 |     16 |       8 |       0 |         8 | 0 inputs / 1 output     |
| Prepare   | 3,072 | 1,200,000 |                100,000 |        307,200 |      4 |       4 |       1 |         8 | 1 input / 1 output      |
| Claim     | 4,096 | 4,000,000 |                100,000 |        409,600 |      8 |       8 |       2 |         8 | 1 input / 0 or 1 output |
| Sweep     | 2,048 | 2,500,000 |                100,000 |        204,800 |      3 |       3 |       0 |         6 | 1 input / 1 output      |
| Rotation  | 3,072 | 3,000,000 |                100,000 |        307,200 |      3 |       3 |       0 |         8 | 1 input / 1 output      |
| Recovery  | 4,096 | 4,000,000 |                100,000 |        409,600 |      6 |       6 |       2 |         8 | 1 input / 0 outputs     |

The fee ceiling is `ceil(maximum_bytes * maximum_fee_rate / 1,000)`. It is an executor network-fee
limit, not a service charge. Operators fund this fee from their own inputs. A transaction must stay
within both the fee-rate limit and the absolute fee limit.

Setup consumes no Job Cell and creates exactly one. Every later operation consumes exactly one Job
Cell. Prepare, sweep, and rotation create one successor; claim creates one except on the final cycle;
recovery and terminal claim create none. Multiple Job inputs or outputs are forbidden even when byte
and cycle totals remain below their limits, so cross-job and cross-user batching rejects before
signing.

## Evidence and margins

The current release-mode CKB-VM report in `contracts/benchmarks.json` measures the comparable V1
prepare policy at 415,284 cycles with a 600,000-cycle budget and the V1 roll policy at 378,750
cycles with a 500,000-cycle budget. The V2 prepare ceiling is twice the current prepare budget. The
V2 claim ceiling is eight times the current roll budget because claim adds compensation accounting,
two possible operator accumulators, and Compensation Cell validation.

Setup, sweep, rotation, and recovery do not yet have final V2 binaries. Their limits are conservative
pre-implementation budgets, not measured claims. Stages 3 through 5 must benchmark their exact
fixtures. A final binary that exceeds one of these ceilings fails the gate; the ceiling is not raised
silently to make a build pass.

The unit fixtures pass exact-limit values and reject one byte, one cycle, one fee shannon, one input,
one output, one header, or one dependency above the relevant limit. RPC dry-run cycles are required
input to the guard. Missing or malformed evidence fails closed. Contract-level CKB-VM cycle tests
remain authoritative for individual script paths; RPC dry-run evidence covers the complete signed
transaction and all script groups.

## Takeover interval

The minimum preferred-operator interval is `1/20` of a canonical epoch. The fallback scheduler also
requires the preferred transaction to be absent or non-committed and reloads canonical inputs before
building. At CKB's target epoch duration this is roughly twelve minutes, comfortably beyond the
five-block application confirmation depth without encoding wall-clock time into consensus rules.

Both prepare and claim takeover values use the same absolute-epoch `since` metric as their opening
or maturity value. Applications may choose a longer interval. They may not choose a shorter interval,
convert it to another `since` metric, or treat an unconfirmed preferred transaction as failed merely
because the takeover epoch has arrived.

## Enforcement sequence

1. Build one operation from a fresh canonical snapshot.
2. Complete permitted operator fee inputs, change, and witnesses.
3. Count the exact Job inputs and structural fields.
4. Serialize the complete signed transaction and measure its byte length.
5. Calculate its actual fee and fee rate from resolved inputs and outputs.
6. RPC dry-run the exact transaction.
7. Apply `assertHarvestV2TransactionWithinLimits` before signing or submission approval.
8. Reload and rebuild after any stale-input, header, or contention result.

No estimate, unsigned-size measurement, or per-script benchmark may substitute for the final signed
transaction dry run.
