import fs from "node:fs";

function replaceOnce(path, oldText, newText) {
  const text = fs.readFileSync(path, "utf8");
  const parts = text.split(oldText);
  if (parts.length !== 2) {
    throw new Error(`${path}: expected exactly one match, got ${parts.length - 1}`);
  }
  fs.writeFileSync(path, parts[0] + newText + parts[1]);
}

fs.writeFileSync(
  "src/lib/engine/priorityScoreV8.ts",
`import type { RuleRow, ScoreBlock } from "./scoring";

export const PRIORITY_ROTATION_MAX_POINTS = 1 as const;

/**
 * V8 priority score used by dashboard/screener.
 * Foreign 20D flow and 52-week-high proximity are removed here because
 * they already live in the Vf technical score.
 * Sector Rotation Score (0~100) is mapped continuously to 0~1 point.
 */
export function buildPriorityScoreV8(
  legacy: ScoreBlock,
  sectorRotationScore: number | null,
): ScoreBlock {
  const scoredRows = legacy.rows.filter(
    (row) => row.group !== "외국인 수급" && row.group !== "신고가" && row.group !== "참고지표 (점수 미반영)",
  );
  const referenceRows = legacy.rows.filter((row) => row.group === "참고지표 (점수 미반영)");
  const rotation =
    sectorRotationScore === null || !Number.isFinite(sectorRotationScore)
      ? null
      : Math.min(100, Math.max(0, sectorRotationScore));
  const rotationPoints =
    rotation === null
      ? 0
      : Math.round((rotation / 100) * PRIORITY_ROTATION_MAX_POINTS * 100) / 100;
  const rotationRow: RuleRow = {
    group: "섹터 로테이션",
    rule: "섹터 Rotation Score (0~100 비례 반영)",
    actual: rotation === null ? "데이터 없음" : \`${rotation.toFixed(1)}/100\`,
    threshold: \`Rotation 0~100 → 0~${PRIORITY_ROTATION_MAX_POINTS}점\`,
    status: rotation === null ? "NO_DATA" : "PASS",
    points: rotationPoints,
    maxPoints: PRIORITY_ROTATION_MAX_POINTS,
  };
  const rows = [...scoredRows, rotationRow, ...referenceRows];
  const points = Math.round(rows.reduce((sum, row) => sum + row.points, 0) * 100) / 100;
  const maxPoints = Math.round(rows.reduce((sum, row) => sum + row.maxPoints, 0) * 100) / 100;
  const availableMaxPoints =
    Math.round(
      rows.reduce((sum, row) => sum + (row.status === "NO_DATA" ? 0 : row.maxPoints), 0) * 100,
    ) / 100;
  return { points, maxPoints, availableMaxPoints, rows };
}
`,
);

fs.writeFileSync(
  "src/lib/engine/priorityScoreV8.test.ts",
`import { describe, expect, it } from "vitest";
import type { RuleRow, ScoreBlock } from "./scoring";
import { buildPriorityScoreV8 } from "./priorityScoreV8";

const row = (group: string, points: number, maxPoints: number, status: RuleRow["status"] = "PASS"): RuleRow => ({
  group,
  rule: group,
  actual: "test",
  threshold: "test",
  status,
  points,
  maxPoints,
});

function legacyPriority(): ScoreBlock {
  const rows = [
    row("지수 편입", 2, 2),
    row("외국인 수급", 2, 2),
    row("신고가", 2.5, 2.5),
    row("규모", 1, 1),
    row("상대 성과", 1, 1),
    row("참고지표 (점수 미반영)", 0, 0, "FAIL"),
  ];
  return { points: 8.5, maxPoints: 8.5, availableMaxPoints: 8.5, rows };
}

describe("buildPriorityScoreV8", () => {
  it("removes duplicated foreign/high factors and adds continuous rotation for a 5-point score", () => {
    const result = buildPriorityScoreV8(legacyPriority(), 82);
    expect(result.maxPoints).toBe(5);
    expect(result.availableMaxPoints).toBe(5);
    expect(result.points).toBe(4.82);
    expect(result.rows.some((r) => r.group === "외국인 수급")).toBe(false);
    expect(result.rows.some((r) => r.group === "신고가")).toBe(false);
    expect(result.rows.find((r) => r.group === "섹터 로테이션")?.points).toBe(0.82);
  });

  it("keeps the 5-point headline max while excluding missing rotation from available max", () => {
    const result = buildPriorityScoreV8(legacyPriority(), null);
    expect(result.maxPoints).toBe(5);
    expect(result.availableMaxPoints).toBe(4);
    expect(result.points).toBe(4);
    expect(result.rows.find((r) => r.group === "섹터 로테이션")?.status).toBe("NO_DATA");
  });

  it("clamps rotation score to the supported 0~100 range", () => {
    expect(buildPriorityScoreV8(legacyPriority(), 120).points).toBe(5);
    expect(buildPriorityScoreV8(legacyPriority(), -20).points).toBe(4);
  });
});
`,
);

