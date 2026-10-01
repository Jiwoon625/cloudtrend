import { readFileSync } from "node:fs";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { expect, test, vi } from "vitest";

test("portfolio remount reuses session data until explicitly invalidated", async () => {
  const client = new QueryClient();
  const queryFn = vi.fn(async () => ({ version: queryFn.mock.calls.length }));
  const options = {
    queryKey: ["portfolio-ledgers"],
    queryFn,
    staleTime: Infinity,
    gcTime: Infinity,
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

test("both portfolio consumers retain session queries and both change paths invalidate them", () => {
  for (const path of ["src/components/PortfolioAssetHub.tsx", "src/routes/portfolio.tsx"]) {
    const source = readFileSync(path, "utf8");
    expect(source).toContain("staleTime: Infinity");
    expect(source).toContain("gcTime: Infinity");
  }
  for (const path of ["src/routes/index.tsx", "src/routes/scoring.tsx"]) {
    expect(readFileSync(path, "utf8")).toMatch(
      /invalidateQueries\(\{\s*queryKey:\s*\["portfolio-ledgers"\]/,
    );
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
