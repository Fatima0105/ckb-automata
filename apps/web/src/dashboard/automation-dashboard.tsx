"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  createApiClient,
  type ApiJobList,
  type ApiQuery,
  type AutomataApiClient,
} from "@ckb-automata/api-client";

import { useWalletSession } from "../ccc/session.tsx";
import { createLiveDataProvider, LIVE_DATA_LABEL } from "../data-provider.ts";
import { browserWebEnvironment } from "../environment.ts";
import { usePublicDeploymentMetadata } from "../public-deployment-gate.tsx";
import { requestErrorMessage } from "../request-errors.ts";
import { readAutomationTitles } from "../setup/automation-title.ts";
import { latestObservedBlock, readNetworkTipBlock } from "../time/chain-time.ts";
import {
  AutomationDashboardView,
  type DashboardLoadState,
  type DashboardMode,
} from "./dashboard-view.tsx";
import type { DashboardJob, RecipientAmountsByJob } from "./dashboard-model.ts";
import { DaoHarvestDashboard } from "../dao-harvest/dao-harvest-dashboard.tsx";

const PAGE_SIZE = 12;
const FIRST_PAGE_REFRESH_MS = 15_000;
const EMPTY_ITEMS: ApiJobList["items"] = Object.freeze([]);

interface LoadedDashboardPage {
  readonly loadedAt: string;
  readonly referenceBlock?: string;
  readonly response: ApiJobList;
}

type SummaryLoadState = "error" | "loading" | "ready";

function browserApiClient(): AutomataApiClient {
  const environment = browserWebEnvironment();
  return createApiClient({ baseUrl: environment.apiUrl });
}

async function loadRecipientAmounts(
  api: AutomataApiClient,
  jobs: readonly DashboardJob[],
): Promise<RecipientAmountsByJob> {
  const entries = await Promise.all(
    jobs.map(async (job) => {
      try {
        const terms = await api.getJobTerms(job.jobId);
        return [job.jobId, terms.payout] as const;
      } catch {
        return [job.jobId, null] as const;
      }
    }),
  );
  return Object.fromEntries(entries);
}

async function loadDashboardPage(
  api: AutomataApiClient,
  responsePromise: Promise<ApiJobList>,
  verifiedNetwork?: Awaited<ReturnType<AutomataApiClient["network"]>>,
): Promise<LoadedDashboardPage> {
  const [response, network] = await Promise.all([
    responsePromise,
    verifiedNetwork === undefined
      ? api.network().catch(() => undefined)
      : Promise.resolve(verifiedNetwork),
  ]);
  const referenceBlock = latestObservedBlock(
    readNetworkTipBlock(network),
    response.indexCheckpoint?.blockNumber,
    ...response.items.map((job) => job.source.block.number),
  );
  return {
    loadedAt: new Date().toISOString(),
    ...(referenceBlock === undefined ? {} : { referenceBlock }),
    response,
  };
}

function fullSummaryQuery(query: ApiQuery<"JobsController_list">): ApiQuery<"JobsController_list"> {
  return { ...query, limit: 1, summary: "full" };
}