replaceOnce(
  "src/lib/engine/pipeline.ts",
  `import {\n  computeSectorRotation,\n  type SectorRotationResult,\n} from "./sectorRotation";`,
  `import {\n  computeSectorRotation,\n  type SectorRotationResult,\n} from "./sectorRotation";\nimport { buildPriorityScoreV8 } from "./priorityScoreV8";`,
);
replaceOnce(
  "src/lib/engine/pipeline.ts",
  `  const availability = {\n    marketCap: ds.capabilities.marketCap,\n    etfFacts: ds.capabilities.etfFacts,\n  };\n\n  // 거래대금 백분위는 시장/유형별로 따로 계산`,
  `  const availability = {\n    marketCap: ds.capabilities.marketCap,\n    etfFacts: ds.capabilities.etfFacts,\n  };\n\n  // V8 우선점수에서 섹터 로테이션을 0~1점으로 반영한다.\n  // 기존 우선점수의 외국인 수급/52주 신고가는 Vf 기술점수와 중복되므로 후처리에서 제거한다.\n  const sectorRotation = computeSectorRotation(ds, {\n    representativeEtf: buildRepresentativeEtf(ds),\n    weights: cfg.rotation,\n  });\n  const rotationScoreBySector = new Map(\n    (sectorRotation?.sectors ?? []).map((sector) => [sector.sectorCode, sector.rotationScore] as const),\n  );\n\n  // 거래대금 백분위는 시장/유형별로 따로 계산`,
);
replaceOnce(
  "src/lib/engine/pipeline.ts",
  `    const prio = priorityScore(inst, snap, financials, last.marketCap, bench.dayReturn, cfg);`,
  `    const legacyPrio = priorityScore(inst, snap, financials, last.marketCap, bench.dayReturn, cfg);\n    const prio = buildPriorityScoreV8(\n      legacyPrio,\n      rotationScoreBySector.get(inst.sectorCode) ?? null,\n    );`,
);
replaceOnce(
  "src/lib/engine/pipeline.ts",
  `    sectorRotation: computeSectorRotation(ds, {\n      representativeEtf: buildRepresentativeEtf(ds),\n      weights: cfg.rotation,\n    }),`,
  `    sectorRotation,`,
);

replaceOnce(
  "src/routes/scoring.tsx",
  `  DEFAULT_SCORING_CONFIG,\n  priorityMaxPoints,\n  technicalMaxPoints,`,
  `  DEFAULT_SCORING_CONFIG,\n  technicalMaxPoints,`,
);
replaceOnce(
  "src/routes/scoring.tsx",
  `  const prioMax = priorityMaxPoints(draft);`,
  `  const prioMax =\n    draft.priority.indexPoints + draft.priority.sizePoints + draft.priority.relativePoints + 1;`,
);
replaceOnce(
  "src/routes/scoring.tsx",
  `                  label="우선순위(수급·지수·신고가)"`,
  `                  label="우선순위(지수·규모·상대성과·섹터)"`,
);
replaceOnce(
  "src/routes/scoring.tsx",
  `          title={\`3. 보조 우선순위 배점 (Vf 주식점수 미반영 · 현재 만점 ${prioMax}점)\`}\n          desc="지수 편입·규모·당일 상대성과는 진단/ETF용 보조 항목이며 주식 Vf 점수에는 들어가지 않습니다."`,
  `          title={\`3. 우선점수 배점 (기술점수와 분리 · 현재 만점 ${prioMax}점)\`}\n          desc="지수 편입 2점 + 규모 1점 + 당일 상대성과 1점 + 섹터 Rotation Score 1점. 외국인 수급·52주 신고가는 기술점수와 중복되어 우선점수에서 제외합니다."`,
);
replaceOnce(
  "src/routes/scoring.tsx",
  `          <NumField\n            label="규모 배점"`,
  `          <div className="grid grid-cols-[1fr_120px] items-center gap-2 rounded-md border border-border bg-surface p-2">\n            <div>\n              <Label className="text-[12px]">섹터 로테이션 배점</Label>\n              <p className="text-[11px] text-muted-foreground">Rotation Score 0~100을 0~1점으로 선형 환산</p>\n            </div>\n            <div className="text-right text-[12px] font-medium">1점 만점</div>\n          </div>\n          <NumField\n            label="규모 배점"`,
);

replaceOnce(
  "src/components/ScreenerTable.tsx",
  `        \`${r.priority.points}/${r.priority.availableMaxPoints}\`,`,
  `        \`${r.priority.points.toFixed(2)}/${r.priority.maxPoints.toFixed(1)} (산정 가능 ${r.priority.availableMaxPoints.toFixed(1)})\`,`,
);
replaceOnce(
  "src/components/ScreenerTable.tsx",
  `                    {r.priority.points}/{r.priority.availableMaxPoints}\n                  </span>`,
  `                    {formatNumber(r.priority.points, 2)}/{formatNumber(r.priority.maxPoints, 1)}\n                    {r.priority.availableMaxPoints < r.priority.maxPoints ? (\n                      <span className="block text-[10px] text-muted-foreground">\n                        산정 가능 {formatNumber(r.priority.availableMaxPoints, 1)}\n                      </span>\n                    ) : null}\n                  </span>`,
);

console.log("priority score V8 patch applied");
