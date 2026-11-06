import type { SetupDraft } from "./setup-flow.ts";

export type PublicOperatorId = "operator-a" | "operator-b";
export type OperatorSelectionId = "none" | PublicOperatorId;

export interface PublicOperator {
  readonly address: string;
  readonly id: PublicOperatorId;
  readonly name: string;
  readonly status: "active";
}

export const PUBLIC_OPERATORS = Object.freeze([
  Object.freeze({
    id: "operator-a" as const,
    name: "Operator A",
    address: "ckt1qyqvaw3x5ps8lvdteh0p5txgxr3aurxds0tqvc9pr4",
    status: "active" as const,
  }),
  Object.freeze({
    id: "operator-b" as const,
    name: "Operator B",
    address: "ckt1qyqpthft24t5t4yq46p0k5mwag82fuew8d9stkugjc",
    status: "active" as const,
  }),
] satisfies readonly PublicOperator[]);

export const DEFAULT_OPERATOR_ID: OperatorSelectionId = "none";

export function selectedOperatorId(draft: SetupDraft): OperatorSelectionId {
  const selected = draft["preferredOperatorId"];
  if (selected === "none" || draft["operatorMode"] === "automatic") return "none";
  if (PUBLIC_OPERATORS.some(({ id }) => id === selected)) return selected as PublicOperatorId;
  const matchingAddress = PUBLIC_OPERATORS.find(
    ({ address }) => address === draft["preferredOperatorAddress"],
  );
  return matchingAddress?.id ?? DEFAULT_OPERATOR_ID;
}

export function operatorDraftFields(id: OperatorSelectionId): Readonly<Record<string, string>> {
  if (id === "none") {
    return Object.freeze({
      operatorMode: "automatic",
      preferredOperatorId: "none",
      preferredOperatorAddress: "",
      backupOperatorAddress: "",
    });
  }
  const preferred = PUBLIC_OPERATORS.find((operator) => operator.id === id);
  if (preferred === undefined) throw new TypeError("Choose an available operator.");
  const backup = PUBLIC_OPERATORS.find(
    (operator) => operator.id !== preferred.id && operator.status === "active",
  );
  if (backup === undefined) throw new Error("A backup operator is unavailable.");
  return Object.freeze({
    operatorMode: "custom",
    preferredOperatorId: preferred.id,
    preferredOperatorAddress: preferred.address,
    backupOperatorAddress: backup.address,
  });
}

export const DEFAULT_OPERATOR_DRAFT = operatorDraftFields(DEFAULT_OPERATOR_ID);
