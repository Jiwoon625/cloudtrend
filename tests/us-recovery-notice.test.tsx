import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { UsRecoveryNotice } from "../src/components/UsRecoveryNotice";
import { Route } from "../src/routes/us.screener";
import type { UsProspectiveCache } from "../src/lib/usProspectiveCloud";

const state = vi.hoisted(() => ({ data: undefined as UsProspectiveCache | undefined }));

vi.mock("@/components/AppShell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));
vi.mock("@/lib/usProspectiveCloud", () => ({ loadUsProspectiveCache: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: state.data, isError: false }),
}));

function marker(sourceKind = "DATED_ROSTER_RECONSTRUCTION") {
  return {
    version: "us-recovery-publication-v1",
    sourceKind,
    manifestHash: "private-manifest-hash",
    operatingPlanHash: "private-operating-plan-hash",
    originalDataHash: "private-original-data-hash",
    originalResultHash: "private-original-result-hash",
  };
}

function notice(metadata: unknown) {
  return renderToStaticMarkup(<UsRecoveryNotice metadata={metadata} />);
}

function cache(metadata: Record<string, unknown>): UsProspectiveCache {
  return {
    generatedAt: "2026-10-08T00:00:00Z",
    dataHash: "fixture-hash",
    source: {
      provider: "Synthetic test fixture",
      collectedAt: "2026-10-08T00:00:00Z",
      schemaVersion: "1",
      metadata,
    },
    analysis: { date: "2026-10-07", ruleVersion: "test-v1", summary: {}, rows: [] },
  };
}

beforeEach(() => {
  state.data = undefined;
});

describe("US recovery notice", () => {
  it.each([
    undefined,
    null,
    false,
    "recovery",
    [],
    {},
    { sourceCoverageComplete: false, quarantinedSymbols: ["PRIVATE_SYMBOL"] },
    { recoveryPublication: null },
    { recoveryPublication: [] },
    { recoveryPublication: "us-recovery-publication-v1" },
    { recoveryPublication: { version: "us-recovery-publication-v1" } },
    { recoveryPublication: { ...marker(), version: "future-version" } },
    { recoveryPublication: { ...marker(), sourceKind: "unknown" } },
    { recoveryPublication: { ...marker(), manifestHash: " " } },
    { recoveryPublication: { ...marker(), operatingPlanHash: null } },
    { recoveryPublication: { ...marker(), originalDataHash: undefined } },
    { recoveryPublication: { ...marker(), originalResultHash: 123 } },
  ])("does not render for normal or malformed metadata: %j", (metadata) => {
    expect(notice(metadata)).toBe("");
  });

  it.each(["DATED_ROSTER_RECONSTRUCTION", "REVIEWED_ATOMIC_QUARANTINE"])(
    "identifies %s as review reconstruction and discloses incomplete coverage",
    (sourceKind) => {
      const html = notice({
        recoveryPublication: marker(sourceKind),
        sourceCoverageComplete: false,
      });
      expect(html).toContain("검토용 재구성 자료를 날짜순으로 이어 계산한 결과입니다.");
      expect(html).toContain("일부 종목은 제외됐으며 원래 게시 결과는 보존됩니다.");
      expect(html).toContain('role="note"');
      expect(html).not.toContain("전체 종목");
    },
  );

  it("shows the exclusion caveat for quarantined symbols without exposing metadata", () => {
    const html = notice({
      recoveryPublication: marker(),
      sourceCoverageComplete: true,
      quarantinedSymbols: ["PRIVATE_SYMBOL"],
      sourcePath: "/private/source/path",
      holdings: { PRIVATE_HOLDING: 100 },
    });
    expect(html).toContain("일부 종목은 제외됐으며 원래 게시 결과는 보존됩니다.");
    expect(html).not.toMatch(/private-|PRIVATE_|\/private\/|manifestHash|operatingPlanHash/);
  });

  it("uses atomic recovery wording without claiming complete coverage", () => {
    const html = notice({
      recoveryPublication: marker("ATOMIC_DATED_SNAPSHOT"),
      sourceCoverageComplete: true,
      quarantinedSymbols: [],
    });
    expect(html).toContain("날짜순으로 이어 계산한 복구 결과입니다.");
    expect(html).not.toContain("재구성");
    expect(html).not.toContain("일부 종목은 제외");
    expect(html).not.toContain("전체");
  });

  it("also discloses exclusions for an incomplete atomic recovery", () => {
    const html = notice({
      recoveryPublication: marker("ATOMIC_DATED_SNAPSHOT"),
      sourceCoverageComplete: false,
    });
    expect(html).toContain("날짜순으로 이어 계산한 복구 결과입니다.");
    expect(html).toContain("일부 종목은 제외됐으며 원래 게시 결과는 보존됩니다.");
  });

  it("is deterministic and leaves frozen recovery metadata unchanged", () => {
    const metadata = Object.freeze({
      recoveryPublication: Object.freeze(marker()),
      sourceCoverageComplete: false,
      quarantinedSymbols: Object.freeze(["PRIVATE_SYMBOL"]),
    });
    const before = JSON.stringify(metadata);
    expect(notice(metadata)).toBe(notice(metadata));
    expect(JSON.stringify(metadata)).toBe(before);
  });
});

describe("US screener recovery notice integration", () => {
  const Screener = Route.options.component as React.ComponentType;

  it("places the notice immediately below the dated header and above the existing funnel", () => {
    state.data = cache({ recoveryPublication: marker(), sourceCoverageComplete: false });
    const html = renderToStaticMarkup(<Screener />);
    const headerEnd = html.indexOf("</header>");
    const noticeStart = html.indexOf('<p role="note"');
    expect(html).toContain("기준일 2026-10-07");
    expect(noticeStart).toBe(headerEnd + "</header>".length);
    expect(noticeStart).toBeLessThan(html.indexOf("신규 진입 Funnel"));
    expect(html).not.toContain("private-");
  });

  it("leaves the normal screener and unloaded state without a recovery notice", () => {
    expect(renderToStaticMarkup(<Screener />)).not.toContain('role="note"');
    state.data = cache({});
    const html = renderToStaticMarkup(<Screener />);
    expect(html).not.toContain('role="note"');
    expect(html).toContain("신규 진입 Funnel");
    expect(html).toContain("기준일 2026-10-07");
  });
});
