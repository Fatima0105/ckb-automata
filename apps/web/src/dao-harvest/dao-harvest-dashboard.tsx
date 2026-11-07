"use client";

import { ArrowUpRight, Clock3, Landmark, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import {
  createApiClient,
  type ApiDaoHarvest,
  type ApiDaoHarvestV2,
  type ApiDaoHarvestV2List,
  type ApiPendingDaoHarvest,
} from "@ckb-automata/api-client";
import { Button, InlineNotice } from "@ckb-automata/ui";

import { useWalletSession } from "../ccc/session.tsx";
import type { DashboardMode } from "../dashboard/dashboard-view.tsx";
import { browserWebEnvironment } from "../environment.ts";
import { readAutomationTitles } from "../setup/automation-title.ts";
import { publicOnlyDaoAutomations, visibleDaoAutomations } from "./dashboard-visibility.ts";
import { daoHarvestPresentation, formatHarvestPrincipal } from "./presentation.ts";
import { daoHarvestV2Presentation, harvestV2Amount } from "./v2-presentation.ts";

export function DaoHarvestDashboard({ mode }: Readonly<{ mode: DashboardMode }>) {
  const session = useWalletSession();
  const client = useMemo(() => {
    try {
      return createApiClient({ baseUrl: browserWebEnvironment().apiUrl });
    } catch {
      return undefined;
    }
  }, []);
  const [items, setItems] = useState<readonly ApiDaoHarvest[]>([]);
  const [pendingItems, setPendingItems] = useState<readonly ApiPendingDaoHarvest[]>([]);
  const [v2Items, setV2Items] = useState<readonly ApiDaoHarvestV2[]>([]);
  const [v2PendingItems, setV2PendingItems] = useState<ApiDaoHarvestV2List["pendingItems"]>([]);
  const [state, setState] = useState<"error" | "loading" | "ready">("loading");
  const [retry, setRetry] = useState(0);
  const [titles, setTitles] = useState<Readonly<Record<string, string>>>({});

  useEffect(() => setTitles(readAutomationTitles(window.localStorage)), [items]);
  useEffect(() => {
    if (client === undefined) {
      setState("error");
      return;
    }
    let active = true;
    setState("loading");
    void Promise.all([client.listDaoHarvest({ limit: 20 }), client.listDaoHarvestV2({ limit: 20 })])
      .then(([response, v2Response]) => {
        if (!active) return;
        setItems(response.items ?? []);
        setPendingItems(response.pendingItems ?? []);
        setV2Items(v2Response.items);
        setV2PendingItems(v2Response.pendingItems);
        setState("ready");
      })
      .catch(() => {
        if (active) setState("error");
      });
    return () => {
      active = false;
    };
  }, [client, retry]);

  const ownerLockHash = session.status === "ready" ? session.ownerLockHash : undefined;
  const visibleItems = visibleDaoAutomations(items, mode, ownerLockHash);
  const visiblePending = visibleDaoAutomations(pendingItems, mode, ownerLockHash);
  const visibleV2Items = visibleDaoAutomations(v2Items, mode, ownerLockHash);
  const visibleV2PendingItems = publicOnlyDaoAutomations(v2PendingItems, mode);

  return (
    <section className="harvest-dashboard" aria-labelledby="harvest-dashboard-title">
      <header className="harvest-dashboard__header">
        <div>
          <span className="harvest-dashboard__icon">
            <Landmark size={18} />
          </span>
          <div>
            <h2 id="harvest-dashboard-title">DAO harvest</h2>
            <p>Original amounts stay protected while earned compensation is collected.</p>
          </div>
        </div>
        <Link className="ui-button ui-button--secondary" href="/automations/new/dao-harvest-v2">
          New harvest
        </Link>
      </header>
      {state === "loading" ? (
        <div
          className="harvest-dashboard__skeleton"
          aria-label="Loading DAO compensation automations"
        >
          <span />
          <span />
        </div>
      ) : null}
      {state === "error" ? (
        <InlineNotice title="Something went wrong" tone="danger">
          <p>Please try again.</p>
          <Button
            icon={<RefreshCw size={16} />}
            onClick={() => setRetry((value) => value + 1)}
            tone="secondary"
          >
            Try again
          </Button>
        </InlineNotice>
      ) : null}
      {state === "ready" &&
      visibleItems.length === 0 &&
      visiblePending.length === 0 &&
      visibleV2Items.length === 0 &&
      visibleV2PendingItems.length === 0 ? (
        <div className="harvest-dashboard__empty">
          <p>No DAO compensation automations yet.</p>
        </div>
      ) : null}
      {state === "ready" &&
      (visibleItems.length > 0 ||
        visiblePending.length > 0 ||
        visibleV2Items.length > 0 ||
        visibleV2PendingItems.length > 0) ? (
        <div className="harvest-dashboard__rows">
          {visibleV2PendingItems.map((item) => (
            <div className="harvest-row harvest-row--pending" key={item.transactionHash}>
              <div>
                <strong>Harvest compensation</strong>
                <span>
                  {item.status === "submitting"
                    ? "Submitting to CKB testnet"
                    : "Waiting for testnet confirmation"}
                </span>
              </div>
              <div>
                <span className="ui-status ui-status--info">
                  {item.status === "submitting" ? "Submitting" : "Confirming"}
                </span>
                <small>Original amount stays protected</small>
              </div>
              <Clock3 aria-hidden="true" size={17} />
            </div>
          ))}
          {visibleV2Items.map((item) => {
            const presentation = daoHarvestV2Presentation(item);
            return (
              <Link
                className="harvest-row"
                href={`/automations/dao-harvest-v2/${encodeURIComponent(item.jobId)}`}
                key={item.jobId}
              >
                <div>
                  <strong>{titles[item.jobId] ?? "Harvest compensation"}</strong>
                  <span>{presentation.action}</span>
                </div>
                <div>
                  <span
                    className={`ui-status ui-status--${presentation.status === "recovery" ? "danger" : presentation.status === "completed" ? "neutral" : "info"}`}
                  >
                    {presentation.statusLabel}
                  </span>
                  <strong>{harvestV2Amount(item.protectedAmount)}</strong>
                  <small>
                    {presentation.completedCycles} of {presentation.totalCycles} harvests
                  </small>
                </div>
                <ArrowUpRight aria-hidden="true" size={17} />
              </Link>
            );
          })}
          {visiblePending.map((item) => {
            const confirmations = Math.min(Number(item.confirmations), item.requiredConfirmations);
            const statusLabel =
              item.status === "submitting"
                ? "Submitting"
                : item.status === "confirming"
                  ? "Confirming"
                  : "Waiting";
            const action =
              item.status === "submitting"
                ? "Submitting to CKB testnet"
                : item.status === "confirming"
                  ? `${confirmations}/${item.requiredConfirmations} confirmations`
                  : "Preparing automation details";
            return (
              <div className="harvest-row harvest-row--pending" key={item.jobId}>
                <div>
                  <strong>{titles[item.jobId] ?? "Harvest compensation"}</strong>
                  <span>{action}</span>
                </div>
                <div>
                  <span className="ui-status ui-status--info">{statusLabel}</span>
                  <strong>{formatHarvestPrincipal(item.principal)}</strong>
                  <small>0 of {item.progress.totalCycles} harvests</small>
                </div>
                <Clock3 aria-hidden="true" size={17} />
              </div>
            );
          })}
          {visibleItems.map((item) => {
            const presentation = daoHarvestPresentation(item);
            return (
              <Link
                className="harvest-row"
                href={`/automations/dao-harvest/${encodeURIComponent(item.jobId)}`}
                key={item.jobId}
              >
                <div>
                  <strong>{titles[item.jobId] ?? "Harvest compensation"}</strong>
                  <span>{presentation.action}</span>
                </div>
                <div>
                  <span
                    className={`ui-status ui-status--${presentation.status === "recovery" ? "danger" : presentation.status === "completed" ? "neutral" : "info"}`}
                  >
                    {presentation.statusLabel}
                  </span>
                  <strong>{formatHarvestPrincipal(item.principal)}</strong>
                  <small>
                    {presentation.completedCycles} of {presentation.totalCycles} harvests
                  </small>
                </div>
                <ArrowUpRight aria-hidden="true" size={17} />
              </Link>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
