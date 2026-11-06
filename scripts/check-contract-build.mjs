import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const target = "riscv64imac-unknown-none-elf";
const binaries = [
  "job-lock",
  "deadline-policy",
  "recurring-policy",
  "demo-campaign-type",
  "campaign-lock",
  "harvest-vault-lock",
  "dao-harvest-policy",
  "job-lock-v2",
  "job-lock-v3",
  "deadline-policy-v2",
  "recurring-policy-v2",
  "dao-harvest-policy-v2",
  "harvest-vault-lock-v2",
  "compensation-lock-v2",
];
const comparisonRoot = new URL("target/reproducibility/", root);
const artifactRoot = new URL("target/contract-artifacts/", root);
const artifactBinRoot = new URL("bin/", artifactRoot);
const versions = JSON.parse(await readFile(new URL("config/versions.json", root), "utf8"));
const schemaFiles = [
  "campaign_v1.mol",
  "job_v1.mol",
  "recurring_v1.mol",
  "dao_harvest_v1.mol",
  "dao_harvest_v2.mol",
  "operator_v1.mol",
];
const builderFile = new URL("deploy/docker/contracts-builder.Dockerfile", root);
const builderTag = `ckb-automata-contracts:${versions.toolchain.rust}`;
const rootPath = fileURLToPath(root);
const sourceRevision = git("rev-parse", "HEAD");
const sourceDirty = git("status", "--porcelain", "--untracked-files=normal").length > 0;
if (process.env.CI === "true" && sourceDirty) {
  throw new Error("CI contract artifacts must be built from a clean source tree");
}

await rm(comparisonRoot, { force: true, recursive: true });
await rm(artifactRoot, { force: true, recursive: true });
await mkdir(artifactBinRoot, { recursive: true });

execFileSync("docker", ["build", "--file", fileURLToPath(builderFile), "--tag", builderTag, "."], {
  cwd: rootPath,
  stdio: "inherit",
});

function build(outputDirectory) {
  execFileSync(
    "docker",
    [
      "run",
      "--rm",
      "--volume",
      `${rootPath}:/work`,
      "--workdir",
      "/work",
      "--env",
      `CARGO_TARGET_DIR=/work/target/reproducibility/${outputDirectory}`,
      builderTag,
    ],
    { cwd: rootPath, stdio: "inherit" },
  );
}

async function digest(outputDirectory, binary) {
  const path = new URL(`${outputDirectory}/${target}/release/${binary}`, comparisonRoot);
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function fileDigest(url) {
  return createHash("sha256")
    .update(await readFile(url))
    .digest("hex");
}

function git(...args) {
  return execFileSync("git", args, {
    cwd: fileURLToPath(root),
    encoding: "utf8",
  }).trim();
}

build("first/");
build("second/");

const mismatches = [];
const binaryManifest = [];
for (const binary of binaries) {
  const first = await digest("first", binary);
  const second = await digest("second", binary);
  if (first !== second) {
    mismatches.push(`${binary}: ${first} != ${second}`);
  } else {
    console.log(`${binary} ${first}`);
    const source = new URL(`first/${target}/release/${binary}`, comparisonRoot);
    const destination = new URL(binary, artifactBinRoot);
    await copyFile(source, destination);
    binaryManifest.push({
      name: binary,
      file: `bin/${binary}`,
      sha256: first,
      sizeBytes: (await stat(destination)).size,
    });
  }
}

if (mismatches.length > 0) {
  console.error(mismatches.join("\n"));
  process.exitCode = 1;
} else {
  const schemas = {};
  const aggregateSchemaHash = createHash("sha256");
  for (const schemaFile of schemaFiles) {
    const schemaUrl = new URL(`contracts/schemas/${schemaFile}`, root);
    const contents = await readFile(schemaUrl);
    schemas[schemaFile] = await fileDigest(schemaUrl);
    aggregateSchemaHash.update(schemaFile);
    aggregateSchemaHash.update(Uint8Array.of(0));
    aggregateSchemaHash.update(contents);
    aggregateSchemaHash.update(Uint8Array.of(0));
  }

  const manifest = {
    schemaVersion: 1,
    sourceRevision,
    sourceDirty,
    builder: {
      baseImage: versions.dockerImages.rust,
      dockerfileSha256: await fileDigest(builderFile),
      rust: versions.toolchain.rust,
      target,
      profile: "release",
      sourceDateEpoch: 0,
    },
    schema: {
      aggregateSha256: aggregateSchemaHash.digest("hex"),
      files: schemas,
    },
    binaries: binaryManifest,
  };
  await writeFile(new URL("manifest.json", artifactRoot), `${JSON.stringify(manifest, null, 2)}\n`);
  await rm(comparisonRoot, { force: true, recursive: true });
  console.log(`Reproducible contract build verified for ${binaries.length} binaries`);
  console.log("Artifact manifest written to target/contract-artifacts/manifest.json");
}
