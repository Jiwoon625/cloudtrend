import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { OnsetProfileDetails } from "../src/components/OnsetProfileDetails";
import { compactDashboardRow } from "../src/lib/dashboardRow";
import { projectKrDashboard } from "../src/lib/dashboardOperations";
import { runAnalysis } from "../src/lib/engine/pipeline";
import { getMockDataset } from "../src/lib/engine/mockProvider";
import type { RuleRow, ScoreBlock } from "../src/lib/engine/scoring";
import { buildOnsetProfile, type OnsetProfile } from "../src/lib/onsetProfile";
import { buildSnapshot } from "../src/lib/screeningSnapshot";

const defs = [
  ["Vf Trend", "일목 구름 상단 위 (종가 > 선행스팬 상단)", 1],
  ["Vf Momentum", "전환선 > 기준선", 1],
  ["Vf Breakout", "볼린저 상단 돌파", 1.5],
  ["Vf Trend", "이동평균 정배열 (MA20 > MA60 > MA120)", 1],
  ["Vf Volume", "고가 마감 거래량", 0.5],
  ["Vf Leadership", "52주 신고가 근접", 2.5],
  ["Vf Flow", "최근 20거래일 외국인 누적 순매수 > 0", 2],
  ["V8 Sector", "Sector Price Leadership 과열 억제 (PL < 80)", 0.5],
] as const;

function block(points: number[]): ScoreBlock {
  const rows: RuleRow[] = defs.map(([group, rule, maxPoints], index) => ({
    group,
    rule,
    actual: points[index]! > 0 ? "충족" : "미충족",
    threshold: "",
    status: points[index]! > 0 ? "PASS" : "FAIL",
    points: points[index]!,
    maxPoints,
  }));
  return {
    points: points.reduce((sum, value) => sum + value, 0),
    maxPoints: 10,
    availableMaxPoints: 10,
    rows,
  };
}

describe("Onset path display profile", () => {
  it("reproduces the Okins-style 7 to 9 breakout path", () => {
    const profile = buildOnsetProfile(
      block([1, 1, 0, 0, 0, 2.5, 2, 0.5]),
      block([1, 1, 1.5, 0, 0.5, 2.5, 2, 0.5]),
      29.0279745,
      "2026-10-02",
    );
    expect(profile).toMatchObject({
      type: "C",
      label: "돌파형",
      originDate: "2026-10-02",
      addedPoints: 2,
      ma20Extension: 29.0279745,
      addedFeatures: [
        { key: "BB", points: 1.5, category: "breakout" },
        { key: "volume", points: 0.5, category: "breakout" },
      ],
    });
  });

  it("classifies structural-only and mixed paths without changing scores", () => {
    expect(
      buildOnsetProfile(
        block([0, 1, 0, 0, 0, 2.5, 2, 0.5]),
        block([1, 1, 0, 0, 0, 2.5, 2, 0.5]),
        5,
        "2026-01-02",
      )?.label,
    ).toBe("구조개선형");
    expect(
      buildOnsetProfile(
        block([0, 1, 0, 0, 0, 2.5, 2, 0.5]),
        block([1, 1, 1.5, 0, 0, 2.5, 2, 0.5]),
        12,
        "2026-01-02",
      )?.label,
    ).toBe("복합형");
  });

  it("persists and projects display metadata while untouched rows omit it", () => {
    const analysis = runAnalysis(getMockDataset());
    const base = analysis.rows.find(
      (row) => row.instrument.instrumentType === "STOCK" && row.instrument.market === "KOSDAQ",
    )!;
    const profile: OnsetProfile = {
      version: "v8-onset-path-v1",
      type: "C",
      label: "돌파형",
      originDate: analysis.asOfDate,
      addedFeatures: [
        { key: "BB", label: "볼린저 돌파", points: 1.5, category: "breakout" },
        { key: "volume", label: "고가마감·거래량", points: 0.5, category: "breakout" },
      ],
      addedPoints: 2,
      ma20Extension: 29,
    };
    const profiled = {
      ...base,
      kosdaq80Onset: true,
      kospi80Onset: false,
      kospiEightPointEntry: false,
      onsetProfile: profile,
    };
    analysis.rows = [profiled];
    const snapshot = buildSnapshot(analysis);
    expect(snapshot.entries[0]?.onsetProfile).toEqual(profile);
    expect(compactDashboardRow(profiled).onsetProfile).toEqual(profile);
    expect(projectKrDashboard(analysis).rows[0]?.onsetProfile).toEqual(profile);

    const untouched = { ...profiled };
    delete untouched.onsetProfile;
    analysis.rows = [untouched];
    expect(buildSnapshot(analysis).entries[0]).not.toHaveProperty("onsetProfile");
  });

  it("renders type, newly acquired points and MA20 extension together", () => {
    const html = renderToStaticMarkup(
      <OnsetProfileDetails
        profile={{
          version: "v8-onset-path-v1",
          type: "C",
          label: "돌파형",
          originDate: "2026-10-02",
          addedFeatures: [
            { key: "BB", label: "볼린저 돌파", points: 1.5, category: "breakout" },
            { key: "volume", label: "고가마감·거래량", points: 0.5, category: "breakout" },
          ],
          addedPoints: 2,
          ma20Extension: 29.028,
        }}
      />,
    );
    expect(html).toContain("돌파형 (C)");
    expect(html).toContain("볼린저 돌파 +1.5");
    expect(html).toContain("고가마감·거래량 +0.5");
    expect(html).toContain("MA20 이격 +29.0%");
  });
});
