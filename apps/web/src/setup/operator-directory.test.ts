import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_OPERATOR_DRAFT,
  operatorDraftFields,
  PUBLIC_OPERATORS,
  selectedOperatorId,
} from "./operator-directory.ts";

test("the public operator directory exposes named active operators", () => {
  assert.deepEqual(
    PUBLIC_OPERATORS.map(({ id, name, status }) => ({ id, name, status })),
    [
      { id: "operator-a", name: "Operator A", status: "active" },
      { id: "operator-b", name: "Operator B", status: "active" },
    ],
  );
});

test("selecting one operator automatically assigns the other as backup", () => {
  const selected = operatorDraftFields("operator-b");
  assert.equal(selected["preferredOperatorId"], "operator-b");
  assert.equal(selected["preferredOperatorAddress"], PUBLIC_OPERATORS[1]?.address);
  assert.equal(selected["backupOperatorAddress"], PUBLIC_OPERATORS[0]?.address);
  assert.equal(selected["operatorMode"], "custom");
});

test("legacy automatic drafts fall back to Operator A", () => {
  assert.equal(selectedOperatorId({ operatorMode: "automatic" }), "operator-a");
  assert.equal(DEFAULT_OPERATOR_DRAFT["preferredOperatorId"], "operator-a");
});
