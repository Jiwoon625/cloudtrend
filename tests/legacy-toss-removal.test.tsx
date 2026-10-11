import React, { type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (value: unknown) => [value, vi.fn()],
}));
vi.mock("@/components/AppShell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));
import { DataError } from "../src/components/DataError";
function buttons(node: unknown): ReactElement<{ onClick: () => Promise<void> }>[] {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(buttons);
  const element = node as ReactElement<{ onClick?: () => Promise<void>; children?: unknown }>;
  return [
    ...(element.props?.onClick ? [element as ReactElement<{ onClick: () => Promise<void> }>] : []),
    ...buttons(element.props?.children),
  ];
}
it.each(["자료 조회 실패", "401 인증 만료", "403 저장 자료 접근 거절"])(
  "saved-data error has no old provider setup instructions: %s",
  (message) => {
    const html = renderToStaticMarkup(<DataError error={new Error(message)} embedded />);
    expect(html).toContain(message);
    expect(html).toContain("로그인 상태와 업로드된 자료");
    expect(html).not.toMatch(/토스|TOSS_CLIENT|출구 IP|허용 IP|연결 상태 초기화/);
  },
);
it("retry only calls its supplied read callback", async () => {
  const reset = vi.fn(async () => undefined),
    fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  try {
    const view = DataError({ error: "failed", reset, embedded: true });
    await buttons(view)[0]!.props.onClick();
    expect(reset).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});
it("removes web provider adapter and all legacy RPC declarations while retaining upload contracts", () => {
  for (const name of [
    "src/lib/market.functions.ts",
    "src/lib/engine/toss.server.ts",
    "src/lib/engine/kospi200.ts",
    "src/components/CollectionProgress.tsx",
    "src/components/StockUniverseInput.tsx",
    "src/components/EtfUniverseInput.tsx",
  ])
    expect(existsSync(name)).toBe(false);
  expect(readFileSync("src/lib/marketPayload.ts", "utf8")).not.toContain("createServerFn");
  expect(readFileSync("src/lib/analysisQuery.ts", "utf8")).not.toMatch(
    /getServerEgressIp|market.functions/,
  );
  expect(readFileSync("src/lib/engine/etfStrategy.ts", "utf8")).toContain("TOSS_ADJUSTED_CANDLE");
});
