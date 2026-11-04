import { expect, test, type Page } from "@playwright/test";

async function expectNoHorizontalOverflow(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    )
    .toBe(true);
}

test("completes both deterministic setup journeys", async ({ page }) => {
  for (const setup of [
    {
      field: "Deadline automation name",
      name: "Milestone release",
      path: "/fixtures/setup-deadline",
      title: "Scheduled payment",
    },
    {
      field: "Recurring automation name",
      name: "Monthly contributor payout",
      path: "/fixtures/setup-recurring",
      title: "Recurring payments",
    },
  ]) {
    await page.goto(setup.path);
    await expect(page.getByRole("heading", { level: 1, name: setup.title })).toBeVisible();
    await page.getByLabel(setup.field).fill(setup.name);

    for (const step of ["timing", "funding", "review", "approval"]) {
      await page.getByRole("button", { name: "Continue" }).click();
      await expect(page.locator("[data-setup-step]")).toHaveAttribute("data-setup-step", step);
      await expect(page.locator("[data-preserved-value]")).toHaveText(setup.name);
    }

    await expect(page.getByRole("button", { name: "Continue" })).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
  }
});

test("keeps DAO harvest setup simple and blocks incomplete wallet approval", async ({ page }) => {
  await page.goto("/fixtures/setup-harvest");
  await page.getByLabel("Automation title").fill("Quarterly compensation");
  await page.getByLabel("Original amount (CKB)").fill("1000");
  await page.getByRole("radio", { name: "Several harvests" }).click();
  await page.getByLabel("Number of harvests").fill("2");

  await expect(page.getByText(/original amount stays protected/i)).toBeVisible();
  await expect(page.getByText("Estimated charges").locator("..")).toContainText("626 CKB");
  await expect(page.getByText("Total to deposit").locator("..")).toContainText("1626 CKB");
  await expect(page.getByRole("button", { name: "Connect wallet" })).toBeVisible();
  await expect(page.getByText(/block number|epoch/i)).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
});

test("explains protected harvest charges and operator takeover in plain language", async ({
  page,
}) => {
  await page.goto("/fixtures/setup-harvest-v2");
  await expect(page.getByRole("heading", { level: 1, name: "Harvest compensation" })).toBeVisible();
  await page.getByLabel("Automation title").fill("Protected DAO harvest");
  await page.getByLabel("Original amount (CKB)").fill("1000");
  await page.getByRole("radio", { name: "Several harvests" }).click();
  await page.getByLabel("Number of harvests").fill("3");
  await expect(page.getByText("Preferred operator", { exact: true })).toBeVisible();
  await expect(page.getByText("Backup operator", { exact: true })).toBeVisible();
  await expect(page.getByText("Recoverable reserve", { exact: true })).toBeVisible();
  await expect(page.getByText(/service charges come only from earned compensation/i)).toBeVisible();
  await expect(page.getByText(/block number|epoch/i)).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
});

