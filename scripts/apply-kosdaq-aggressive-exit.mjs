import fs from "node:fs";

function replaceOnce(path, oldText, newText) {
  const source = fs.readFileSync(path, "utf8");
  const first = source.indexOf(oldText);
  if (first < 0) throw new Error(`${path}: target text not found`);
  if (source.indexOf(oldText, first + oldText.length) >= 0)
    throw new Error(`${path}: target text matched more than once`);
  fs.writeFileSync(path, source.slice(0, first) + newText + source.slice(first + oldText.length));
}

replaceOnce(
  "src/lib/engine/vfConfig.ts",
  `/** Raw 0~10 operating-score thresholds. */
export const VF_ENTRY_RAW_SCORE = 8;
export const VF_UPSIDE_EXIT_RAW_SCORE = 9.5;
export const VF_DOWNSIDE_EXIT_RAW_SCORE = 2.5;

export const VF_DEFAULT_HORIZON_DAYS = 60;`,
  `/** Raw 0~10 operating-score thresholds. */
export const VF_ENTRY_RAW_SCORE = 8;

/** Legacy V8 exit thresholds retained for non-KOSDAQ/backward-compatible consumers. */
export const VF_UPSIDE_EXIT_RAW_SCORE = 9.5;
export const VF_DOWNSIDE_EXIT_RAW_SCORE = 2.5;

/**
 * KOSDAQ operating exit validated by the 2026-09-17 3-FOS + untouched study.
 * Entry remains the 8.0 onset. The signal is a crossing event, not a persistent state.
 */
export const KOSDAQ_UPSIDE_EXIT_RAW_SCORE = 9;
export const KOSDAQ_DOWNSIDE_EXIT_RAW_SCORE = 3;
export const VF_DEFAULT_HORIZON_DAYS = 60;
export const KOSDAQ_MAX_HOLDING_DAYS = 60;

export type KosdaqOperationalExitSignal = "UP90" | "DOWN30" | null;

export function getKosdaqOperationalExitSignal(
  previousScore: number | null,
  currentScore: number | null,
  entryOnset = false,
): KosdaqOperationalExitSignal {
  if (previousScore === null || currentScore === null || entryOnset) return null;
  if (previousScore < KOSDAQ_UPSIDE_EXIT_RAW_SCORE && currentScore >= KOSDAQ_UPSIDE_EXIT_RAW_SCORE)
    return "UP90";
  if (previousScore > KOSDAQ_DOWNSIDE_EXIT_RAW_SCORE && currentScore <= KOSDAQ_DOWNSIDE_EXIT_RAW_SCORE)
    return "DOWN30";
  return null;
}`,
);

replaceOnce(
  "src/lib/engine/pipeline.ts",
  `import {
  VF_DOWNSIDE_EXIT_RAW_SCORE,
  VF_ENTRY_RAW_SCORE,
  VF_UPSIDE_EXIT_RAW_SCORE,
} from "./vfConfig";`,
  `import {
  getKosdaqOperationalExitSignal,
  VF_DOWNSIDE_EXIT_RAW_SCORE,
  VF_ENTRY_RAW_SCORE,
  VF_UPSIDE_EXIT_RAW_SCORE,
} from "./vfConfig";`,
);
replaceOnce(
  "src/lib/engine/pipeline.ts",
  `export type V8ExitSignal = "UP95" | "DOWN25" | null;`,
  `export type V8ExitSignal = "UP90" | "DOWN30" | "UP95" | "DOWN25" | null;`,
);
replaceOnce(
  "src/lib/engine/pipeline.ts",
  `  if (exitSignal === "UP95") return "V8 Exit · 9.5점 이상";
  if (exitSignal === "DOWN25") return "V8 Exit · 2.5점 이하";`,
  `  if (exitSignal === "UP90") return "KOSDAQ Exit · 9.0점 상향 재돌파";
  if (exitSignal === "DOWN30") return "KOSDAQ Exit · 3.0점 하향 이탈";
  if (exitSignal === "UP95") return "V8 Exit · 9.5점 이상";
  if (exitSignal === "DOWN25") return "V8 Exit · 2.5점 이하";`,
);
replaceOnce(
  "src/lib/engine/pipeline.ts",
  `    const exitSignal: V8ExitSignal =
      operatingScore10 === null
        ? null
        : operatingScore10 >= VF_UPSIDE_EXIT_RAW_SCORE
          ? "UP95"
          : operatingScore10 <= VF_DOWNSIDE_EXIT_RAW_SCORE
            ? "DOWN25"
            : null;`,
  `    const exitSignal: V8ExitSignal =
      inst.market === "KOSDAQ"
        ? getKosdaqOperationalExitSignal(
            previousOperatingScore10,
            operatingScore10,
            kosdaq80Onset,
          )
        : operatingScore10 === null
          ? null
          : operatingScore10 >= VF_UPSIDE_EXIT_RAW_SCORE
            ? "UP95"
            : operatingScore10 <= VF_DOWNSIDE_EXIT_RAW_SCORE
              ? "DOWN25"
              : null;`,
);

