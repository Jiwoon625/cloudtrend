import React, { type ReactNode, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { PortfolioAssetHub } from "./PortfolioAssetHub";
import { UsPortfolioLedgers } from "./UsPortfolioLedgers";
import { toast } from "sonner";
import { KoreaPortfolioContent, Route } from "@/routes/portfolio";
import { calculateActual, type DualPortfolioState } from "@/lib/portfolioLedgers";
import type { UsActualState } from "@/lib/usActualLedger";
import { portfolioLedgersServer } from "@/lib/portfolioLedgers.functions";
import { usActualLedgerServer } from "@/lib/usActualLedger.functions";

type ButtonProps = {
  children?: ReactNode;
  "aria-label"?: string;
  disabled?: boolean;
  onClick?: () => unknown;
};
type InputProps = {
  value?: string;
  disabled?: boolean;
  step?: number | string;
  onChange?: (event: { target: { value: string } }) => void;
};
type Submit = (event: { preventDefault: () => void }) => void;

// A small deterministic hook/handler harness exercises the actual component handlers in
// Node. React SSR supplies markup assertions; no jsdom or browser authentication is needed.
const harness = vi.hoisted(() => ({
  states: [] as unknown[],
  refs: [] as { current: unknown }[],
  stateCursor: 0,
  refCursor: 0,
  buttons: [] as ButtonProps[],
  inputs: [] as InputProps[],
  queryFns: new Map<string, () => Promise<unknown>>(),
  client: null as unknown as QueryClient,
  dialogChange: undefined as undefined | ((open: boolean) => void),
  submit: undefined as undefined | ((event: { preventDefault: () => void }) => void),
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
  useEffect: () => undefined,
}));
vi.mock("@tanstack/react-query", async (original) => ({
  ...(await original<typeof import("@tanstack/react-query")>()),
  useQueryClient: () => harness.client,
  useQuery: ({ queryKey, queryFn }: { queryKey: string[]; queryFn: () => Promise<unknown> }) => {
    harness.queryFns.set(queryKey[0]!, queryFn);
    return {
      data: harness.client.getQueryData(queryKey),
      error: null,
      isFetching: false,
      isPending: false,
      refetch: async () => {
        try {
          const data = await queryFn();
          harness.client.setQueryData(queryKey, data);
          return { data, isError: false };
        } catch (error) {
          return { error, isError: true };
        }
      },
    };
  },
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
  lazyRouteComponent: () => () => null,
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/cloud", () => ({
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: { access_token: "test-token" } }, error: null }),
    },
  },
}));
vi.mock("@/lib/portfolioLedgers.functions", () => ({ portfolioLedgersServer: vi.fn() }));
vi.mock("@/lib/usActualLedger.functions", () => ({ usActualLedgerServer: vi.fn() }));
vi.mock("@/lib/usePortfolioModelConsolidation", () => ({
  usePortfolioModelConsolidation: () => ({
    ready: false,
    checking: false,
    error: null,
    refresh: vi.fn(),
    refreshing: false,
  }),
}));
vi.mock("./UsModelExecutionJournal", () => ({
  UsModelExecutionJournal: () => <section>A0 모델 체결 원장</section>,
}));
vi.mock("@/lib/usProspectiveCloud", () => ({ loadUsPortfolioSnapshots: vi.fn(async () => []) }));
vi.mock("@/lib/usTaxOverlay", () => ({ actualUsTaxOverlay: vi.fn(() => ({})) }));
vi.mock("./UsTaxEstimatePanel", () => ({ UsTaxEstimatePanel: () => null }));
vi.mock("./UsModelTaxEstimatePanel", () => ({ UsModelTaxEstimatePanel: () => null }));
vi.mock("./AppShell", () => ({
  AppShell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));
vi.mock("./ui/button", () => ({
  Button: (props: ButtonProps) => {
    harness.buttons.push(props);
    return (
      <button disabled={props.disabled} aria-label={props["aria-label"]}>
        {props.children}
      </button>
    );
  },
}));
vi.mock("./ui/input", () => ({
  Input: (props: InputProps) => {
    harness.inputs.push(props);
    return <input disabled={props.disabled} value={props.value} readOnly />;
  },
}));
vi.mock("./ui/dialog", () => ({
  Dialog: ({
    children,
    open,
    onOpenChange,
  }: {
    children: ReactNode;
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }) => {
    harness.dialogChange = onOpenChange;
    return open ? <aside>{children}</aside> : null;
  },
  DialogContent: ({ children }: { children: ReactNode }) => {
    for (const child of React.Children.toArray(children)) {
      if (React.isValidElement(child) && child.type === "form")
        harness.submit = (child.props as { onSubmit?: Submit }).onSubmit;
    }
    return <div>{children}</div>;
  },
  DialogHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
}));

const execution = {
  id: "existing",
  symbol: "005930",
  name: "검증 종목",
  market: "KOSPI" as const,
  side: "BUY" as const,
  signalKey: "signal",
  date: "2026-10-01",
  price: 100,
  shares: 10,
  fee: 0,
  note: "보존할 메모",
  order: 0,
};
function domestic() {
  const actual = calculateActual(10000000, [execution], {}, null);
  return {
    revision: 3,
    actual,
    etfActual: calculateActual(10000000, [], {}, null),
    etfRows: [],
    etfTrackedSymbols: [],
    document: {
      executions: [execution],
      excluded: {},
      actualCapital: 10000000,
      etfCapital: 12000000,
      settings: { initialCapital: 10000000 },
      strategy: { summary: actual.summary, trades: [], candidates: [], quotes: {} },
    },
  };
}
function us() {
  const e = { ...execution, symbol: "TEST", market: "US" as const };
  return {
    revision: 3,
    actual: calculateActual(100000, [e], {}, null),
    document: { capital: 100000, executions: [e], excluded: {} },
    quotes: { TEST: { price: 100 } },
    candidates: [{ key: "signal", symbol: "TEST", name: e.name, date: "2026-10-01" }],
  };
}
function render(element: ReactElement) {
  harness.stateCursor = harness.refCursor = 0;
  harness.buttons = [];
  harness.inputs = [];
  harness.submit = undefined;
  return renderToStaticMarkup(element);
}
function button(text: string) {
  const match = harness.buttons.find(
    (p) =>
      React.Children.toArray(p.children)
        .filter((child) => typeof child === "string")
        .join("") === text || p["aria-label"] === text,
  );
  expect(match, `Button ${text} exists`).toBeTruthy();
  return match!;
}
function koreaElement() {
  return <KoreaPortfolioContent />;
}
function requestData(call: readonly unknown[] | undefined) {
  return (call?.[0] as { data: { action: string; revision: number } }).data;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.clearAllMocks();
  harness.states = [];
  harness.refs = [];
  harness.queryFns.clear();
  harness.client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  harness.client.setQueryData(["portfolio-ledgers"], domestic());
  harness.client.setQueryData(["us-actual-ledger"], us());
  harness.client.setQueryData(["us-portfolio-snapshots"], []);
  vi.mocked(portfolioLedgersServer).mockImplementation(
    async () => domestic() as unknown as DualPortfolioState,
  );
  vi.mocked(usActualLedgerServer).mockImplementation(async () => us() as unknown as UsActualState);
});
afterEach(() => {
  harness.client.clear();
  vi.unstubAllGlobals();
});

