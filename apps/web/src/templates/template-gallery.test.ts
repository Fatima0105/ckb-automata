import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { TEMPLATE_CATALOG } from "./template-catalog.ts";

test("template availability matches implemented product boundaries", () => {
  assert.deepEqual(
    TEMPLATE_CATALOG.map(({ capability, id }) => [id, capability]),
    [
      ["deadline", "executable"],
      ["recurring", "executable"],
      ["demo", "demo"],
      ["dao-harvest", "executable"],
    ],
  );
  const executable = TEMPLATE_CATALOG.filter((template) => template.capability === "executable");
  assert.deepEqual(
    executable.map((template) => template.action.href),
    ["/automations/new/deadline", "/automations/new/recurring", "/automations/new/dao-harvest-v2"],
  );
  assert.ok(
    TEMPLATE_CATALOG.filter((template) => template.capability !== "executable").every(
      (template) => !template.action.label.toLowerCase().includes("create"),
    ),
  );
});

test("creation gallery stays focused on executable automation choices", async () => {
  for (const template of TEMPLATE_CATALOG) {
    assert.ok(template.risk.length > 20, `${template.id} risk is too vague`);
    assert.ok(template.approval.length > 20, `${template.id} approval is too vague`);
    assert.ok(template.recoverability.length > 20, `${template.id} recovery is too vague`);
  }
  const source = await readFile(new URL("./template-gallery.tsx", import.meta.url), "utf8");
  assert.match(source, /template\.capability === "executable"/);
  assert.match(source, /data-create-action="true"/);
  assert.doesNotMatch(source, /Guided scenarios|Demo only|NervDAO Cycle Guard|Research only/);
  assert.doesNotMatch(source, /template-card__facts/);
});