replaceOnce(
  "src/lib/statusDisplay.ts",
  `  if (row.exitSignal === "UP95") return "V8 Exit · 9.5점 이상";
  if (row.exitSignal === "DOWN25") return "V8 Exit · 2.5점 이하";`,
  `  if (row.exitSignal === "UP90") return "KOSDAQ Exit · 9.0점 상향 재돌파";
  if (row.exitSignal === "DOWN30") return "KOSDAQ Exit · 3.0점 하향 이탈";
  if (row.exitSignal === "UP95") return "V8 Exit · 9.5점 이상";
  if (row.exitSignal === "DOWN25") return "V8 Exit · 2.5점 이하";`,
);

replaceOnce(
  "src/lib/screeningCache.ts",
  `export const SCREENING_CACHE_VERSION = "screening-cache-v8-final-v3" as const;
export const DASHBOARD_CACHE_VERSION = "dashboard-cache-v8-final-v4" as const;
export const INSTRUMENT_CACHE_VERSION = "instrument-cache-v8-final-v3" as const;`,
  `export const SCREENING_CACHE_VERSION = "screening-cache-v8-final-v4" as const;
export const DASHBOARD_CACHE_VERSION = "dashboard-cache-v8-final-v5" as const;
export const INSTRUMENT_CACHE_VERSION = "instrument-cache-v8-final-v4" as const;`,
);
replaceOnce(
  "src/lib/screeningCache.ts",
  `      upsideExits: rows.filter(
        (row) => row.instrument.market === "KOSDAQ" && row.exitSignal === "UP95",
      ).length,
      downsideExits: rows.filter(
        (row) => row.instrument.market === "KOSDAQ" && row.exitSignal === "DOWN25",
      ).length,`,
  `      upsideExits: rows.filter(
        (row) => row.instrument.market === "KOSDAQ" && row.exitSignal === "UP90",
      ).length,
      downsideExits: rows.filter(
        (row) => row.instrument.market === "KOSDAQ" && row.exitSignal === "DOWN30",
      ).length,`,
);

