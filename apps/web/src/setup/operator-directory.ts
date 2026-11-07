import type { SetupDraft } from "./setup-flow.ts";

export type PublicOperatorId = string;
export type OperatorSelectionId = "none" | PublicOperatorId;

export interface PublicOperator {
  readonly address: string;
  readonly id: PublicOperatorId;
  readonly name: string;
  readonly status: "active";
  readonly services?: readonly ("dao-harvest" | "deadline" | "recurring")[];
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

export function registeredPublicOperators(value: unknown): readonly PublicOperator[] {
  if (typeof value !== "object" || value === null || !("operators" in value)) return [];
  const operators = (value as { operators?: unknown }).operators;
  if (!Array.isArray(operators)) return [];
  return Object.freeze(
    operators.flatMap((item): PublicOperator[] => {
      if (typeof item !== "object" || item === null) return [];
      const operator = item as Readonly<Record<string, unknown>>;
      const services = operator["services"];
      if (
        typeof operator["id"] !== "string" ||
        !/^registry:0x[0-9a-f]{64}$/.test(operator["id"]) ||
        typeof operator["name"] !== "string" ||
        operator["name"].length < 2 ||
        typeof operator["address"] !== "string" ||
        !/^ckt1[0-9a-z]{20,124}$/.test(operator["address"]) ||
        operator["status"] !== "active" ||
        !Array.isArray(services) ||
        services.length < 1 ||
        services.some(
          (service) =>
            service !== "dao-harvest" && service !== "deadline" && service !== "recurring",
        )
      ) {
        return [];
      }
      return [
        Object.freeze({
          id: operator["id"],
          name: operator["name"],
          address: operator["address"],
          status: "active" as const,
          services: Object.freeze(services as ("dao-harvest" | "deadline" | "recurring")[]),
        }),
      ];
    }),
  );
}

export function mergePublicOperators(
  registered: readonly PublicOperator[],
): readonly PublicOperator[] {
  const seenAddresses = new Set<string>(PUBLIC_OPERATORS.map(({ address }) => address));
  return Object.freeze([
    ...PUBLIC_OPERATORS,
    ...registered.filter(({ address }) => {
      if (seenAddresses.has(address)) return false;
      seenAddresses.add(address);
      return true;
    }),
  ]);
}

export function selectedOperatorId(
  draft: SetupDraft,
  operators: readonly PublicOperator[] = PUBLIC_OPERATORS,
): OperatorSelectionId {
  const selected = draft["preferredOperatorId"];
  if (selected === "none" || draft["operatorMode"] === "automatic") return "none";
  if (operators.some(({ id }) => id === selected)) return selected ?? DEFAULT_OPERATOR_ID;
  const matchingAddress = operators.find(
    ({ address }) => address === draft["preferredOperatorAddress"],
  );
  return matchingAddress?.id ?? DEFAULT_OPERATOR_ID;
}

export function operatorDraftFields(
  id: OperatorSelectionId,
  operators: readonly PublicOperator[] = PUBLIC_OPERATORS,
): Readonly<Record<string, string>> {
  if (id === "none") {
    return Object.freeze({
      operatorMode: "automatic",
      preferredOperatorId: "none",
      preferredOperatorAddress: "",
      backupOperatorAddress: "",
    });
  }
  const preferred = operators.find((operator) => operator.id === id);
  if (preferred === undefined) throw new TypeError("Choose an available operator.");
  const backup = operators.find(
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