test("reproduces wallet outcomes and transaction progress", async ({ page }) => {
  await page.goto("/fixtures/transaction-submission");
  await page.getByRole("button", { name: "Reject", exact: true }).click();
  await page.getByRole("button", { name: "Approve and submit" }).click();
  await expect(page.getByText("The wallet request was rejected.", { exact: false })).toBeVisible();

  await page.getByRole("button", { name: "Close request" }).click();
  await page.getByRole("button", { name: "Approve and submit" }).click();
  await expect(page.getByText("The wallet request was closed.", { exact: false })).toBeVisible();

  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await page.getByRole("button", { name: "Approve and submit" }).click();
  await expect(
    page.getByRole("heading", { name: "Your Automation Is Being Confirmed" }),
  ).toBeVisible();

  await page.goto("/fixtures/transaction-progress");
  await page.getByRole("button", { name: "submitted", exact: true }).click();
  await expect(page.locator("[data-progress-state]")).toHaveAttribute(
    "data-progress-state",
    "submitted",
  );
  await page.getByRole("button", { name: "confirmed", exact: true }).click();
  await expect(page.locator("[data-progress-state]")).toHaveAttribute(
    "data-progress-state",
    "confirmed",
  );
  await expect(page.getByText("3 / 3", { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test("keeps loading and request failure states calm and stable", async ({ page }) => {
  await page.goto("/fixtures/automation-dashboard");
  await page.getByRole("button", { name: "loading", exact: true }).click();
  await expect(page.locator(".automation-dashboard--loading")).toHaveAttribute("aria-busy", "true");
  await expect(page.locator(".automation-loading__row")).toHaveCount(3);
  await expect(page.getByText("Verifying public deployment")).toHaveCount(0);
  await expectNoHorizontalOverflow(page);

  await page.getByRole("button", { name: "error", exact: true }).click();
  await expect(page.getByText("Something went wrong. Please try again.")).toBeVisible();

  await page.goto("/fixtures/automation-detail");
  await page.getByRole("button", { name: "loading", exact: true }).click();
  await expect(page.locator(".job-detail-loading")).toHaveAttribute("aria-busy", "true");
  await expectNoHorizontalOverflow(page);
});

test("shows recurring successors and separate owner escape reviews", async ({ page }) => {
  await page.goto("/fixtures/automation-detail");
  await page.getByRole("button", { name: "recurring", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Recurring payments" })).toBeVisible();
  await expect(page.locator(".job-detail__summary").getByText("2", { exact: true })).toBeVisible();
  await expect(page.locator(".job-detail__summary").getByText("4", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    page.getByRole("dialog").getByText("Cancel automation", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("dialog").getByText("action stops safely", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();

  await page.getByRole("button", { name: "Recover", exact: true }).click();
  await expect(page.getByRole("dialog").getByText("Recover funds", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Why are you recovering the funds?")).toHaveValue(
    "terminal_operational_failure",
  );
  await expectNoHorizontalOverflow(page);
});

test("filters activity and exercises private settings controls", async ({ page }) => {
  await page.goto("/fixtures/activity");
  await page.getByLabel("Evidence source").selectOption("operational");
  await page.getByLabel("Outcome").selectOption("dropped");
  await expect(page.getByText("dropped", { exact: true })).toBeVisible();
  await page.getByLabel("Outcome").selectOption("confirmed");
  await expect(page.getByRole("heading", { name: "No matching activity" })).toBeVisible();

  await page.goto("/fixtures/settings");
  await expect(page.getByRole("heading", { name: "Notifications" })).toBeVisible();
  await page.getByLabel("Browser notifications").uncheck();
  await expect(page.getByLabel("Browser notifications")).not.toBeChecked();
  await expect(page.getByText("hooks.example.com/automata", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Reset settings" }).click();
  const dialog = page.getByRole("dialog");
  const deleteButton = dialog.getByRole("button", { name: "Delete private settings" });
  await expect(deleteButton).toBeDisabled();
  await dialog.getByLabel("Type RESET to confirm").fill("RESET");
  await expect(deleteButton).toBeEnabled();
  await expectNoHorizontalOverflow(page);
});

test("keeps demo evidence labeled while scenarios change and reset", async ({ page }) => {
  await page.goto("/demo");
  const boundary = page.locator(".demo-boundary");
  await expect(boundary.getByText("Demo data", { exact: true })).toBeVisible();
  await expect(page.locator(".app-network-badge:visible")).toContainText("Demo data");
  await expect(page.getByText("Connect wallet", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Simulated records.", { exact: false })).toBeVisible();

  await page.getByRole("button", { name: "Owner recovery", exact: false }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Owner recovery" })).toBeVisible();
  await page.getByRole("button", { name: "Next review" }).click();
  await expect(
    page.getByRole("heading", { level: 3, name: "Review owner authentication" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Reset demo" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Scheduled payout" })).toBeVisible();
  await expect(
    page.getByRole("heading", { level: 3, name: "Review immutable intent" }),
  ).toBeVisible();
  await expect(boundary.getByText("Demo data", { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});
