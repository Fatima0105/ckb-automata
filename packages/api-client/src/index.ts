import { CANONICAL_TRANSACTION_STATES } from "@ckb-automata/core";

export {
  ApiClientError,
  AutomataApiClient,
  createApiClient,
  type ApiActivity,
  type ApiAuthChallenge,
  type ApiAuthSession,
  type ApiDaoHarvest,
  type ApiDaoHarvestBuild,
  type ApiDaoHarvestList,
  type ApiDaoHarvestQuote,
  type ApiDaoHarvestV2,
  type ApiDaoHarvestV2Build,
  type ApiDaoHarvestV2List,
  type ApiDaoHarvestV2Quote,
  type ApiPendingDaoHarvest,
  type ApiClientOptions,
  type ApiJob,
  type ApiJobEvents,
  type ApiJobList,
  type ApiJobQuote,
  type ApiJobTerms,
  type ApiNotificationPreferences,
  type ApiQuery,
  type ApiRequestBody,
  type ApiSuccess,
  type ApiTemplates,
  type ApiTransactionBuild,
  type ApiTransactionProgress,
  type ApiTransactionValidation,
  type ApiWebhookDelivery,
  type ApiWebhookList,
  type ApiWebhookRegistration,
} from "./client.ts";
export type { components, operations, paths, webhooks } from "./generated/openapi.ts";

export const API_CLIENT_PACKAGE_READY = true;

export const API_TRANSACTION_STATE_VALUES = CANONICAL_TRANSACTION_STATES;

export type ApiTransactionState = (typeof API_TRANSACTION_STATE_VALUES)[number];
