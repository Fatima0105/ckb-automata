# CKAutomata external operator

This package lets an independent operator process CKAutomata DAO Harvest, scheduled-payment, and recurring-payment jobs through public CKB testnet RPC and indexer endpoints. Execution does not depend on the CKAutomata API, database, Redis, or hosted executor credentials. The optional registry command uses the public API only to publish the operator's verified name, address, services, and hosted endpoint.

The user may choose a preferred operator. That operator can act at the scheduled time. If it does not act, another compatible operator can take over at the later block committed in the Job Cell. The contracts keep the recipient, amount, timing, DAO principal, redeposit, and service payment fixed.

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
$env:OPERATOR_AUTOMATION_MANIFEST_PATH = "deploy/manifests/operator-automation-testnet.json"
$env:OPERATOR_LOCK_RESOLUTIONS_PATH = "operator-locks.json"
$env:OPERATOR_PRIVATE_KEY = "0x..."
```

Check the public configuration and deployed code before spending anything:

```powershell
pnpm operator config
pnpm operator verify-manifest
```

Run the one-time Harvest accumulator setup (scheduled and recurring payments do not need an accumulator):

```powershell
pnpm operator setup
```

If setup returns `submitted`, keep its transaction hash and wait for confirmation:

```powershell
pnpm operator confirm --tx-hash 0x...
```

Run `setup` again after confirmation. It must return `ready` with the live accumulator outpoint.

## Discover work

List live V2 jobs:

```powershell
pnpm operator discover --kind all
```

Use the `txHash:index` outpoint of a prepared job to build an immutable review bundle:

```powershell
pnpm operator build --kind harvest --job-out-point 0x...:0x0 --output .\claim-bundle.json
pnpm operator dry-run --bundle .\claim-bundle.json
pnpm operator submit --bundle .\claim-bundle.json
pnpm operator confirm --tx-hash 0x...
```

`build` only accepts a committed, live, prepared V2 job. It reloads the job, vault, compensation and credited preparer accumulator from chain data; verifies their commitments; calculates the DAO compensation from the inclusion headers; selects the next cycle when needed; and builds the fallback claim against the audited manifest. `dry-run` re-resolves every input and refuses redirection, excessive charges, stale inputs, early takeover, unprofitable execution, or transaction-limit violations.

If another operator wins first, the bundle becomes stale and dry-run or submit stops. Discover the current jobs again. Never retry a stale bundle blindly.

## Execute scheduled and recurring payments

The payment contracts use the same preferred-then-takeover rule. Build with the job's actual kind:

```powershell
pnpm operator build --kind scheduled --job-out-point 0x...:0x0 --output .\payment.json
pnpm operator build --kind recurring --job-out-point 0x...:0x0 --output .\payment.json
pnpm operator dry-run --bundle .\payment.json
pnpm operator submit --bundle .\payment.json
```

Payment jobs commit lock hashes. If a recipient script cannot be recovered from the creation transaction, provide it in `operator-locks.json` using RPC field names:

```json
[
  {
    "code_hash": "0x...",
    "hash_type": "type",
    "args": "0x..."
  }
]
```

The operator verifies every supplied script against the committed hash. The file cannot change the recipient. It only supplies the full script needed to construct the already-authorized output.

## Docker

Build from the repository root:

```powershell
Copy-Item deploy/operator/operator.env.example deploy/operator/operator.env
docker build --file deploy/docker/operator.Dockerfile --tag ckautomata/operator:0.3.0 .
docker run --rm --env-file deploy/operator/operator.env ckautomata/operator:0.3.0 verify-manifest
```

Mount a local directory when creating or reading a bundle:

```powershell
docker run --rm --env-file deploy/operator/operator.env --volume "${PWD}:/work" ckautomata/operator:0.3.0 build --kind scheduled --job-out-point 0x...:0x0 --output /work/payment.json
```

For a continuously supervised health endpoint, set the private key in
`deploy/operator/operator.env` and run:

```powershell
docker compose --file deploy/operator/compose.yml up --detach --build
```

## Register the hosted operator

Registration is optional. It makes a healthy operator available by name in CKAutomata's preferred-operator dropdown for new automations. It does not change existing jobs or their committed operator rules.

Set these values before starting the public service:

```env
OPERATOR_NAME=Community Operator
OPERATOR_PUBLIC_URL=https://operator.example
CKAUTOMATA_API_URL=https://api.example
OPERATOR_SERVICES=deadline,recurring
```

`OPERATOR_PUBLIC_URL` must be a public HTTPS origin. Route it to the operator health port through your hosting platform or TLS reverse proxy. Confirm that `GET /operator-info` and `GET /health/ready` return HTTP 200, then register:

```powershell
pnpm operator register
```

The command authenticates with the configured operator key through CKAutomata's single-use off-chain challenge. The API verifies that the hosted lock, CKB testnet genesis, manifest hashes, and capabilities match before adding the operator. It never receives the private key.

The bundled operator can be listed for scheduled and recurring payments. Only add `dao-harvest` when the hosted runtime also implements preferred Harvest preparation; the bundled manual Harvest command currently handles permissionless fallback claims after takeover.

Re-run `register` to refresh a changed name, endpoint, or capability list. Repeated health failures remove the operator from new dropdown choices without changing any automation that already exists on-chain.

## Monitoring and shutdown

Run the health server separately when supervising the operator:

```powershell
pnpm operator serve
```

- readiness: `GET /health/ready`
- liveness: `GET /health/live`
- metrics: `GET /metrics`
- public registry identity: `GET /operator-info`

Before shutdown, stop starting new commands and retain every submitted transaction hash until it is committed or rejected. A submitted claim does not need this process to remain online, but confirmation must be checked before reusing funds or rebuilding work.

## Scope

This release supports DAO Harvest V2 fallback claims and operator-bound scheduled and recurring payments. Harvest preparation remains limited by the job's approved prepare-operator set. Payment takeover opens to any compatible operator at the exact fallback block committed by the user.