export function AutomationDashboard() {
  const session = useWalletSession();
  const verifiedNetwork = usePublicDeploymentMetadata();
  const apiResult = useMemo(() => {
    try {
      const provider = createLiveDataProvider(browserApiClient);
      return { api: provider.load() } as const;
    } catch {
      return { api: undefined } as const;
    }
  }, []);
  const [mode, setMode] = useState<DashboardMode>("public");
  const [stateFilter, setStateFilter] = useState("");
  const [templateFilter, setTemplateFilter] = useState("");
  const [pages, setPages] = useState<readonly LoadedDashboardPage[]>([]);
  const [pageIndex, setPageIndex] = useState(0);
  const [recipientAmounts, setRecipientAmounts] = useState<RecipientAmountsByJob>({});
  const [exactSummary, setExactSummary] = useState<ApiJobList["summary"]>();
  const [summaryLoadState, setSummaryLoadState] = useState<SummaryLoadState>("loading");
  const [loadState, setLoadState] = useState<DashboardLoadState>("loading");
  const [paginationError, setPaginationError] = useState<string>();
  const [loadingPage, setLoadingPage] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [titles, setTitles] = useState<Readonly<Record<string, string>>>({});

  const currentPage = pages[pageIndex];
  const items = currentPage?.response.items ?? EMPTY_ITEMS;
  const pendingItems = currentPage?.response.pendingItems ?? [];
  const summary = exactSummary ?? currentPage?.response.summary;
  const checkpointAt = currentPage?.loadedAt;
  const checkpointBlock = currentPage?.referenceBlock;
  const totalItems = currentPage?.response.page.totalItems ?? 0;

  useEffect(() => setTitles(readAutomationTitles(window.localStorage)), [items]);

  const query = useMemo<ApiQuery<"JobsController_list">>(
    () => ({
      limit: PAGE_SIZE,
      ...(stateFilter
        ? { state: stateFilter as NonNullable<ApiQuery<"JobsController_list">["state"]> }
        : {}),
      ...(templateFilter
        ? { template: templateFilter as NonNullable<ApiQuery<"JobsController_list">["template"]> }
        : {}),
      summary: "compact",
    }),
    [stateFilter, templateFilter],
  );

  useEffect(() => {
    if (apiResult.api === undefined) {
      setPages([]);
      setRecipientAmounts({});
      setLoadState("error");
      return;
    }
    if (mode === "owner") {
      if (session.status !== "ready") {
        setPages([]);
        setRecipientAmounts({});
        setLoadState("owner_required");
        return;
      }
      if (session.detailsStatus === "loading") {
        setPages([]);
        setRecipientAmounts({});
        setLoadState("loading");
        return;
      }
      if (session.ownerLockHash === undefined) {
        setPages([]);
        setRecipientAmounts({});
        setLoadState("error");
        return;
      }
    }

    let active = true;
    setPages([]);
    setPageIndex(0);
    setRecipientAmounts({});
    setExactSummary(undefined);
    setSummaryLoadState("loading");
    setPaginationError(undefined);
    setLoadState("loading");
    const request =
      mode === "owner"
        ? apiResult.api.listAccountJobs(session.ownerLockHash!, query)
        : apiResult.api.listJobs(query);
    void loadDashboardPage(apiResult.api, request, verifiedNetwork)
      .then((page) => {
        if (!active) return;
        setPages([page]);
        setLoadState("ready");
        void loadRecipientAmounts(apiResult.api!, page.response.items)
          .then((amounts) => {
            if (active) setRecipientAmounts(amounts);
          })
          .then(() => {
            if (!active) return undefined;
            const summaryRequest =
              mode === "owner"
                ? apiResult.api!.listAccountJobs(session.ownerLockHash!, fullSummaryQuery(query))
                : apiResult.api!.listJobs(fullSummaryQuery(query));
            return summaryRequest.then((response) => {
              if (!active) return;
              setExactSummary(response.summary);
              setSummaryLoadState("ready");
            });
          })
          .catch(() => {
            if (active) setSummaryLoadState("error");
          });
      })
      .catch(() => {
        if (!active) return;
        setLoadState("error");
      });
    return () => {
      active = false;
    };
  }, [
    apiResult,
    mode,
    query,
    refreshKey,
    session.detailsStatus,
    session.ownerLockHash,
    session.status,
    verifiedNetwork,
  ]);

  useEffect(() => {
    if (apiResult.api === undefined || loadState !== "ready" || pageIndex !== 0) return;
    if (mode === "owner" && session.ownerLockHash === undefined) return;
    let active = true;
    const refresh = () => {
      const request =
        mode === "owner"
          ? apiResult.api!.listAccountJobs(session.ownerLockHash!, query)
          : apiResult.api!.listJobs(query);
      void loadDashboardPage(apiResult.api!, request)
        .then((page) => {
          if (!active) return;
          setPages([page]);
          void loadRecipientAmounts(apiResult.api!, page.response.items).then((amounts) => {
            if (active) setRecipientAmounts((current) => ({ ...current, ...amounts }));
          });
          const summaryRequest =
            mode === "owner"
              ? apiResult.api!.listAccountJobs(session.ownerLockHash!, fullSummaryQuery(query))
              : apiResult.api!.listJobs(fullSummaryQuery(query));
          void summaryRequest
            .then((response) => {
              if (active) {
                setExactSummary(response.summary);
                setSummaryLoadState("ready");
              }
            })
            .catch(() => {
              // Keep the previous exact summary during a temporary refresh failure.
            });
        })
        .catch(() => {
          // Keep the last complete page when a background refresh is temporarily unavailable.
        });
    };
    const timer = setInterval(refresh, FIRST_PAGE_REFRESH_MS);
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [apiResult.api, loadState, mode, pageIndex, query, session.ownerLockHash]);

  const loadNextPage = useCallback(() => {
    if (apiResult.api === undefined || loadingPage) return;
    if (mode === "owner" && session.ownerLockHash === undefined) return;
    const cached = pages[pageIndex + 1];
    if (cached !== undefined) {
      setPageIndex(pageIndex + 1);
      setPaginationError(undefined);
      return;
    }
    const nextCursor = currentPage?.response.page.nextCursor;
    if (nextCursor === undefined || nextCursor === null) return;
    setLoadingPage(true);
    setPaginationError(undefined);
    const cursorQuery = { ...query, cursor: nextCursor };
    const request =
      mode === "owner"
        ? apiResult.api.listAccountJobs(session.ownerLockHash!, cursorQuery)
        : apiResult.api.listJobs(cursorQuery);
    void loadDashboardPage(apiResult.api, request)
      .then((page) => {
        setPages((current) => [...current.slice(0, pageIndex + 1), page]);
        setPageIndex(pageIndex + 1);
        void loadRecipientAmounts(apiResult.api!, page.response.items).then((amounts) => {
          setRecipientAmounts((current) => ({ ...current, ...amounts }));
        });
      })
      .catch((reason: unknown) => {
        setPaginationError(requestErrorMessage("dashboard", reason));
      })
      .finally(() => setLoadingPage(false));
  }, [apiResult, currentPage, loadingPage, mode, pageIndex, pages, query, session.ownerLockHash]);

  const loadPreviousPage = useCallback(() => {
    if (loadingPage || pageIndex === 0) return;
    setPageIndex((current) => current - 1);
    setPaginationError(undefined);
  }, [loadingPage, pageIndex]);

  return (
    <>
      <AutomationDashboardView
        checkpointAt={checkpointAt}
        checkpointBlock={checkpointBlock}
        dataSourceLabel={LIVE_DATA_LABEL}
        hasNextPage={currentPage?.response.page.nextCursor != null}
        hasPreviousPage={pageIndex > 0}
        items={items}
        pendingItems={pendingItems}
        loadState={loadState}
        loadingPage={loadingPage}
        mode={mode}
        pageIndex={pageIndex}
        pageSize={PAGE_SIZE}
        paginationError={paginationError}
        recipientAmounts={recipientAmounts}
        summary={summary}
        summaryAmountsLoading={summaryLoadState === "loading"}
        totalItems={totalItems}
        onConnect={session.open}
        onNextPage={loadNextPage}
        onPreviousPage={loadPreviousPage}
        onModeChange={setMode}
        onRetry={() => {
          session.refreshDetails();
          setPaginationError(undefined);
          setRefreshKey((current) => current + 1);
        }}
        onStateChange={setStateFilter}
        onTemplateChange={setTemplateFilter}
        stateFilter={stateFilter}
        templateFilter={templateFilter}
        titles={titles}
      />
      <DaoHarvestDashboard mode={mode} />
    </>
  );
}
