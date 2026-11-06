"use client";

import { SelectField } from "@ckb-automata/ui";

import type { SetupStepRenderContext } from "./setup-stepper.tsx";
import {
  operatorDraftFields,
  PUBLIC_OPERATORS,
  selectedOperatorId,
  type PublicOperatorId,
} from "./operator-directory.ts";

export function OperatorSelectionFields({
  context,
}: Readonly<{ context: SetupStepRenderContext }>) {
  const selectedId = selectedOperatorId(context.draft);
  const selectOperator = (id: PublicOperatorId) => {
    for (const [name, value] of Object.entries(operatorDraftFields(id))) {
      context.setField(name, value);
    }
  };
  return (
    <div className="setup-step__group operator-selection">
      <div>
        <h3>Who should process it?</h3>
        <p>Choose the operator that gets the first opportunity to process this automation.</p>
      </div>
      <SelectField
        hint="All other active operators can take over later if the selected operator does not act."
        label="Preferred operator"
        name="preferredOperatorId"
        onChange={(event) => selectOperator(event.target.value as PublicOperatorId)}
        required
        value={selectedId}
      >
        {PUBLIC_OPERATORS.map((operator) => (
          <option key={operator.id} value={operator.id}>
            {operator.name} - Active
          </option>
        ))}
      </SelectField>
      <p className="setup-step__hint">
        The selected operator acts first. The other active operator becomes the backup
        automatically.
      </p>
    </div>
  );
}
