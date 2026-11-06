"use client";

import { SelectField } from "@ckb-automata/ui";

import type { SetupStepRenderContext } from "./setup-stepper.tsx";
import {
  operatorDraftFields,
  PUBLIC_OPERATORS,
  selectedOperatorId,
  type OperatorSelectionId,
} from "./operator-directory.ts";

export function OperatorSelectionFields({
  context,
}: Readonly<{ context: SetupStepRenderContext }>) {
  const selectedId = selectedOperatorId(context.draft);
  const selectOperator = (id: OperatorSelectionId) => {
    for (const [name, value] of Object.entries(operatorDraftFields(id))) {
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
        {PUBLIC_OPERATORS.map((operator) => (
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
