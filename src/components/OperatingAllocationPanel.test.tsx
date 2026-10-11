import React, { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { OperatingAllocationResponse } from "@/lib/operatingAllocation.server";
import {
  prepareOperatingAllocation,
  type OperatingAllocationRequest,
} from "@/lib/operatingAllocation";

type Control = {
  children?: ReactNode;
  disabled?: boolean;
  checked?: boolean;
  onClick?: () => void;
  onChange?: (event: { target: { value: string; checked: boolean } }) => void;
  "aria-label"?: string;
};
const harness = vi.hoisted(() => ({
  states: [] as unknown[],
  refs: [] as { current: unknown }[],
  stateCursor: 0,
  refCursor: 0,
  buttons: [] as Control[],
  controls: {} as Record<string, Control>,
  effects: [] as (() => void | (() => void))[],
  client: null as unknown as QueryClient,
  refetch: vi.fn(),
  pending: false,
  fetching: false,
  error: null as unknown,
  owner: "owner-a",
  anonymous: false,
  authCallback: null as null | ((event: string, session: unknown) => void),
  options: null as unknown as { queryFn: () => Promise<unknown> },
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const i = harness.stateCursor++;
    if (!(i in harness.states))
      harness.states[i] = typeof initial === "function" ? initial() : initial;
    return [
      harness.states[i],
      (value: unknown) => {
        harness.states[i] = typeof value === "function" ? value(harness.states[i]) : value;
      },
    ];
  },
  useRef: (initial: unknown) => {
    const i = harness.refCursor++;
    return harness.refs[i] ?? (harness.refs[i] = { current: initial });
  },
  useEffect: (callback: () => void | (() => void)) => {
    harness.effects.push(callback);
  },
}));
vi.mock("react/jsx-runtime", async (original) => {
  const runtime = await original<typeof import("react/jsx-runtime")>();
  const capture = (type: unknown, props: Control | undefined) => {
    if ((type === "input" || type === "select") && props?.["aria-label"])
      harness.controls[props["aria-label"]] = props;
  };
  return {
    ...runtime,
    jsx: (
      type: Parameters<typeof runtime.jsx>[0],
      props: Parameters<typeof runtime.jsx>[1],
      key?: string,
    ) => {
      capture(type, props as Control);
      return runtime.jsx(type, props, key);
    },
    jsxs: (
      type: Parameters<typeof runtime.jsxs>[0],
      props: Parameters<typeof runtime.jsxs>[1],
      key?: string,
    ) => {
      capture(type, props as Control);
      return runtime.jsxs(type, props, key);
    },
  };
});
vi.mock("react/jsx-dev-runtime", async (original) => {
  const runtime = await original<typeof import("react/jsx-dev-runtime")>();
  return {
    ...runtime,
    jsxDEV: (...args: Parameters<typeof runtime.jsxDEV>) => {
      const [type, props] = args;
      const control = props as Control;
      if ((type === "input" || type === "select") && control?.["aria-label"])
        harness.controls[control["aria-label"]] = control;
      return runtime.jsxDEV(...args);
    },
  };
});
vi.mock("@tanstack/react-query", async (original) => ({
  ...(await original<typeof import("@tanstack/react-query")>()),
  useQueryClient: () => harness.client,
  useQuery: (options: { queryKey: string[]; queryFn: () => Promise<unknown> }) => {
    harness.options = options;
    return {
      data: harness.client.getQueryData(options.queryKey),
      isPending: harness.pending,
      isFetching: harness.fetching,
      error: harness.error,
      refetch: harness.refetch,
    };
  },
}));
vi.mock("@/lib/cloud", () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({
        data: {
          session: harness.owner
            ? {
                access_token: "synthetic-token",
                user: { id: harness.owner, is_anonymous: harness.anonymous },
              }
            : null,
        },
        error: null,
      })),
      onAuthStateChange: (callback: typeof harness.authCallback) => {
        harness.authCallback = callback;
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      },
    },
  },
}));
vi.mock("@/lib/operatingAllocation.functions", () => ({ operatingAllocationServer: vi.fn() }));
vi.mock("@/lib/dashboardActualRefresh", () => ({
  invalidateActualPositionViews: vi.fn(async () => undefined),
}));
vi.mock("./ui/button", () => ({
  Button: (props: Control) => {
    harness.buttons.push(props);
    return <button disabled={props.disabled}>{props.children}</button>;
  },
}));
import {
  OperatingAllocationPanel,
  OperatingAllocationContent,
  type OperatingAllocationCandidate,
} from "./OperatingAllocationPanel";
import { operatingAllocationServer } from "@/lib/operatingAllocation.functions";
const server = vi.mocked(operatingAllocationServer);
const callData = (index: number) =>
  server.mock.calls[index]![0]!.data as OperatingAllocationRequest;
