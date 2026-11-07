"use client";

import { useEffect, useMemo, useState } from "react";

import { createApiClient } from "@ckb-automata/api-client";
import { SelectField } from "@ckb-automata/ui";

import { browserWebEnvironment } from "../environment.ts";
import type { SetupStepRenderContext } from "./setup-stepper.tsx";
import {
  operatorDraftFields,
  mergePublicOperators,
  registeredPublicOperators,
  selectedOperatorId,
  type PublicOperator,
  type OperatorSelectionId,
} from "./operator-directory.ts";

export function OperatorSelectionFields({
  context,
}: Readonly<{ context: SetupStepRenderContext }>) {
  const [registered, setRegistered] = useState<readonly PublicOperator[]>([]);
  useEffect(() => {
    let current = true;
    let api;
    try {
      api = createApiClient({ baseUrl: browserWebEnvironment().apiUrl });
    } catch {
      setRegistered([]);
      return () => {
        current = false;
      };
    }
    void api
      .listOperators({ service: context.template })
      .then((response) => {
        if (current) setRegistered(registeredPublicOperators(response));
      })
      .catch(() => {
        if (current) setRegistered([]);
      });
    return () => {
      current = false;
    };
  }, [context.template]);
  const operators = useMemo(() => mergePublicOperators(registered), [registered]);
  const selectedId = selectedOperatorId(context.draft, operators);
  const selectOperator = (id: OperatorSelectionId) => {
    for (const [name, value] of Object.entries(operatorDraftFields(id, operators))) {
      context.setField(name, value);
    }
  };
  return (
    <div className="setup-step__group operator-selection">
      <div>
        <h3>Who should process it?</h3>
        <p>You can give one operator the first opportunity, or leave this as None.</p>
      </div>
      <SelectField
        hint={
          selectedId === "none"
            ? "CKAutomata will assign available operators automatically."
            : "All other active operators can take over later if the selected operator does not act."
        }
        label="Preferred operator"
        name="preferredOperatorId"
        onChange={(event) => selectOperator(event.target.value as OperatorSelectionId)}
        value={selectedId}
      >
        <option value="none">None</option>
        {operators.map((operator) => (
          <option key={operator.id} value={operator.id}>
            {operator.name} - Active
          </option>
        ))}
      </SelectField>
      <p className="setup-step__hint">
        {selectedId === "none"
          ? "No operator is preferred by you. The automation still remains available to active operators."
          : "The selected operator acts first. The other active operator becomes the backup automatically."}
      </p>
    </div>
  );
}
