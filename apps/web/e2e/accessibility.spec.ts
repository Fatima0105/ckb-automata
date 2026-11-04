import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

function violationSummary(
  violations: Awaited<ReturnType<InstanceType<typeof AxeBuilder>["analyze"]>>["violations"],
) {
  return violations
    .map(
      (violation) =>
        `${violation.id} (${violation.impact ?? "unknown"}): ${violation.nodes
          .map((node) => node.target.join(" "))
          .join(", ")}`,
    )
    .join("\n");
}

async function expectNoSeriousAccessibilityViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  const violations = results.violations.filter(
    ({ impact }) => impact === "critical" || impact === "serious",
  );
  expect(violations, violationSummary(violations)).toEqual([]);
}

async function expectNoHorizontalOverflow(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    )
    .toBe(true);
}

test("primary flows and representative states have no serious automated violations", async ({
  page,
}) => {
  test.setTimeout(90_000);
  for (const route of [
    "/automations/new/deadline",
    "/automations/new/recurring",
    "/fixtures/setup-harvest",
    "/fixtures/setup-harvest-v2",
    "/fixtures/transaction-submission",
    "/fixtures/automation-detail",
    "/fixtures/settings",
    "/demo",
  ]) {
    await page.goto(route);
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    await expectNoSeriousAccessibilityViolations(page);
  }
});

test("keyboard validation announces and focuses the first setup error", async ({ page }) => {
  await page.goto("/fixtures/setup-deadline");
  const field = page.getByLabel("Deadline automation name");
  await field.focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Back" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Continue" })).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(field).toBeFocused();
  await expect(field).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("alert").getByText("Enter a fixture name.")).toBeVisible();

  await field.fill("Keyboard deadline");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-setup-step]")).toHaveAttribute("data-setup-step", "timing");
});

test("dialog focus is trapped and returns to the owner action trigger", async ({ page }) => {
  await page.goto("/fixtures/automation-detail");
  const trigger = page.getByRole("button", { name: "Cancel", exact: true });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Cancel automation", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("accessible tree exposes setup landmarks and labeled controls", async ({ page }) => {
  await page.goto("/fixtures/setup-recurring");
  const snapshot = await page.locator("body").ariaSnapshot();
  expect(snapshot).toContain('- heading "Recurring payments" [level=1]');
  expect(snapshot).toContain('- navigation "Automation setup progress"');
  expect(snapshot).toContain('- textbox "Recurring automation name"');
  expect(snapshot).toContain('- button "Continue"');
});

test("reduced motion removes loading and overlay animation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/fixtures/automation-dashboard");
  await page.getByRole("button", { name: "loading", exact: true }).click();
  await expect(page.locator(".automation-loading__row").first()).toHaveCSS(
    "animation-name",
    "none",
  );

  await page.goto("/fixtures/automation-detail");
  await page.getByRole("button", { name: "Recover", exact: true }).click();
  const overlayDuration = await page
    .locator(".ui-overlay")
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).animationDuration) * 1_000);
  expect(overlayDuration).toBeLessThanOrEqual(0.01);
});

test("mobile setup controls retain touch target sizing", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("mobile"));
  await page.goto("/fixtures/setup-recurring");
  const undersized = await page
    .locator(".setup-flow button:visible, .setup-flow input:visible")
    .evaluateAll((elements) =>
      elements.flatMap((element) => {
        const bounds = element.getBoundingClientRect();
        return bounds.width < 44 || bounds.height < 44
          ? [
              `${element.tagName.toLowerCase()}[${element.getAttribute("aria-label") ?? element.textContent?.trim() ?? ""}] ${bounds.width}x${bounds.height}`,
            ]
          : [];
      }),
    );
  expect(undersized).toEqual([]);
});

test("harvest setup stays understandable and keyboard operable", async ({ page }) => {
  await page.goto("/fixtures/setup-harvest");
  await expect(page.getByRole("heading", { level: 1, name: "Harvest compensation" })).toBeVisible();
  await expect(page.getByLabel("Original amount (CKB)")).toBeVisible();
  await expect(page.getByLabel("Compensation address")).toBeVisible();
  await page.getByRole("radio", { name: "Several harvests" }).click();
  await expect(page.getByLabel("Number of harvests")).toBeVisible();
  await expect(page.getByText("original amount stays protected", { exact: false })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectNoSeriousAccessibilityViolations(page);
});

test("protected harvest setup is accessible on desktop and mobile", async ({ page }) => {
  await page.goto("/fixtures/setup-harvest-v2");
  await expect(page.getByLabel("Original amount (CKB)")).toBeVisible();
  await expect(page.getByLabel("Compensation address")).toBeVisible();
  await expect(page.getByText("Preferred operator", { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectNoSeriousAccessibilityViolations(page);
});