const hash = `sha256:${"a".repeat(64)}`;
function response(currency: "KRW" | "USD" = "KRW"): OperatingAllocationResponse {
  return {
    revision: 4,
    plan: prepareOperatingAllocation("2026-10-11T12:00:00Z"),
    authority: null,
    cash: "1000",
    sourceFingerprint: hash,
    sizing: { version: 1, annualSnapshots: [], signalBudgets: [], etfSnapshots: [] },
    usdSizingEvidence: null,
    sizingIssues: [],
    fundingSources:
      currency === "USD"
        ? [{ id: "fund-1", date: "2026-10-12", amount: "1000", reference: "USD-deposit-evidence" }]
        : [],
    availability: {
      status: "CLAIMS_PENDING",
      available: { KR: null, ETF: null, US: null },
      spendableAvailable: null,
    },
  };
}
function render(element: ReactNode = <OperatingAllocationPanel editable />) {
  harness.stateCursor = 0;
  harness.refCursor = 0;
  harness.buttons = [];
  harness.controls = {};
  harness.effects = [];
  return renderToStaticMarkup(element);
}
function button(label: string) {
  const value = harness.buttons.find((button) => button.children === label);
  if (!value) throw new Error(`Missing ${label}`);
  return value;
}
function change(label: string, value: string, checked = false) {
  const control = harness.controls[label];
  if (!control?.onChange) throw new Error(`Missing ${label}`);
  control.onChange({ target: { value, checked } });
}
const tick = async () => {
  for (let i = 0; i < 25; i++) await Promise.resolve();
};
async function previewClaims() {
  render();
  change("한국 귀속액", "600");
  render();
  change("ETF 귀속액", "300");
  render();
  button("귀속액 검토").onClick!();
  await tick();
  render();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  harness.states = ["owner-a", "KRW"];
  harness.refs = [{ current: "owner-a" }, { current: "KRW" }];
  harness.client = new QueryClient();
  harness.client.setQueryData(["operating-allocation", "owner-a", "KRW"], response());
  harness.client.setQueryData(["operating-allocation", "owner-a", "USD"], response("USD"));
  harness.pending = false;
  harness.fetching = false;
  harness.error = null;
  harness.owner = "owner-a";
  harness.anonymous = false;
  harness.authCallback = null;
  harness.refetch = vi.fn(async () => ({ isError: false }));
  server.mockReset();
  server.mockResolvedValue(response());
});
afterEach(() => {
  harness.client.clear();
});
describe("allocation presentation", () => {
  it("labels native currencies and keeps decimal strings exact", () => {
    const data = response("USD");
    data.cash = "999999999999999999.12345678";
    const html = render(<OperatingAllocationContent data={data} currency="USD" />);
    expect(html).toContain("999,999,999,999,999,999.12345678");
    expect(html).toContain("USD");
    expect(html).toContain("미국 첫해 USD 예산 근거 확인 대기");
    expect(html).not.toContain("한국 가용 귀속액");
  });
  it.each(["pending", "error"] as const)("hides old private values and editing when %s", (mode) => {
    const data = response();
    data.cash = "432198765";
    harness.client.setQueryData(["operating-allocation", "owner-a", "KRW"], data);
    if (mode === "pending") harness.pending = true;
    else harness.error = new Error("failed");
    const html = render();
    expect(html).not.toContain("432,198,765");
    expect(html).not.toContain("실제 현금 귀속 대조");
  });
  it("keeps read-only views free of mutation controls", () => {
    render(<OperatingAllocationPanel />);
    expect(harness.buttons.some((b) => b.children === "귀속액 검토")).toBe(false);
  });
});
describe("review/save lifecycle", () => {
  it.each(["2000-01-01T00:00:00Z", "2099-01-01T00:00:00Z"])(
    "does not send the skewed browser clock %s as spendable-cash evidence",
    async (browserTime) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(browserTime));
      try {
        render();
        change("확인한 주문가능 현금", "1000");
        render();
        change("주문가능 현금 증빙 식별자", "broker-cash");
        await previewClaims();
        expect(callData(0)).toMatchObject({
          change: { spendableCash: { amount: "1000", reference: "broker-cash" } },
        });
        expect(callData(0)).not.toHaveProperty("change.spendableCash.availableAt");
        change("저장 내용 확인", "", true);
        render();
        button("검토한 내용 저장").onClick!();
        await tick();
        expect(callData(1)).toMatchObject({
          action: "save",
          reviewConfirmed: true,
          change: { spendableCash: { amount: "1000", reference: "broker-cash" } },
        });
        expect(callData(1)).not.toHaveProperty("change.spendableCash.availableAt");
      } finally {
        vi.useRealTimers();
      }
    },
  );
  it("preserves shared-currency unassigned cash and requires separate checked review", async () => {
    await previewClaims();
    expect(callData(0)).toMatchObject({
      action: "preview",
      currency: "KRW",
      change: {
        kind: "REVIEW_CLAIMS",
        claims: { KR: "600", ETF: "300", US: "0", UNASSIGNED: "100" },
        spendableCash: null,
      },
    });
    expect(button("검토한 내용 저장").disabled).toBe(true);
    change("저장 내용 확인", "", true);
    render();
    button("검토한 내용 저장").onClick!();
    await tick();
    expect(callData(1)).toMatchObject({
      action: "save",
      reviewConfirmed: true,
      currency: "KRW",
    });
    expect(callData(1)).toHaveProperty(
      "requestId",
      (callData(0) as Exclude<OperatingAllocationRequest, { action: "load" }>).requestId,
    );
  });
  it("clears prior approval when the form is edited", async () => {
    await previewClaims();
    change("저장 내용 확인", "", true);
    render();
    change("한국 귀속액", "500");
    expect(render()).not.toContain("저장 전 검토");
    expect(server).toHaveBeenCalledTimes(1);
  });
  it("cancel is read-only", async () => {
    await previewClaims();
    button("검토 취소").onClick!();
    expect(render()).not.toContain("저장 전 검토");
    expect(server).toHaveBeenCalledTimes(1);
  });
  it("locks duplicate clicks while a preview request is pending", async () => {
    const pending = deferred<OperatingAllocationResponse>();
    server.mockReturnValueOnce(pending.promise);
    render();
    const click = button("귀속액 검토").onClick!;
    click();
    click();
    await tick();
    expect(server).toHaveBeenCalledTimes(1);
    pending.resolve(response());
    await tick();
  });
  it("discards a late preview after currency changes", async () => {
    const pending = deferred<OperatingAllocationResponse>();
    server.mockReturnValueOnce(pending.promise);
    render();
    button("귀속액 검토").onClick!();
    await tick();
    // Programmatic invocation also exercises the stale-response guard beyond the disabled selector.
    change("현금 통화", "USD");
    pending.resolve(response());
    await tick();
    const html = render();
    expect(html).not.toContain("저장 전 검토");
    expect(html).toContain("미국 첫해 USD 예산 근거");
  });
  it("discards late owner-A responses after logout and owner-B login", async () => {
    render();
    harness.effects[0]!();
    await tick();
    const pending = deferred<OperatingAllocationResponse>();
    server.mockReturnValueOnce(pending.promise);
    render();
    button("귀속액 검토").onClick!();
    await tick();
    harness.owner = "owner-b";
    harness.authCallback!("SIGNED_IN", { user: { id: "owner-b" } });
    pending.resolve({ ...response(), cash: "987654321" });
    await tick();
    const html = render();
    expect(html).not.toContain("987,654,321");
    expect(html).not.toContain("저장 전 검토");
    expect(harness.client.getQueryData(["operating-allocation", "owner-a", "KRW"])).toBeUndefined();
  });
  it("does not send a save after anonymous/logout auth replacement", async () => {
    await previewClaims();
    change("저장 내용 확인", "", true);
    render();
    harness.anonymous = true;
    button("검토한 내용 저장").onClick!();
    await tick();
    expect(server).toHaveBeenCalledTimes(1);
    expect(render()).not.toContain("저장 전 검토");
  });
  it("requires fresh read after an uncertain save and never retries automatically", async () => {
    await previewClaims();
    change("저장 내용 확인", "", true);
    render();
    server.mockRejectedValueOnce(new Error("lost-response"));
    button("검토한 내용 저장").onClick!();
    await tick();
    let html = render();
    expect(html).toContain("자동 재시도하지 않습니다");
    expect(button("귀속액 검토").disabled).toBe(true);
    expect(server).toHaveBeenCalledTimes(2);
    button("배정 내역 새로고침").onClick!();
    await tick();
    html = render();
    expect(button("귀속액 검토").disabled).toBe(false);
    expect(server).toHaveBeenCalledTimes(2);
  });
  it("refuses a reviewed save if the query revision changed", async () => {
    await previewClaims();
    change("저장 내용 확인", "", true);
    harness.client.setQueryData(["operating-allocation", "owner-a", "KRW"], {
      ...response(),
      revision: 5,
    });
    render();
    button("검토한 내용 저장").onClick!();
    await tick();
    expect(server).toHaveBeenCalledTimes(1);
    expect(render()).toContain("원장이 변경되었습니다");
  });
  it("keeps failed refresh locked and hides cached edit controls", async () => {
    harness.error = new Error("read-failed");
    harness.refetch.mockResolvedValueOnce({ isError: true });
    render();
    button("배정 내역 새로고침").onClick!();
    await tick();
    expect(render()).toContain("다시 조회하세요");
    expect(harness.buttons.some((b) => b.children === "귀속액 검토")).toBe(false);
  });
  it("submits a sourced native USD review without fabricated FX", async () => {
    render();
    change("현금 통화", "USD");
    render();
    change("USD 입금 fund-1", "", true);
    render();
    change("미국 배정금액 USD", "900.00");
    render();
    change("배정 확정시각", "2026-10-12T12:00");
    render();
    change("USD 배정 증빙 식별자", "verified-native");
    render();
    button("USD 예산 근거 검토").onClick!();
    await tick();
    expect(callData(0)).toMatchObject({
      currency: "USD",
      change: {
        kind: "CONFIRM_USD_SIZING",
        amountUsd: "900",
        fundingEventIds: ["fund-1"],
        reference: "verified-native",
      },
    });
    expect(JSON.stringify(server.mock.calls)).not.toContain("1339.2");
  });
  it("reviews explicit reservation release even when cash requires reconciliation", async () => {
    const data = response();
    data.availability.status = "RECONCILIATION_REQUIRED";
    data.authority = {
      version: 1,
      currency: "KRW",
      sourceRevision: 3,
      sourceFingerprint: hash,
      cashAtReview: "1000",
      claims: { KR: "600", ETF: "300", US: "0", UNASSIGNED: "100" },
      spendableCash: null,
      reviewedAt: "2026-10-12T00:00:00Z",
      reservations: [
        {
          id: "reserved-1",
          signalId: "signal",
          signalBudgetId: "signal",
          market: "KR",
          currency: "KRW",
          amount: "500",
        },
      ],
    };
    harness.client.setQueryData(["operating-allocation", "owner-a", "KRW"], data);
    render();
    button("예약 해제 검토").onClick!();
    await tick();
    expect(callData(0)).toMatchObject({
      change: { kind: "RELEASE", reservationId: "reserved-1" },
    });
  });
});
describe("selected dashboard candidate", () => {
  const candidate: OperatingAllocationCandidate = {
    market: "KOSDAQ",
    symbol: "123456",
    name: "Test candidate",
    signalOriginDate: "2026-10-12",
    sourceDate: "2026-10-12",
    cashRequired: "500.75",
    quantity: "5",
    status: "ESTIMATED",
  };
  const panel = (value = candidate) => <OperatingAllocationPanel editable candidate={value} />;
  function pinnedResponse() {
    const data = response();
    data.sizing.signalBudgets = [
      {
        id: "opaque-server-budget",
        annualSnapshotId: "kr",
        market: "KR",
        currency: "KRW",
        signalDate: candidate.signalOriginDate,
        decisionDate: candidate.signalOriginDate,
        amount: "400000",
        feeTreatment: "INCLUSIVE",
        etfWeight: null,
        sourceFingerprint: hash,
        sizingBasis: "ANNUAL",
        security: {
          symbol: candidate.symbol,
          venue: candidate.market,
          sector: "Test",
          sectorCode: "G10",
          originDate: candidate.signalOriginDate,
          decisionDate: candidate.signalOriginDate,
          sourceDate: candidate.sourceDate,
          sourceFingerprint: hash,
        },
      },
    ];
    return data;
  }
  it("reviews the selected signal PIN without accepting a typed symbol or client budget", async () => {
    server.mockResolvedValue({ ...response(), reviewFingerprint: hash });
    render(panel());
    expect(harness.controls["현금 통화"]?.disabled).toBe(true);
    button("후보 예산 확정 검토").onClick!();
    await tick();
    render(panel());
    expect(callData(0)).toMatchObject({
      action: "preview",
      change: {
        kind: "PIN_SIGNAL_BUDGET",
        market: "KOSDAQ",
        symbol: "123456",
        signalOriginDate: "2026-10-12",
        sourceDate: "2026-10-12",
      },
    });
    expect(button("검토한 내용 저장").disabled).toBe(true);
    expect(JSON.stringify(callData(0))).not.toContain("500.75");
    change("저장 내용 확인", "", true);
    render(panel());
    button("검토한 내용 저장").onClick!();
    await tick();
    expect(callData(1)).toMatchObject({ action: "save", change: { reviewFingerprint: hash } });
  });
  it("reserves only the opaque pinned budget identity with the reviewed cash amount", async () => {
    const data = pinnedResponse();
    harness.client.setQueryData(["operating-allocation", "owner-a", "KRW"], data);
    render(panel());
    button("후보 현금 예약 검토").onClick!();
    await tick();
    expect(callData(0)).toMatchObject({
      change: {
        kind: "RESERVE",
        reservation: {
          signalId: "opaque-server-budget",
          signalBudgetId: "opaque-server-budget",
          amount: "500.75",
          market: "KR",
          currency: "KRW",
        },
      },
    });
    expect(JSON.stringify(callData(0))).not.toContain('"security"');
  });
  it("invalidates a previous candidate review when the latest estimate changes", async () => {
    server.mockResolvedValue({ ...response(), reviewFingerprint: hash });
    render(panel());
    button("후보 예산 확정 검토").onClick!();
    await tick();
    expect(render(panel())).toContain("저장 전 검토");
    expect(render(panel({ ...candidate, cashRequired: "600.9", quantity: "6" }))).not.toContain(
      "저장 전 검토",
    );
    expect(server).toHaveBeenCalledTimes(1);
  });
  it("refreshes the same owner's saved revision even if the selected candidate changed during save", async () => {
    server.mockResolvedValueOnce({ ...response(), reviewFingerprint: hash });
    render(panel());
    button("후보 예산 확정 검토").onClick!();
    await tick();
    render(panel());
    change("저장 내용 확인", "", true);
    render(panel());
    const pending = deferred<OperatingAllocationResponse>();
    server.mockReturnValueOnce(pending.promise);
    button("검토한 내용 저장").onClick!();
    await tick();
    render(panel({ ...candidate, symbol: "654321" }));
    pending.resolve({ ...response(), revision: 5 });
    await tick();
    expect(
      harness.client.getQueryData<OperatingAllocationResponse>([
        "operating-allocation",
        "owner-a",
        "KRW",
      ])?.revision,
    ).toBe(5);
    expect(render(panel({ ...candidate, symbol: "654321" }))).not.toContain(
      "확인한 배정 내역을 저장했습니다",
    );
  });
  it.each(["WAITING", "SKIPPED"] as const)(
    "allows server budget review while %s but does not reserve unknown cash",
    async (status) => {
      server.mockResolvedValue({ ...response(), reviewFingerprint: hash });
      render(panel({ ...candidate, status, cashRequired: null, quantity: null }));
      expect(button("후보 예산 확정 검토").disabled).toBe(false);
      button("후보 예산 확정 검토").onClick!();
      await tick();
      expect(callData(0)).toMatchObject({
        action: "preview",
        change: { kind: "PIN_SIGNAL_BUDGET" },
      });
      harness.client.setQueryData(["operating-allocation", "owner-a", "KRW"], pinnedResponse());
      render(panel({ ...candidate, status, cashRequired: null, quantity: null }));
      expect(button("후보 현금 예약 검토").disabled).toBe(true);
    },
  );
  it("suppresses new reservation of an already reserved symbol even on a different origin", () => {
    const data = pinnedResponse();
    data.authority = {
      version: 1,
      currency: "KRW",
      sourceRevision: 4,
      sourceFingerprint: hash,
      cashAtReview: "1000",
      claims: { KR: "600", ETF: "300", US: "0", UNASSIGNED: "100" },
      spendableCash: null,
      reviewedAt: "2026-10-12T12:00:00Z",
      reservations: [
        {
          id: "pending",
          signalId: "old",
          signalBudgetId: "old",
          amount: "500.75",
          market: "KR",
          currency: "KRW",
          security: { ...data.sizing.signalBudgets[0]!.security!, originDate: "2026-10-11" },
        },
      ],
    };
    harness.client.setQueryData(["operating-allocation", "owner-a", "KRW"], data);
    expect(render(panel())).toContain("기존 미체결 예약 있음");
    expect(harness.buttons.some((b) => b.children === "후보 현금 예약 검토")).toBe(false);
    expect(button("예약 해제 검토").disabled).toBe(false);
  });
});
