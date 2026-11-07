import type { operations } from "./generated/openapi.ts";
import type { UnsignedDeadlineTransaction } from "@ckb-automata/core";

type OperationName = keyof operations;

export type ApiRequestBody<Name extends OperationName> = operations[Name] extends {
  readonly requestBody: {
    readonly content: { readonly "application/json": infer Body };
  };
}
  ? Body
  : never;

export type ApiQuery<Name extends OperationName> = operations[Name] extends {
  readonly parameters: { readonly query?: infer Query };
}
  ? Query
  : never;

type ApiResponse<Name extends OperationName, Status extends number> = operations[Name] extends {
  readonly responses: infer Responses;
}
  ? Status extends keyof Responses
    ? Responses[Status] extends {
        readonly content: { readonly "application/json": infer Body };
      }
      ? Body
      : unknown
    : never
  : never;

export type ApiSuccess<Name extends OperationName> =
  ApiResponse<Name, 200> extends never ? ApiResponse<Name, 201> : ApiResponse<Name, 200>;

export type ApiJobList = ApiSuccess<"JobsController_list">;
export type ApiJob = ApiSuccess<"JobsController_detail">;
export type ApiJobEvents = ApiSuccess<"JobEventsController_list">;
export type ApiActivity = ApiSuccess<"ActivityController_list">;
export type ApiJobQuote = ApiSuccess<"JobQuoteController_get">;
export type ApiJobTerms = ApiSuccess<"JobQuoteController_terms">;
export type ApiTemplates = ApiSuccess<"TemplatesController_list">;
export type ApiTransactionBuild = ApiSuccess<"TransactionController_createDeadline">;
export type ApiTransactionValidation = ApiSuccess<"TransactionController_validateSigned">;
export type ApiTransactionProgress = ApiSuccess<"TransactionProgressController_get">;
export type ApiPendingCreation = ApiSuccess<"PendingCreationController_register">;
export type ApiDaoHarvestList = ApiSuccess<"DaoHarvestController_list">;
export type ApiDaoHarvest = ApiSuccess<"DaoHarvestController_detail">;
export type ApiDaoHarvestQuote = ApiSuccess<"DaoHarvestController_quote">;
export type ApiDaoHarvestV2List = ApiSuccess<"DaoHarvestV2Controller_list">;
export type ApiDaoHarvestV2 = ApiSuccess<"DaoHarvestV2Controller_detail">;
export type ApiDaoHarvestV2Quote = ApiSuccess<"DaoHarvestV2Controller_quote">;
export type ApiDaoHarvestV2Build = ApiSuccess<"DaoHarvestV2Controller_setup">;
export type ApiPendingDaoHarvest = ApiSuccess<"DaoHarvestController_registerSetup">;
export interface ApiDaoHarvestBuild {
  readonly intent: Readonly<Record<string, unknown>>;
  readonly jobId?: string;
  readonly operation: "exit" | "recover" | "setup" | "stop";
  readonly policyCriticalHash: string;
  readonly signingEntries: readonly unknown[];
  readonly transaction: UnsignedDeadlineTransaction;
}
export type ApiAuthChallenge = ApiSuccess<"AuthController_issue">;
export type ApiAuthSession = ApiSuccess<"AuthController_verify">;
export type ApiOperatorList = ApiSuccess<"OperatorRegistryController_list">;
export type ApiOperatorRegistration = ApiSuccess<"OperatorRegistryController_register">;
export type ApiNotificationPreferences = ApiSuccess<"NotificationPreferencesController_get">;
export type ApiWebhookList = ApiSuccess<"WebhookController_list">;
export type ApiWebhookRegistration = ApiSuccess<"WebhookController_register">;
export type ApiWebhookDelivery = ApiSuccess<"WebhookController_replay">;

export interface ApiClientOptions {
  readonly baseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
}

export class ApiClientError extends Error {
  readonly body: unknown;
  readonly status: number;

  constructor(status: number, body: unknown) {
    super(`CKB Automata API request failed with status ${status}`);
    this.name = "ApiClientError";
    this.status = status;
    this.body = body;
  }
}