describe("portfolio ledger UI wiring", () => {
  it("labels unified records and configured-capital calculations without claiming verified broker cash", () => {
    const hub = render(<PortfolioAssetHub domestic={<p>국내</p>} />);
    expect(hub).toContain("통합 원장");
    expect(hub).toContain("기초 현금·입출금·결제 내역이 확인되지 않아");
    expect(hub).toContain("증권사 잔고나 주문 가능 금액으로 사용할 수 없습니다");
    harness.states = [];
    harness.refs = [];
    const usMarkup = render(
      <UsPortfolioLedgers model={undefined} initialTab="actual">
        모델
      </UsPortfolioLedgers>,
    );
    expect(usMarkup).not.toContain("운용자금 기준 계산 현금");
    expect(usMarkup).not.toContain("운용자금 기준 평가자산");
    expect(usMarkup).not.toContain("$99,000.00");
    harness.states = [];
    harness.refs = [];
    const krMarkup = render(koreaElement());
    expect(krMarkup).not.toContain("운용자금 기준 계산 현금");
    expect(krMarkup).not.toContain("운용자금 기준 평가자산");
    for (const html of [hub, usMarkup, krMarkup]) {
      for (const label of ["기존 원장 누적손익", "실현손익", "평가손익"])
        expect(html).not.toContain(label);
    }
    expect(portfolioLedgersServer).not.toHaveBeenCalled();
    expect(usActualLedgerServer).not.toHaveBeenCalled();
  });

  it.each(["hub", "US"])(
    "%s displays and edits cleaned memos while preserving source references",
    async (surface) => {
      const url = "https://notion.so/synthetic-memo-source";
      const key = surface === "US" ? "us-actual-ledger" : "portfolio-ledgers";
      const state = structuredClone(surface === "US" ? us() : domestic());
      state.document.executions[0]!.note = `한글 메모\n[원본](${url})`;
      state.actual.executions[0]!.note = state.document.executions[0]!.note;
      harness.client.setQueryData([key], state);
      const element =
        surface === "US" ? (
          <UsPortfolioLedgers model={undefined} initialTab="actual">
            모델
          </UsPortfolioLedgers>
        ) : (
          <PortfolioAssetHub domestic={<p>국내</p>} />
        );
      const markup = render(element);
      expect(markup).toContain("한글 메모");
      expect(markup).not.toContain(url);
      button("수정").onClick!();
      render(element);
      expect(harness.inputs.some((input) => input.value === "한글 메모\n원본")).toBe(true);
      expect(harness.inputs.some((input) => input.value?.includes("notion.so"))).toBe(false);
      if (surface === "US") button("실제 원장에 저장").onClick!();
      else harness.submit!({ preventDefault: vi.fn() });
      const server =
        surface === "US" ? vi.mocked(usActualLedgerServer) : vi.mocked(portfolioLedgersServer);
      await vi.waitFor(() => expect(server).toHaveBeenCalledOnce());
      const data = (
        server.mock.lastCall![0] as {
          data: { execution: { note: string; sourceLinks: unknown[] } };
        }
      ).data;
      expect(data.execution.note).toBe("한글 메모\n원본");
      expect(data.execution.sourceLinks).toEqual([{ system: "notion", url, label: "원본" }]);
      expect(state.document.executions[0]!.note).toContain(url);
    },
  );

  it("rejects a newly pasted Notion memo URL without saving or discarding the draft", () => {
    const element = <PortfolioAssetHub domestic={<p>국내</p>} />;
    render(element);
    button("수정").onClick!();
    render(element);
    const note = "keep https://notion.so/new-source";
    harness.inputs.find((input) => input.value === execution.note)!.onChange!({
      target: { value: note },
    });
    render(element);
    harness.submit!({ preventDefault: vi.fn() });
    expect(portfolioLedgersServer).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("Notion URL"));
    render(element);
    expect(harness.inputs.some((input) => input.value === note)).toBe(true);
  });

  it("uses the URL asset for initial selection and Back/Forward without any writes", () => {
    const validate = (
      Route as unknown as {
        options: { validateSearch: (value: Record<string, unknown>) => { asset: string } };
      }
    ).options.validateSearch;
    expect(validate({ asset: "US" })).toEqual({ asset: "US" });
    expect(validate({ asset: "ETF" })).toEqual({ asset: "ETF" });
    expect(validate({ asset: "unknown" })).toEqual({ asset: "KR" });
    const onAssetChange = vi.fn();
    expect(
      render(
        <PortfolioAssetHub
          domestic={<p>국내</p>}
          selectedAsset="ETF"
          onAssetChange={onAssetChange}
        />,
      ),
    ).toContain('aria-label="ETF"');
    button("한국주식").onClick!();
    expect(onAssetChange).toHaveBeenCalledWith("KR");
    expect(
      render(
        <PortfolioAssetHub
          domestic={<p>국내</p>}
          selectedAsset="KR"
          onAssetChange={onAssetChange}
        />,
      ),
    ).toContain('aria-label="한국주식"');
    expect(
      render(
        <PortfolioAssetHub
          domestic={<p>국내</p>}
          selectedAsset="ETF"
          onAssetChange={onAssetChange}
        />,
      ),
    ).toContain('aria-label="ETF"');
    expect(portfolioLedgersServer).not.toHaveBeenCalled();
    expect(usActualLedgerServer).not.toHaveBeenCalled();
  });

  it("ordinary reads, Back/remount, and refresh only load; model synchronization remains an explicit action", async () => {
    const hub = <PortfolioAssetHub domestic={<p>국내</p>} />;
    render(hub);
    button("새로고침").onClick!();
    await vi.waitFor(() => expect(portfolioLedgersServer).toHaveBeenCalledOnce());
    expect(requestData(vi.mocked(portfolioLedgersServer).mock.calls[0]).action).toBe("load");
    expect(requestData(vi.mocked(usActualLedgerServer).mock.calls[0]).action).toBe("load");
    harness.states = [];
    harness.refs = [];
    render(hub); // Back/Forward creates a fresh component, never a write.
    expect(portfolioLedgersServer).toHaveBeenCalledOnce();
    harness.states = [];
    harness.refs = [];
    render(koreaElement());
    await harness.queryFns.get("portfolio-ledgers")!();
    expect(requestData(vi.mocked(portfolioLedgersServer).mock.lastCall).action).toBe("load");
    button("전략·시세 동기화").onClick!();
    await vi.waitFor(() =>
      expect(requestData(vi.mocked(portfolioLedgersServer).mock.lastCall).action).toBe("sync"),
    );
  });

  it("hub same-tick saves use the opening revision, keep Close locked, and prevent refresh while saving", async () => {
    const element = <PortfolioAssetHub domestic={<p>국내</p>} />;
    render(element);
    button("수정").onClick!();
    render(element);
    harness.client.setQueryData(["portfolio-ledgers"], { ...domestic(), revision: 9 });
    render(element);
    const pending = deferred<ReturnType<typeof domestic>>();
    vi.mocked(portfolioLedgersServer).mockImplementation(
      () => pending.promise as unknown as Promise<DualPortfolioState>,
    );
    const submit = harness.submit!;
    submit({ preventDefault: vi.fn() });
    submit({ preventDefault: vi.fn() });
    harness.dialogChange!(false);
    button("새로고침").onClick!();
    expect(render(element)).toContain("실제 원장에 저장");
    expect(button("실제 원장에 저장").disabled).toBe(true);
    await vi.waitFor(() => expect(portfolioLedgersServer).toHaveBeenCalledOnce());
    expect(requestData(vi.mocked(portfolioLedgersServer).mock.lastCall).revision).toBe(3);
    pending.resolve({ ...domestic(), revision: 10 });
    await vi.waitFor(() => expect(render(element)).not.toContain("실제 원장에 저장"));
  });

  it("US lost-response retry remains disabled after refresh and keeps the entered draft", async () => {
    const element = (
      <UsPortfolioLedgers model={undefined} initialTab="signals">
        모델
      </UsPortfolioLedgers>
    );
    render(element);
    button("매수 / 미매수 기록").onClick!();
    render(element);
    harness.inputs.find((p) => p.step === 1)!.onChange!({ target: { value: "17" } });
    render(element);
    vi.mocked(usActualLedgerServer).mockRejectedValueOnce(new Error("응답 소실"));
    button("실제 원장에 저장").onClick!();
    await vi.waitFor(() => expect(render(element)).toContain("저장 결과가 확실하지 않습니다"));
    expect(harness.inputs.find((p) => p.step === 1)!.value).toBe("17");
    expect(button("실제 원장에 저장").disabled).toBe(true);
    vi.mocked(usActualLedgerServer).mockResolvedValue({
      ...us(),
      revision: 4,
    } as unknown as UsActualState);
    button("실제 원장 새로고침").onClick!();
    await vi.waitFor(() => expect(usActualLedgerServer).toHaveBeenCalledTimes(2));
    render(element);
    expect(button("실제 원장에 저장").disabled).toBe(true);
    button("실제 원장에 저장").onClick!();
    await Promise.resolve();
    expect(usActualLedgerServer).toHaveBeenCalledTimes(2);
    button("체결 입력 닫기").onClick!();
    expect(render(element)).not.toContain("실제 원장에 저장");
  });

  it.each(["US", "KR"])(
    "%s Close/Cancel callbacks cannot drop a pending draft and capital revisions stay pinned",
    async (market) => {
      const element =
        market === "US" ? (
          <UsPortfolioLedgers model={undefined} initialTab="actual">
            모델
          </UsPortfolioLedgers>
        ) : (
          koreaElement()
        );
      render(element);
      button(market === "US" ? "실제 운용자금 설정" : "운용자금 설정").onClick!();
      render(element);
      const key = market === "US" ? "us-actual-ledger" : "portfolio-ledgers";
      harness.client.setQueryData([key], { ...(market === "US" ? us() : domestic()), revision: 8 });
      render(element);
      const pending = deferred<ReturnType<typeof us> | ReturnType<typeof domestic>>();
      const server =
        market === "US" ? vi.mocked(usActualLedgerServer) : vi.mocked(portfolioLedgersServer);
      if (market === "US")
        vi.mocked(usActualLedgerServer).mockImplementation(
          () => pending.promise as unknown as Promise<UsActualState>,
        );
      else
        vi.mocked(portfolioLedgersServer).mockImplementation(
          () => pending.promise as unknown as Promise<DualPortfolioState>,
        );
      const save = button(market === "US" ? "운용자금 저장" : "저장");
      save.onClick!();
      save.onClick!();
      button("취소").onClick!();
      render(element);
      expect(button("취소").disabled).toBe(true);
      await vi.waitFor(() => expect(server).toHaveBeenCalledOnce());
      expect(requestData(server.mock.lastCall).revision).toBe(3);
      pending.resolve({ ...(market === "US" ? us() : domestic()), revision: 9 });
      await vi.waitFor(() => {
        render(element);
        expect(harness.buttons.some((p) => p.children === "취소")).toBe(false);
      });
    },
  );
  it.each(["US", "KR"])(
    "%s execution editor pins its revision and ignores same-tick Save/Close",
    async (market) => {
      const element =
        market === "US" ? (
          <UsPortfolioLedgers model={undefined} initialTab="actual">
            모델
          </UsPortfolioLedgers>
        ) : (
          koreaElement()
        );
      render(element);
      button("매도 기록").onClick!();
      render(element);
      harness.client.setQueryData([market === "US" ? "us-actual-ledger" : "portfolio-ledgers"], {
        ...(market === "US" ? us() : domestic()),
        revision: 8,
      });
      render(element);
      const pending = deferred<unknown>();
      const server =
        market === "US" ? vi.mocked(usActualLedgerServer) : vi.mocked(portfolioLedgersServer);
      if (market === "US")
        vi.mocked(usActualLedgerServer).mockImplementation(
          () => pending.promise as Promise<UsActualState>,
        );
      else
        vi.mocked(portfolioLedgersServer).mockImplementation(
          () => pending.promise as Promise<DualPortfolioState>,
        );
      const save = button("실제 원장에 저장");
      save.onClick!();
      save.onClick!();
      button("체결 입력 닫기").onClick!();
      render(element);
      expect(button("체결 입력 닫기").disabled).toBe(true);
      await vi.waitFor(() => expect(server).toHaveBeenCalledOnce());
      expect(requestData(server.mock.lastCall).revision).toBe(3);
      pending.resolve({ ...(market === "US" ? us() : domestic()), revision: 9 });
      await vi.waitFor(() => expect(render(element)).not.toContain("실제 원장에 저장"));
    },
  );

  it("ETF capital starts with its saved value and protects its original revision against repeat Save/Cancel", async () => {
    const element = <PortfolioAssetHub domestic={<p>국내</p>} />;
    render(element);
    button("ETF").onClick!();
    render(element);
    button("ETF 운용자금 설정").onClick!();
    render(element);
    expect(harness.inputs.some((p) => p.value === "12000000")).toBe(true);
    harness.client.setQueryData(["portfolio-ledgers"], { ...domestic(), revision: 8 });
    render(element);
    const pending = deferred<unknown>();
    vi.mocked(portfolioLedgersServer).mockImplementation(
      () => pending.promise as Promise<DualPortfolioState>,
    );
    const save = button("저장");
    save.onClick!();
    save.onClick!();
    button("취소").onClick!();
    render(element);
    expect(button("취소").disabled).toBe(true);
    await vi.waitFor(() => expect(portfolioLedgersServer).toHaveBeenCalledOnce());
    expect(requestData(vi.mocked(portfolioLedgersServer).mock.lastCall).revision).toBe(3);
    pending.resolve({ ...domestic(), revision: 9 });
    await vi.waitFor(() => {
      render(element);
      expect(harness.buttons.some((p) => p.children === "취소")).toBe(false);
    });
  });

  it("repeated delete clicks ask once and submit one canonical remove", async () => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal("window", { confirm });
    const element = <PortfolioAssetHub domestic={<p>국내</p>} />;
    render(element);
    const pending = deferred<unknown>();
    vi.mocked(portfolioLedgersServer).mockImplementation(
      () => pending.promise as Promise<DualPortfolioState>,
    );
    const remove = button("삭제");
    remove.onClick!();
    remove.onClick!();
    expect(confirm).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(portfolioLedgersServer).toHaveBeenCalledOnce());
    expect(requestData(vi.mocked(portfolioLedgersServer).mock.lastCall).action).toBe("remove");
    pending.resolve({ ...domestic(), revision: 4 });
    await vi.waitFor(() => {
      render(element);
      expect(button("삭제").disabled).toBe(false);
    });
  });
});