replaceOnce(
  "src/routes/index.tsx",
  `          "CloudTrend V8 Final 10점 기술점수의 KOSDAQ80 Onset, KOSPI 8점 Onset과 RSAccel Relative Quality, 9.5·2.5 Exit, 섹터 로테이션과 시장 상태를 한 화면에서 확인합니다.",`,
  `          "CloudTrend V8 Final 10점 기술점수의 KOSDAQ80 Onset, KOSPI 8점 Onset과 RSAccel Relative Quality, KOSDAQ 9.0 상향·3.0 하향 Exit, 섹터 로테이션과 시장 상태를 한 화면에서 확인합니다.",`,
);
replaceOnce(
  "src/routes/index.tsx",
  `          <KeyValue label="상승 Exit · 9.5점 이상" value={formatCount(counts.upsideExits)} />
          <KeyValue label="하락 Exit · 2.5점 이하" value={formatCount(counts.downsideExits)} />`,
  `          <KeyValue label="상승 Exit · 9.0점 상향 재돌파" value={formatCount(counts.upsideExits)} />
          <KeyValue label="하락 Exit · 3.0점 하향 이탈" value={formatCount(counts.downsideExits)} />`,
);
replaceOnce(
  "src/routes/index.tsx",
  `          <KeyValue label="상승 Exit" value="점수 ≥ 9.5" />
          <KeyValue label="하락 Exit" value="점수 ≤ 2.5" />
          <KeyValue label="기술점수" value="Raw 0~10" />
          <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
            RSAccel은 KOSPI 전용 Relative Quality 축이며 기술점수나 우선점수에 합산하지 않습니다.
          </p>`,
  `          <KeyValue label="상승 Exit" value="9.0 상향 재돌파" />
          <KeyValue label="하락 Exit" value="3.0 하향 이탈" />
          <KeyValue label="최대 보유" value="60거래일" />
          <KeyValue label="기술점수" value="Raw 0~10" />
          <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
            KOSDAQ Exit는 8.0 Onset 당일의 9.0 초과 진입을 즉시 청산으로 보지 않고, 이후 재돌파·하향 이탈을 신호로 봅니다. 60거래일 만기는 포지션 추적 기능 연결 전까지 화면 자동 신호로 표시하지 않습니다. RSAccel은 KOSPI 전용 Relative Quality 축입니다.
          </p>`,
);
replaceOnce(
  "src/routes/index.tsx",
  `            ≥9.5 또는 ≤2.5`,
  `            9.0 상향 재돌파 또는 3.0 하향 이탈`,
);
replaceOnce(
  "src/routes/index.tsx",
  `            실제 매도 대상 여부는 보유 여부와 함께 확인해야 합니다.`,
  `            실제 매도 대상 여부는 보유 여부와 함께 확인해야 하며, 최대 보유 60거래일은 별도 포지션 관리 기준입니다.`,
);

replaceOnce(
  "src/lib/statusDisplay.test.ts",
  `  it("keeps the official KOSDAQ onset label unchanged", () => {
    expect(
      getDisplayStatus(
        row({
          instrument: instrument("KOSDAQ"),
          kosdaq80Onset: true,
          rs20: 6,
          rs60: 2,
        }),
      ),
    ).toBe("KOSDAQ80 Onset");
  });`,
  `  it("keeps the official KOSDAQ onset label unchanged", () => {
    expect(
      getDisplayStatus(
        row({
          instrument: instrument("KOSDAQ"),
          kosdaq80Onset: true,
          rs20: 6,
          rs60: 2,
        }),
      ),
    ).toBe("KOSDAQ80 Onset");
  });

  it("shows the validated KOSDAQ aggressive exit labels", () => {
    expect(
      getDisplayStatus(row({ instrument: instrument("KOSDAQ"), exitSignal: "UP90" })),
    ).toBe("KOSDAQ Exit · 9.0점 상향 재돌파");
    expect(
      getDisplayStatus(row({ instrument: instrument("KOSDAQ"), exitSignal: "DOWN30" })),
    ).toBe("KOSDAQ Exit · 3.0점 하향 이탈");
  });`,
);

fs.writeFileSync(
  "src/lib/engine/vfConfig.test.ts",
  `import { describe, expect, it } from "vitest";\n\nimport {\n  getKosdaqOperationalExitSignal,\n  KOSDAQ_MAX_HOLDING_DAYS,\n} from "./vfConfig";\n\ndescribe("KOSDAQ aggressive operating exit", () => {\n  it("suppresses a same-day 8.0 onset overshoot", () => {\n    expect(getKosdaqOperationalExitSignal(7.5, 9, true)).toBeNull();\n  });\n\n  it("fires only on a fresh 9.0 upward recross", () => {\n    expect(getKosdaqOperationalExitSignal(8.5, 9, false)).toBe("UP90");\n    expect(getKosdaqOperationalExitSignal(9.5, 9.5, false)).toBeNull();\n  });\n\n  it("fires only on a fresh 3.0 downward cross", () => {\n    expect(getKosdaqOperationalExitSignal(3.5, 3, false)).toBe("DOWN30");\n    expect(getKosdaqOperationalExitSignal(2.5, 2.5, false)).toBeNull();\n  });\n\n  it("keeps the validated maximum holding period at 60 trading days", () => {\n    expect(KOSDAQ_MAX_HOLDING_DAYS).toBe(60);\n  });\n});\n`,
);

console.log("Applied KOSDAQ aggressive exit signal patch.");