function appendQuery(url: URL, query: unknown): void {
  if (typeof query !== "object" || query === null) return;
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) url.searchParams.set(name, String(value));
  }
}

export class AutomataApiClient {
  readonly #baseUrl: URL;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: ApiClientOptions) {
    this.#baseUrl = new URL(options.baseUrl);
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  live(): Promise<ApiSuccess<"HealthController_live">> {
    return this.#request("v1/health/live");
  }

  ready(): Promise<ApiSuccess<"HealthController_ready">> {
    return this.#request("v1/health/ready");
  }

  network(): Promise<ApiSuccess<"NetworkMetadataController_get">> {
    return this.#request("v1/network");
  }

  listOperators(query?: ApiQuery<"OperatorRegistryController_list">): Promise<ApiOperatorList> {
    return this.#request("v1/operators", { query });
  }

  registerOperator(
    sessionToken: string,
    body: ApiRequestBody<"OperatorRegistryController_register">,
  ): Promise<ApiOperatorRegistration> {
    return this.#request("v1/operators/registration", {
      body,
      headers: { authorization: `Bearer ${sessionToken}` },
      method: "PUT",
    });
  }

  removeOperator(sessionToken: string): Promise<ApiSuccess<"OperatorRegistryController_remove">> {
    return this.#request("v1/operators/registration", {
      headers: { authorization: `Bearer ${sessionToken}` },
      method: "DELETE",
    });
  }

  templates(): Promise<ApiTemplates> {
    return this.#request("v1/templates");
  }

  issueAuthChallenge(body: ApiRequestBody<"AuthController_issue">): Promise<ApiAuthChallenge> {
    return this.#post("v1/auth/challenge", body);
  }

  verifyAuthChallenge(body: ApiRequestBody<"AuthController_verify">): Promise<ApiAuthSession> {
    return this.#post("v1/auth/verify", body);
  }

  getAuthSession(sessionToken: string): Promise<ApiSuccess<"AuthController_current">> {
    return this.#request("v1/auth/session", {
      headers: { authorization: `Bearer ${sessionToken}` },
    });
  }

  revokeAuthSession(sessionToken: string): Promise<ApiSuccess<"AuthController_revoke">> {
    return this.#request("v1/auth/session", {
      headers: { authorization: `Bearer ${sessionToken}` },
      method: "DELETE",
    });
  }

  getNotificationPreferences(sessionToken: string): Promise<ApiNotificationPreferences> {
    return this.#request("v1/preferences", {
      headers: { authorization: `Bearer ${sessionToken}` },
    });
  }

  updateNotificationPreferences(
    sessionToken: string,
    body: ApiRequestBody<"NotificationPreferencesController_update">,
  ): Promise<ApiSuccess<"NotificationPreferencesController_update">> {
    return this.#request("v1/preferences", {
      body,
      headers: { authorization: `Bearer ${sessionToken}` },
      method: "PUT",
    });
  }

  resetNotificationPreferences(
    sessionToken: string,
  ): Promise<ApiSuccess<"NotificationPreferencesController_reset">> {
    return this.#request("v1/preferences", {
      headers: { authorization: `Bearer ${sessionToken}` },
      method: "DELETE",
    });
  }

  listWebhooks(sessionToken: string): Promise<ApiWebhookList> {
    return this.#request("v1/webhooks", {
      headers: { authorization: `Bearer ${sessionToken}` },
    });
  }

  registerWebhook(
    sessionToken: string,
    body: ApiRequestBody<"WebhookController_register">,
  ): Promise<ApiWebhookRegistration> {
    return this.#request("v1/webhooks", {
      body,
      headers: { authorization: `Bearer ${sessionToken}` },
      method: "POST",
    });
  }

  updateWebhook(
    sessionToken: string,
    subscriptionId: string,
    body: ApiRequestBody<"WebhookController_update">,
  ): Promise<ApiSuccess<"WebhookController_update">> {
    return this.#request(`v1/webhooks/${encodeURIComponent(subscriptionId)}`, {
      body,
      headers: { authorization: `Bearer ${sessionToken}` },
      method: "PATCH",
    });
  }

  rotateWebhookSecret(
    sessionToken: string,
    subscriptionId: string,
  ): Promise<ApiSuccess<"WebhookController_rotate">> {
    return this.#request(`v1/webhooks/${encodeURIComponent(subscriptionId)}/rotate-secret`, {
      headers: { authorization: `Bearer ${sessionToken}` },
      method: "POST",
    });
  }

  webhookDeliveries(
    sessionToken: string,
    subscriptionId: string,
    query?: ApiQuery<"WebhookController_history">,
  ): Promise<ApiSuccess<"WebhookController_history">> {
    return this.#request(`v1/webhooks/${encodeURIComponent(subscriptionId)}/deliveries`, {
      headers: { authorization: `Bearer ${sessionToken}` },
      query,
    });
  }

  replayWebhookDelivery(
    sessionToken: string,
    subscriptionId: string,
    deliveryId: string,
  ): Promise<ApiWebhookDelivery> {
    return this.#request(
      `v1/webhooks/${encodeURIComponent(subscriptionId)}/deliveries/${encodeURIComponent(deliveryId)}/replay`,
      {
        headers: { authorization: `Bearer ${sessionToken}` },
        method: "POST",
      },
    );
  }

  listJobs(query?: ApiQuery<"JobsController_list">): Promise<ApiJobList> {
    return this.#request("v1/jobs", { query });
  }

  getJob(jobId: string): Promise<ApiJob> {
    return this.#request(`v1/jobs/${encodeURIComponent(jobId)}`);
  }

  listAccountJobs(
    lockHash: string,
    query?: ApiQuery<"AccountJobsController_list">,
  ): Promise<ApiSuccess<"AccountJobsController_list">> {
    return this.#request(`v1/accounts/${encodeURIComponent(lockHash)}/jobs`, { query });
  }

  listJobEvents(
    jobId: string,
    query?: ApiQuery<"JobEventsController_list">,
  ): Promise<ApiJobEvents> {
    return this.#request(`v1/jobs/${encodeURIComponent(jobId)}/events`, { query });
  }

  listActivity(query?: ApiQuery<"ActivityController_list">): Promise<ApiActivity> {
    return this.#request("v1/activity", { query });
  }

  listDaoHarvest(query?: ApiQuery<"DaoHarvestController_list">): Promise<ApiDaoHarvestList> {
    return this.#request("v1/dao-harvest", { query });
  }

  getDaoHarvest(jobId: string): Promise<ApiDaoHarvest> {
    return this.#request(`v1/dao-harvest/${encodeURIComponent(jobId)}`);
  }

  listDaoHarvestV2(query?: ApiQuery<"DaoHarvestV2Controller_list">): Promise<ApiDaoHarvestV2List> {
    return this.#request("v1/dao-harvest-v2", { query });
  }

  getDaoHarvestV2(jobId: string): Promise<ApiDaoHarvestV2> {
    return this.#request(`v1/dao-harvest-v2/${encodeURIComponent(jobId)}`);
  }

  getDaoHarvestV2Quote(jobId: string): Promise<ApiDaoHarvestV2Quote> {
    return this.#request(`v1/dao-harvest-v2/${encodeURIComponent(jobId)}/quote`);
  }

  buildDaoHarvestV2(
    operation: "setup" | "sweep" | "close" | "rotate" | "recover",
    body: Record<string, unknown>,
  ): Promise<ApiDaoHarvestV2Build> {
    return this.#post(`v1/dao-harvest-v2/${operation}`, body);
  }

  registerDaoHarvestV2Setup(
    body: ApiRequestBody<"DaoHarvestV2Controller_registerSetup">,
  ): Promise<ApiSuccess<"DaoHarvestV2Controller_registerSetup">> {
    return this.#post("v1/dao-harvest-v2/register-setup", body);
  }

  getDaoHarvestQuote(jobId: string): Promise<ApiDaoHarvestQuote> {
    return this.#request(`v1/dao-harvest/${encodeURIComponent(jobId)}/quote`);
  }

  createDaoHarvest(
    body: ApiRequestBody<"DaoHarvestController_setup">,
  ): Promise<ApiDaoHarvestBuild> {
    return this.#post("v1/dao-harvest/setup", body);
  }

  registerDaoHarvestSetup(
    body: ApiRequestBody<"DaoHarvestController_registerSetup">,
  ): Promise<ApiPendingDaoHarvest> {
    return this.#post("v1/dao-harvest/register-setup", body);
  }

  stopDaoHarvest(body: ApiRequestBody<"DaoHarvestController_stop">): Promise<ApiDaoHarvestBuild> {
    return this.#post("v1/dao-harvest/stop", body);
  }

  exitDaoHarvest(body: ApiRequestBody<"DaoHarvestController_exit">): Promise<ApiDaoHarvestBuild> {
    return this.#post("v1/dao-harvest/exit", body);
  }

  recoverDaoHarvest(
    body: ApiRequestBody<"DaoHarvestController_recover">,
  ): Promise<ApiDaoHarvestBuild> {
    return this.#post("v1/dao-harvest/recover", body);
  }

  getJobQuote(jobId: string): Promise<ApiJobQuote> {
    return this.#request(`v1/jobs/${encodeURIComponent(jobId)}/quote`);
  }

  getJobTerms(jobId: string): Promise<ApiJobTerms> {
    return this.#request(`v1/jobs/${encodeURIComponent(jobId)}/terms`);
  }

  createDeadlineJob(
    body: ApiRequestBody<"TransactionController_createDeadline">,
  ): Promise<ApiTransactionBuild> {
    return this.#post("v1/transactions/create-deadline-job", body);
  }

  createRecurringJob(
    body: ApiRequestBody<"TransactionController_createRecurring">,
  ): Promise<ApiSuccess<"TransactionController_createRecurring">> {
    return this.#post("v1/transactions/create-recurring-job", body);
  }

  cancelJob(
    body: ApiRequestBody<"TransactionController_cancel">,
  ): Promise<ApiSuccess<"TransactionController_cancel">> {
    return this.#post("v1/transactions/cancel-job", body);
  }

  recoverJob(
    body: ApiRequestBody<"TransactionController_recover">,
  ): Promise<ApiSuccess<"TransactionController_recover">> {
    return this.#post("v1/transactions/recover-job", body);
  }

  topUpJob(
    body: ApiRequestBody<"TransactionController_topUp">,
  ): Promise<ApiSuccess<"TransactionController_topUp">> {
    return this.#post("v1/transactions/top-up-job", body);
  }

  validateSigned(
    body: ApiRequestBody<"TransactionController_validateSigned">,
  ): Promise<ApiTransactionValidation> {
    return this.#post("v1/transactions/validate-signed", body);
  }

  registerCreation(
    body: ApiRequestBody<"PendingCreationController_register">,
  ): Promise<ApiPendingCreation> {
    return this.#post("v1/transactions/register-creation", body);
  }

  getTransactionProgress(
    transactionHash: string,
    query: ApiQuery<"TransactionProgressController_get">,
  ): Promise<ApiTransactionProgress> {
    return this.#request(`v1/transactions/${encodeURIComponent(transactionHash)}/progress`, {
      query,
    });
  }

  #post<Result>(path: string, body: unknown): Promise<Result> {
    return this.#request(path, { body, method: "POST" });
  }

  async #request<Result>(
    path: string,
    options: {
      readonly body?: unknown;
      readonly headers?: Readonly<Record<string, string>>;
      readonly method?: "DELETE" | "PATCH" | "POST" | "PUT";
      readonly query?: unknown;
    } = {},
  ): Promise<Result> {
    const url = new URL(path, this.#baseUrl);
    appendQuery(url, options.query);
    const response = await this.#fetch.call(globalThis, url, {
      headers: {
        accept: "application/json",
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        ...options.headers,
      },
      method: options.method ?? "GET",
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const contentType = response.headers.get("content-type") ?? "";
    const body: unknown = contentType.includes("application/json")
      ? await response.json()
      : await response.text();
    if (!response.ok) throw new ApiClientError(response.status, body);
    return body as Result;
  }
}

export function createApiClient(options: ApiClientOptions): AutomataApiClient {
  return new AutomataApiClient(options);
}
