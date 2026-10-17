import React, { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { emptyEntryDecisions, type EntryDecisionDocument } from "@/lib/actualEntryDecisions";
const h = vi.hoisted(() => ({
  states: [] as unknown[],
  refs: [] as { current: unknown }[],
  si: 0,
  ri: 0,
  form: null as null | ((e: { preventDefault: () => void }) => void),
  selects: [] as ((e: { target: { value: string } }) => void)[],
  owner: "owner",
  close: vi.fn(),
  server: vi.fn(),
  invalidate: vi.fn(),
  cache: vi.fn(),
  cancel: vi.fn(),
  doc: { revision: 0, events: [] } as EntryDecisionDocument,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const i = h.si++;
    if (!(i in h.states)) h.states[i] = i === 0 ? "owner" : initial;
    return [
      h.states[i],
      (v: unknown) => {
        h.states[i] = v;
      },
    ];
  },
  useRef: (initial: unknown) => {
    const i = h.ri++;
    return h.refs[i] ?? (h.refs[i] = { current: i === 0 ? "owner" : initial });
  },
  useEffect: () => undefined,
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ setQueryData: h.cache, cancelQueries: h.cancel }),
  useQuery: () => ({ data: h.doc, isError: false, isFetching: false, refetch: vi.fn() }),
}));
vi.mock("@/lib/cloud", () => ({
  supabase: {
    auth: {
      getSession: async () => ({
        data: { session: { user: { id: h.owner }, access_token: "test" } },
        error: null,
      }),
    },
  },
}));
vi.mock("@/lib/actualEntryDecisions.functions", () => ({ actualEntryDecisionsServer: h.server }));
vi.mock("@/lib/dashboardActualRefresh", () => ({ invalidateActualPositionViews: h.invalidate }));
vi.mock("./ui/dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: ReactNode }) => {
    const walk = (nodes: ReactNode) =>
      React.Children.forEach(nodes, (node) => {
        if (!React.isValidElement<Record<string, unknown>>(node)) return;
        if (node.type === "form") h.form = node.props["onSubmit"] as typeof h.form;
        if (node.type === "select")
          h.selects.push(node.props["onChange"] as (typeof h.selects)[number]);
        walk(node.props["children"] as ReactNode);
      });
    walk(children);
    return <div>{children}</div>;
  },
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
}));
import { ActualEntryDecisionDialog } from "./ActualEntryDecisions";
const candidate = {
  market: "KOSDAQ" as const,
  symbol: "TEST",
  name: "Synthetic",
  signalOriginDate: "2026-10-16",
};
const render = () => {
  h.si = 0;
  h.ri = 0;
  h.selects = [];
  return renderToStaticMarkup(
    <ActualEntryDecisionDialog candidate={candidate} onClose={h.close} />,
  );
};
const submit = async () => {
  h.form!({ preventDefault: () => undefined });
  await new Promise((resolve) => setTimeout(resolve, 0));
};
beforeEach(() => {
  vi.clearAllMocks();
  h.states = [];
  h.refs = [];
  h.owner = "owner";
  h.doc = emptyEntryDecisions();
  h.server.mockResolvedValue(h.doc);
  h.invalidate.mockResolvedValue(undefined);
  h.cancel.mockResolvedValue(undefined);
});
it("defaults independence to persistent, with no quantity or capital inputs", async () => {
  const html = render();
  expect(html).toContain('value="symbol" selected');
  expect(html).toContain("독립성 제한");
  expect(html).toContain("Shadow는 전략대로 계속");
  expect(html).not.toContain('type="number"');
  await submit();
  expect(h.server).toHaveBeenCalledWith({
    data: expect.objectContaining({
      action: "save",
      expectedRevision: 0,
      command: expect.objectContaining({ ...candidate, reason: "독립성 제한", scope: "symbol" }),
    }),
  });
  expect(h.close).toHaveBeenCalledOnce();
  expect(h.invalidate).toHaveBeenCalledWith(expect.anything(), true);
});
it("other reasons default to this signal and retain user-selected scope", async () => {
  render();
  h.selects[0]!({ target: { value: "자금 부족" } });
  render();
  await submit();
  expect(h.server.mock.calls[0]?.[0].data.command).toMatchObject({
    reason: "자금 부족",
    scope: "signal",
  });
});
it("does not write after account switch", async () => {
  render();
  h.owner = "other";
  await submit();
  expect(h.server).not.toHaveBeenCalled();
  expect(h.close).not.toHaveBeenCalled();
});
it("locks double submit", async () => {
  let resolve!: (v: unknown) => void;
  h.server.mockReturnValueOnce(
    new Promise((r) => {
      resolve = r;
    }),
  );
  render();
  h.form!({ preventDefault: () => undefined });
  h.form!({ preventDefault: () => undefined });
  await new Promise((r) => setTimeout(r, 0));
  expect(h.server).toHaveBeenCalledTimes(1);
  resolve(h.doc);
  await new Promise((r) => setTimeout(r, 0));
});

it("retries an uncertain response with the same request id", async () => {
  h.server.mockRejectedValueOnce(new Error("저장 확인 필요"));
  render();
  await submit();
  expect(h.close).not.toHaveBeenCalled();
  const first = h.server.mock.calls[0]?.[0].data.command.id;
  render();
  await submit();
  expect(h.server.mock.calls[1]?.[0].data.command.id).toBe(first);
  expect(h.close).toHaveBeenCalledOnce();
});
