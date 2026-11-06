import type { CellDepIdentity, ScriptIdentity } from "./job-inspection.ts";
import type { Hash32 } from "./chain-values.ts";

export interface OperatorContractDeployment {
  readonly script: Omit<ScriptIdentity, "args">;
  readonly cellDep: CellDepIdentity;
  readonly binarySha256: string;
  readonly sizeBytes: number;
}

export interface OperatorAutomationDeployment {
  readonly genesisHash: Hash32;
  readonly manifestSha256: string;
  readonly secp256k1Blake160: {
    readonly cellDep: CellDepIdentity;
  };
  readonly contracts: {
    readonly jobLock: OperatorContractDeployment;
    readonly deadlinePolicy: OperatorContractDeployment;
    readonly recurringPolicy: OperatorContractDeployment;
  };
  readonly defaultPreferredOperatorLockHash: Hash32;
}
