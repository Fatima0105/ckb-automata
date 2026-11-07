# Host a CKAutomata external operator

This package lets an independent operator host a public CKAutomata identity and process supported CKB testnet automations without access to CKAutomata's private database, Redis, or hosted executor credentials.

Hosting has two separate parts:

1. `serve` keeps a public identity, readiness, and metrics endpoint online so CKAutomata can verify and list the operator.
2. The execution commands discover, build, dry-run, submit, and confirm transactions.

The bundled `serve` command does **not** automatically submit transactions. Hosting and registration make the operator selectable; the operator must still run the execution commands or operate a separate scheduler that invokes them safely.

## What can be advertised

The bundled operator supports scheduled and recurring payments as a preferred operator and as a later takeover operator.

Use this default capability list:

```env
OPERATOR_SERVICES=deadline,recurring
```

Do not advertise `dao-harvest` merely because the CLI can claim an eligible Harvest fallback. A preferred DAO Harvest operator must also run the preparation step at the right time. The bundled manual Harvest flow currently covers permissionless fallback claims after takeover.

Existing automations are never rewritten by registration, removal, downtime, or a name change. Their operator rules remain the rules committed when they were created.

## Hosting requirements

- A public HTTPS origin such as `https://my-ckautomata-operator.onrender.com`
- Node.js `24.11.1` and pnpm `12.5.1`, or Docker
- A dedicated CKB testnet private key
- Public CKB testnet RPC and indexer access
- Enough testnet CKB for network fees
- A process that can remain available for health checks

Never use a mainnet key or a wallet holding valuable funds. Store `OPERATOR_PRIVATE_KEY` as a hosting-platform secret, never in Git or a Docker image.

## Required environment variables

Start from [the environment example](../../deploy/operator/operator.env.example). A hosted payment operator needs these values:

```env
CKB_RPC_URL=https://testnet.ckbapp.dev/
CKB_INDEXER_URL=https://testnet.ckbapp.dev/
CKB_GENESIS_HASH=0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606
OPERATOR_MANIFEST_PATH=deploy/manifests/dao-harvest-v2-testnet.json
OPERATOR_AUTOMATION_MANIFEST_PATH=deploy/manifests/operator-automation-testnet.json
OPERATOR_TRANSACTION_FEE=50000
OPERATOR_FEE_RATE_PER_KILOBYTE=1000
OPERATOR_MINIMUM_PROFIT_MARGIN=0
OPERATOR_CONFIRMATION_DEPTH=5
OPERATOR_NAME=Community Operator
OPERATOR_PUBLIC_URL=https://your-public-operator.example
CKAUTOMATA_API_URL=https://ckb-automata-api.onrender.com
OPERATOR_SERVICES=deadline,recurring
OPERATOR_PRIVATE_KEY=0xYOUR_TESTNET_PRIVATE_KEY
```

`OPERATOR_HEALTH_PORT` is platform-specific:

- local or Docker Compose: `9464`
- Render web service: `10000`
- another platform: use the HTTP port assigned by that platform

Amounts are shannons. `1 CKB = 100,000,000 shannons`.

## Host on Render

Render is a straightforward way to publish the required HTTPS endpoint. Its web services must listen on `0.0.0.0` and the service port. CKAutomata already listens on `0.0.0.0`; set `OPERATOR_HEALTH_PORT=10000` for Render.

### 1. Fork and connect the repository

1. Fork `https://github.com/Hallab7/ckb-automata` into your GitHub account.
2. In Render, choose **New > Web Service**.
3. Connect the fork and choose the branch you want to operate.
4. Select the **Docker** runtime.
5. Set the Dockerfile path to `deploy/docker/operator.Dockerfile`.

### 2. Configure the service

Use these service settings:

| Setting                   | Value                                                                        |
| ------------------------- | ---------------------------------------------------------------------------- |
| Docker command            | `serve`                                                                      |
| Health check path         | `/health/live`                                                               |
| Port environment variable | `OPERATOR_HEALTH_PORT=10000`                                                 |
| Auto-deploy               | Enabled only if you want every selected-branch update deployed automatically |

Add every required environment variable from the previous section in Render's **Environment** page. Mark `OPERATOR_PRIVATE_KEY` as a secret value. Do not put it in `render.yaml`, the repository, or build arguments.

Set `OPERATOR_PUBLIC_URL` to the final Render origin, for example:

```env
OPERATOR_PUBLIC_URL=https://my-ckautomata-operator.onrender.com
```

Deploy the service and wait for its health check to pass.

### 3. Verify the public host

Open these URLs using your own service origin:

```text
https://my-ckautomata-operator.onrender.com/health/live
https://my-ckautomata-operator.onrender.com/health/ready
https://my-ckautomata-operator.onrender.com/operator-info
https://my-ckautomata-operator.onrender.com/metrics
```

Expected results:

