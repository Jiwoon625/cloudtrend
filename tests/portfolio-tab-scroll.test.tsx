import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
const state = vi.hoisted(() => ({ asset: "KR", navigate: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({
    options,
    useSearch: () => ({ asset: state.asset }),
    useNavigate: () => state.navigate,
  }),
  Link: () => null,
}));
vi.mock("@/lib/cloud", () => ({ supabase: {} }));
import { Route } from "../src/routes/portfolio";
it.each(["KR", "US", "ETF"])("switches to %s without requesting a scroll reset", (asset) => {
  state.navigate.mockClear();
  const component = (
    Route.options as unknown as {
      component: () => ReactElement<{
        onAssetChange: (asset: string) => void;
        selectedAsset: string;
        children?: ReactNode;
      }>;
    }
  ).component;
  const view = component();
  const hub = [view, ...Children.toArray(view.props.children)].find(
    (child) => isValidElement<{ onAssetChange?: (asset: string) => void }>(child) && typeof child.props.onAssetChange === "function",
  );
  expect(hub && isValidElement(hub)).toBe(true);
  if (!hub || !isValidElement(hub)) throw new Error("Missing PortfolioAssetHub");
  (hub.props as { onAssetChange: (asset: string) => void }).onAssetChange(asset);
  expect(state.navigate).toHaveBeenCalledExactlyOnceWith({ search: { asset }, resetScroll: false });
});
it("keeps keyboard tab focus from scrolling the page", () => {
  expect(readFileSync("src/components/NewActualPortfolio.tsx", "utf8")).toContain(
    "focus({ preventScroll: true })",
  );
});
