import { readFileSync } from "node:fs";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { expect, test, vi } from "vitest";
vi.mock("../src/lib/cloud", () => ({ supabase: {} }));
vi.mock("../src/lib/portfolioLedgers.functions", () => ({
  portfolioLedgersServer: vi.fn(),
  portfolioPositionContextServer: vi.fn(),
}));
import { domesticPortfolioQueryOptions } from "../src/lib/portfolioPositionContext";

test("portfolio remount reuses shared fresh data and explicit changes invalidate it", async () => {
  const client = new QueryClient();
  const queryFn = vi.fn(async () => ({ version: queryFn.mock.calls.length }));
  const options = {
    ...domesticPortfolioQueryOptions,
    queryFn,
  };
  try {
    await client.fetchQuery(options);
    const observer = new QueryObserver(client, options);
    const unsubscribe = observer.subscribe(() => {});
    unsubscribe();
    await client.fetchQuery(options);
    expect(queryFn).toHaveBeenCalledTimes(1);
    await client.invalidateQueries({ queryKey: options.queryKey });
    await client.fetchQuery(options);
    expect(queryFn).toHaveBeenCalledTimes(2);
    await observer.refetch();
    expect(queryFn).toHaveBeenCalledTimes(3);
  } finally {
    client.clear();
  }
});

test("legacy dashboard consumers retain bounded metadata freshness without discarding session data", () => {
  expect(domesticPortfolioQueryOptions.queryKey).toEqual(["portfolio-ledgers"]);
  expect(domesticPortfolioQueryOptions.staleTime).toBe(60_000);
  expect(domesticPortfolioQueryOptions.gcTime).toBe(Infinity);
  expect(domesticPortfolioQueryOptions.refetchOnWindowFocus).toBe(true);
  expect(domesticPortfolioQueryOptions.retry).toBe(false);
  for (const path of ["src/routes/portfolio.tsx", "src/routes/index.tsx"]) {
    expect(readFileSync(path, "utf8")).toMatch(
      /(?:\.\.\.|useQuery\()domesticPortfolioQueryOptions/,
    );
  }
  for (const path of ["src/routes/index.tsx", "src/routes/scoring.tsx"]) {
    expect(readFileSync(path, "utf8")).toMatch(
      /invalidateQueries\(\{\s*queryKey:\s*\["portfolio-ledgers"\]/,
    );
  }
});

test("the portfolio hub reads only owner-scoped new-series data with bounded freshness", async () => {
  const hub = readFileSync("src/components/PortfolioAssetHub.tsx", "utf8");
  expect(hub).toContain("<NewActualPortfolio");
  expect(hub).not.toContain("domesticPortfolioQueryOptions");
  const component = readFileSync("src/components/NewActualPortfolio.tsx", "utf8");
  expect(component).toContain('const queryKey = ["new-actual-portfolio", owner] as const;');
  expect(component).toMatch(/useQuery\(\{\s*queryKey,\s*enabled:\s*!!owner,/);
  expect(component).toMatch(/gcTime:\s*0,/);
  expect(component).toMatch(/staleTime:\s*30_000,/);
  expect(component).not.toContain("placeholderData:");

  // Exercise the bounded, owner-keyed cache contract with synthetic responses.
  // Keep observers mounted, as the component deliberately discards inactive data.
  const client = new QueryClient();
  const queryFn = vi.fn(async ({ queryKey }: { queryKey: readonly string[] }) => ({
    owner: queryKey[1],
    revision: queryFn.mock.calls.length,
  }));
  const options = (owner: string) => ({
    queryKey: ["new-actual-portfolio", owner] as const,
    queryFn,
    staleTime: 30_000,
    gcTime: 0,
  });
  const first = options("synthetic-owner-a");
  const second = options("synthetic-owner-b");
  const unsubscribes: (() => void)[] = [];
  try {
    const firstResponse = await client.fetchQuery(first);
    unsubscribes.push(new QueryObserver(client, first).subscribe(() => {}));
    expect(await client.fetchQuery(first)).toEqual(firstResponse);
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(client.getQueryData(second.queryKey)).toBeUndefined();
    const secondResponse = await client.fetchQuery(second);
    unsubscribes.push(new QueryObserver(client, second).subscribe(() => {}));
    expect(secondResponse.owner).toBe("synthetic-owner-b");
    expect(await client.fetchQuery(second)).toEqual(secondResponse);
    expect(queryFn).toHaveBeenCalledTimes(2);
    await client.invalidateQueries({ queryKey: first.queryKey, refetchType: "none" });
    await client.fetchQuery(first);
    expect(queryFn).toHaveBeenCalledTimes(3);
    expect(await client.fetchQuery(second)).toEqual(secondResponse);
    expect(queryFn).toHaveBeenCalledTimes(3);
  } finally {
    for (const unsubscribe of unsubscribes) unsubscribe();
    client.clear();
  }
});

test("expired shared metadata can observe an external update while fresh remounts reuse it", async () => {
  const client = new QueryClient();
  const now = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
  const queryFn = vi.fn(async () => ({ revision: queryFn.mock.calls.length }));
  const options = { ...domesticPortfolioQueryOptions, queryFn };
  try {
    await client.fetchQuery(options);
    now.mockReturnValue(1_800_000_059_000);
    await client.fetchQuery(options);
    expect(queryFn).toHaveBeenCalledTimes(1);
    now.mockReturnValue(1_800_000_061_000);
    await client.fetchQuery(options);
    expect(queryFn).toHaveBeenCalledTimes(2);
  } finally {
    client.clear();
    now.mockRestore();
  }
});

test("npm resolutions include the CVE-2026-102989 fixes, including every nested copy", () => {
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  const floors: Record<string, number[]> = {
    "@tanstack/react-start": [1, 168, 60],
    "@tanstack/start-server-core": [1, 169, 39],
  };
  for (const [name, floor] of Object.entries(floors)) {
    const versions = Object.entries(lock.packages)
      .filter(([path]) => path.endsWith(`node_modules/${name}`))
      .map(([, entry]) => (entry as { version: string }).version);
    expect(versions.length).toBeGreaterThan(0);
    for (const version of versions) {
      const parts = version.split(".").map(Number);
      const difference = parts.map((part, i) => part - floor[i]!).find((part) => part !== 0) ?? 0;
      expect(difference, `${name}@${version} must include the security fix`).toBeGreaterThanOrEqual(
        0,
      );
    }
  }
});

test("Bun and npm retain the same patched direct dependencies and server core", () => {
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  const npm = JSON.parse(readFileSync("package-lock.json", "utf8"));
  const bun = readFileSync("bun.lock", "utf8");
  for (const name of [
    "@tanstack/react-start",
    "@tanstack/react-router",
    "@tanstack/router-plugin",
    "@tanstack/start-server-core",
  ]) {
    const version = npm.packages[`node_modules/${name}`].version;
    expect(bun).toContain(`"${name}@${version}"`);
    const direct = manifest.dependencies[name] ?? manifest.devDependencies[name];
    if (direct) expect(direct).toBe(version);
  }
});
