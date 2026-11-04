export type TemplateCapability = "demo" | "executable" | "research";

export interface TemplateCatalogItem {
  readonly action: { readonly href: string; readonly label: string };
  readonly approval: string;
  readonly capability: TemplateCapability;
  readonly description: string;
  readonly id: "dao-harvest" | "deadline" | "demo" | "recurring";
  readonly name: string;
  readonly recoverability: string;
  readonly risk: string;
}

export const TEMPLATE_CATALOG: readonly TemplateCatalogItem[] = Object.freeze([
  Object.freeze({
    action: Object.freeze({ href: "/automations/new/deadline", label: "Set up payment" }),
    approval:
      "The owner wallet signs creation. The automation can process only after the scheduled time.",
    capability: "executable",
    description: "Send payment at a date and time you choose.",
    id: "deadline",
    name: "Scheduled payment",
    recoverability: "Owner-authorized cancel or recovery returns the complete Job Cell value.",
    risk: "Funds remain locked until finalization or an owner exit is confirmed on testnet.",
  }),
  Object.freeze({
    action: Object.freeze({ href: "/automations/new/recurring", label: "Set up payments" }),
    approval:
      "The owner wallet signs once. Each run pays only the committed recipient and executor.",
    capability: "executable",
    description: "Send the same amount to one recipient on a repeating schedule.",
    id: "recurring",
    name: "Recurring payments",
    recoverability: "The owner may cancel a live job or recover a stalled or unsupported job.",
    risk: "Capacity stays locked across runs and must cover payouts, rewards, and occupied capacity.",
  }),
  Object.freeze({
    action: Object.freeze({ href: "/demo", label: "Open guided demo" }),
    approval: "No wallet approval is requested by the fixture-backed walkthrough.",
    capability: "demo",
    description: "Inspect guided fixture scenarios without presenting them as live chain evidence.",
    id: "demo",
    name: "Guided scenarios",
    recoverability: "No funds are locked, so there is no cancellation or recovery transaction.",
    risk: "Demo records are illustrative and do not prove public testnet execution.",
  }),
  Object.freeze({
    action: Object.freeze({ href: "/automations/new/dao-harvest-v2", label: "Set up harvest" }),
    approval:
      "Your wallet approves a limited testnet policy that preserves the original DAO amount.",
    capability: "executable",
    description: "Keep your original amount in the DAO and send earned compensation to you.",
    id: "dao-harvest",
    name: "Harvest compensation",
    recoverability: "The owner wallet can update operators, close, or recover without CKAutomata.",
    risk: "Testnet pilot only. Timing and compensation estimates can change with the CKB chain.",
  }),
]);
