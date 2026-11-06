# CKAutomata external operator

This package lets an independent operator discover CKAutomata DAO Harvest V2 jobs and submit a fallback claim through public CKB testnet RPC and indexer endpoints. It does not use the CKAutomata API, database, Redis, or hosted executor credentials.

An external operator can claim after the committed takeover time. The contracts keep the principal, DAO redeposit, recipient, and maximum service charge fixed. The operator only supplies a signed fee cell and receives the bounded claim charge when its transaction succeeds.

## Requirements

- Node.js 24.11.1 and pnpm 12.5.1, or Docker
- a dedicated CKB testnet private key
- at least two plain live cells for that key after setup: one for the reward accumulator setup and one for later transaction fees
- public CKB testnet RPC and indexer URLs

Do not reuse a valuable wallet key. The operator refuses transaction fees above 50,000 shannons, verifies the chain genesis and every audited contract binary, and dry-runs the signed transaction before broadcasting it.

## Native setup

From a clean repository checkout:

```powershell
corepack enable
corepack prepare pnpm@12.5.1 --activate
pnpm install --frozen-lockfile
pnpm --filter @ckb-automata/operator... build

$env:CKB_RPC_URL = "https://testnet.ckb.dev/rpc"
$env:CKB_INDEXER_URL = "https://testnet.ckb.dev/indexer"
$env:CKB_GENESIS_HASH = "0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606"
$env:OPERATOR_MANIFEST_PATH = "deploy/manifests/dao-harvest-v2-testnet.json"
$env:OPERATOR_PRIVATE_KEY = "0x..."
```

Check the public configuration and deployed code before spending anything:

```powershell
pnpm operator config
pnpm operator verify-manifest
```

Run the one-time accumulator setup:

```powershell
pnpm operator setup
```

If setup returns `submitted`, keep its transaction hash and wait for confirmation:

```powershell
pnpm operator confirm --tx-hash 0x...
```

Run `setup` again after confirmation. It must return `ready` with the live accumulator outpoint.

## Execute a fallback claim

List live V2 jobs:

```powershell
pnpm operator discover
```

Use the `txHash:index` outpoint of a prepared job to build an immutable review bundle:

```powershell
pnpm operator build --job-out-point 0x...:0x0 --output .\claim-bundle.json
pnpm operator dry-run --bundle .\claim-bundle.json
pnpm operator submit --bundle .\claim-bundle.json
pnpm operator confirm --tx-hash 0x...
```

`build` only accepts a committed, live, prepared V2 job. It reloads the job, vault, compensation and credited preparer accumulator from chain data; verifies their commitments; calculates the DAO compensation from the inclusion headers; selects the next cycle when needed; and builds the fallback claim against the audited manifest. `dry-run` re-resolves every input and refuses redirection, excessive charges, stale inputs, early takeover, unprofitable execution, or transaction-limit violations.

If another operator wins first, the bundle becomes stale and dry-run or submit stops. Discover the current jobs again. Never retry a stale bundle blindly.

## Docker

Build from the repository root:

```powershell
Copy-Item deploy/operator/operator.env.example deploy/operator/operator.env
docker build --file deploy/docker/operator.Dockerfile --tag ckautomata/operator:0.2.0 .
docker run --rm --env-file deploy/operator/operator.env ckautomata/operator:0.2.0 verify-manifest
```

Mount a local directory when creating or reading a bundle:

```powershell
docker run --rm --env-file deploy/operator/operator.env --volume "${PWD}:/work" ckautomata/operator:0.2.0 build --job-out-point 0x...:0x0 --output /work/claim-bundle.json
```

For a continuously supervised health endpoint, set the private key in
`deploy/operator/operator.env` and run:

```powershell
docker compose --file deploy/operator/compose.yml up --detach --build
```

## Monitoring and shutdown

Run the health server separately when supervising the operator:

```powershell
pnpm operator serve
```

- readiness: `GET /health/ready`
- liveness: `GET /health/live`
- metrics: `GET /metrics`

Before shutdown, stop starting new commands and retain every submitted transaction hash until it is committed or rejected. A submitted claim does not need this process to remain online, but confirmation must be checked before reusing funds or rebuilding work.

## Scope

This release supports permissionless DAO Harvest V2 fallback claims. Preferred and fallback preparation remain limited by each job's immutable approved prepare-operator policy. Scheduled and recurring payment executors use different protocols and are not handled by this package.
