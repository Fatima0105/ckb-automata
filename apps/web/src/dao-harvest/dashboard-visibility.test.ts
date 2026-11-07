import assert from "node:assert/strict";
import test from "node:test";

import { publicOnlyDaoAutomations, visibleDaoAutomations } from "./dashboard-visibility.ts";

const automations = Object.freeze([
  Object.freeze({ jobId: "mine", ownerLockHash: "0xowner" }),
  Object.freeze({ jobId: "other", ownerLockHash: "0xother" }),
]);

test("public DAO view remains public when a wallet is connected", () => {
  assert.deepEqual(visibleDaoAutomations(automations, "public", "0xowner"), automations);
});

test("owner DAO view includes only the connected wallet", () => {
  assert.deepEqual(visibleDaoAutomations(automations, "owner", "0xowner"), [automations[0]]);
  assert.deepEqual(visibleDaoAutomations(automations, "owner", undefined), []);
});

test("DAO entries without owner metadata stay out of the owner view", () => {
  const pending = Object.freeze([{ transactionHash: "0xpending" }]);
  assert.deepEqual(publicOnlyDaoAutomations(pending, "public"), pending);
  assert.deepEqual(publicOnlyDaoAutomations(pending, "owner"), []);
});
