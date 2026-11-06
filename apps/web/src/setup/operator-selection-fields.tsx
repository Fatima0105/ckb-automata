"use client";

import { TextField } from "@ckb-automata/ui";

import type { SetupStepRenderContext } from "./setup-stepper.tsx";

export function OperatorSelectionFields({
  context,
  includeBackup = false,
}: Readonly<{
  context: SetupStepRenderContext;
  includeBackup?: boolean;
}>) {
  const custom = context.draft["operatorMode"] === "custom";
  return (
    <div className="setup-step__group operator-selection">
      <div>
        <h3>Who should process it?</h3>
        <p>Use the CKAutomata operator or choose another compatible operator.</p>
      </div>
      <fieldset className="setup-outcome">
        <legend>Operator</legend>
        <div aria-label="Operator selection" role="radiogroup">
          <button
            aria-checked={!custom}
            onClick={() => context.setField("operatorMode", "automatic")}
            role="radio"
            type="button"
          >
            Automatic
          </button>
          <button
            aria-checked={custom}
            onClick={() => context.setField("operatorMode", "custom")}
            role="radio"
            type="button"
          >
            Choose operator
          </button>
        </div>
      </fieldset>
      {custom ? (
        <div className="setup-form-grid">
          <TextField
            {...(context.errors["preferredOperatorAddress"] === undefined
              ? {}
              : { error: context.errors["preferredOperatorAddress"] })}
            autoComplete="off"
            hint="This operator gets the first opportunity to process the automation."
            label="Preferred operator address"
            name="preferredOperatorAddress"
            onChange={(event) => context.setField("preferredOperatorAddress", event.target.value)}
            placeholder="ckt1..."
            required
            value={context.draft["preferredOperatorAddress"] ?? ""}
          />
          {includeBackup ? (
            <TextField
              {...(context.errors["backupOperatorAddress"] === undefined
                ? {}
                : { error: context.errors["backupOperatorAddress"] })}
              autoComplete="off"
              hint="This operator may take over later if the preferred operator does not act."
              label="Backup operator address"
              name="backupOperatorAddress"
              onChange={(event) => context.setField("backupOperatorAddress", event.target.value)}
              placeholder="ckt1..."
              required
              value={context.draft["backupOperatorAddress"] ?? ""}
            />
          ) : null}
        </div>
      ) : null}
      <p className="setup-step__hint">
        If the preferred operator does not act in time, another compatible operator or your wallet
        can take over.
      </p>
    </div>
  );
}