- `/health/live` returns HTTP `200` with `status: ok`.
- `/health/ready` returns HTTP `200` with `status: ready` and the verified manifests.
- `/operator-info` returns HTTP `200` with the name, CKB address, services, network, and manifest hashes you intend to publish.
- `/metrics` returns Prometheus text.

Do not register the operator if readiness or identity verification fails.

### 4. Register the hosted operator

Registration is performed once from a trusted local checkout using the same private key as the hosted service. The hosted endpoint must already be live.

```powershell
git clone https://github.com/Hallab7/ckb-automata.git
Set-Location ckb-automata
corepack enable
corepack prepare pnpm@12.5.1 --activate
pnpm install --frozen-lockfile
pnpm --filter @ckb-automata/operator... build
```

Load the same environment variables into that PowerShell session, then run:

```powershell
pnpm operator verify-manifest
pnpm operator register
```

The command signs a single-use off-chain authentication message. CKAutomata verifies the hosted address, wallet ownership, CKB testnet genesis, manifests, endpoint, and declared services. The private key is never sent to CKAutomata.

After registration, the operator appears by name in the preferred-operator list for new automations matching its declared services.

### 5. Keep the host available

CKAutomata checks the public endpoint periodically. After repeated failed checks, the operator is hidden from new selections. A successful later check makes it visible again. Existing automations are unaffected.

Render free web services can spin down after 15 minutes without inbound traffic and can take time to wake. Use a non-sleeping service plan when operator availability matters. Do not rely on artificial high-frequency keepalive traffic as a substitute for suitable hosting.

Render documentation:

- [Web services and port binding](https://render.com/docs/web-services)
- [Environment variables and secrets](https://render.com/docs/configure-environment-variables)
- [Health checks](https://render.com/docs/health-checks)
- [Free service limitations](https://render.com/docs/free)

## Host with Docker on a VPS

A VPS or another always-on container host avoids free-service sleep. From the repository root:

```powershell
Copy-Item deploy/operator/operator.env.example deploy/operator/operator.env
docker build --file deploy/docker/operator.Dockerfile --tag ckautomata/operator:0.3.0 .
docker run --rm --env-file deploy/operator/operator.env ckautomata/operator:0.3.0 verify-manifest
docker compose --file deploy/operator/compose.yml up --detach --build
```

The Compose service binds only to `127.0.0.1:9464`. Put a TLS reverse proxy such as Caddy or Nginx in front of it and expose the HTTPS origin configured in `OPERATOR_PUBLIC_URL`. Do not expose the private key, env file, Docker socket, or host administration ports.

Check the container:

```powershell
docker compose --file deploy/operator/compose.yml ps
docker compose --file deploy/operator/compose.yml logs --follow operator
```

Then verify the four public endpoints and run `pnpm operator register` from a trusted machine.

## Process transactions

Hosting alone does not process a job. Use a fresh discovery result for each attempt:

```powershell
pnpm operator discover --kind all
pnpm operator build --kind scheduled --job-out-point 0xTRANSACTION_HASH:0x0 --output .\payment.json
pnpm operator dry-run --bundle .\payment.json
pnpm operator submit --bundle .\payment.json
pnpm operator confirm --tx-hash 0xSUBMITTED_TRANSACTION_HASH
```

Use `--kind recurring` for recurring payments and `--kind harvest` for an eligible DAO Harvest fallback claim. Harvest fallback claims also require the one-time accumulator setup:

```powershell
pnpm operator setup
```

If setup submits a transaction, confirm it and run `setup` again until it reports `ready`.

Never reuse an old bundle. Another operator or a changed chain state can consume one of its inputs first.

## Update a hosted operator

1. Pull or merge the reviewed CKAutomata release into the hosted branch.
2. Read the release changes and confirm the manifest paths still match the intended network.
3. Build locally and run `pnpm operator verify-manifest`.
4. Deploy the new commit through the hosting platform.
5. Wait for `/health/ready` and `/operator-info` to return HTTP `200`.
6. Re-run `pnpm operator register` if the name, URL, services, key, or published manifests changed.
7. Confirm the operator appears in CKAutomata before accepting new preferred work.

Do not rotate the key casually. A different key produces a different operator address and registration. Existing automations that committed the old address do not move to the new one.

## Remove a host

Stopping the service eventually hides it, but clean removal should use the authenticated registry delete endpoint or a future operator CLI removal command. Keep the old key available until every automation that selected it has completed or reached takeover eligibility.

## Security and operational checklist

- Use a dedicated CKB testnet key.
- Keep the private key only in runtime secrets and a trusted registration shell.
- Verify manifests before registration and before building transactions.
- Publish only services the running operator can actually perform.
- Use `/health/live` for platform health checks and `/health/ready` for operator readiness.
- Review and dry-run the exact bundle before every submission.
- Keep submitted transaction hashes until they are committed or rejected.
- Monitor CKB balance, failed submissions, stale bundles, and endpoint availability.
- Use a non-sleeping host when users depend on the preferred execution window.
