import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const write = (p, s) => fs.writeFileSync(path.join(root, p), s);

function replaceExact(file, source, needle, replacement, label = needle.slice(0, 60)) {
  if (!source.includes(needle)) {
    throw new Error(`${file}: replacement target not found: ${label}`);
  }
  return source.replace(needle, replacement);
}

function replaceRegex(file, source, re, replacement, label) {
  if (!re.test(source)) throw new Error(`${file}: regex target not found: ${label}`);
  re.lastIndex = 0;
  return source.replace(re, replacement);
}

// ---------------------------------------------------------------------------
// 1) Single source of truth for the finalized Vf model.
// ---------------------------------------------------------------------------
const vfConfigPath = "src/lib/engine/vfConfig.ts";
write(
  vfConfigPath,
  `/** CloudTrend Vf — 2026-09-09 validation-finalized defaults. */\nexport const VF_MODEL_VERSION = 5;\nexport const VF_MODEL_LABEL = "Vf";\n\nexport const VF_FEATURE_WEIGHTS = {\n  ICH_ABOVE_CLOUD: 1,\n  ICH_TENKAN_KIJUN: 1,\n  BB_BREAKOUT: 1.5,\n  MA_ALIGNED: 1,\n  VOLUME_SURGE: 0.5,\n  NEAR_52W_HIGH: 2.5,\n  FOREIGN_NET_POSITIVE: 2,\n} as const;\n\nexport const VF_FEATURE_WEIGHT_TOTAL = Object.values(VF_FEATURE_WEIGHTS).reduce(\n  (sum, value) => sum + value,\n  0,\n);\n\nexport const VF_DEFAULT_HORIZON_DAYS = 30;\nexport const VF_DEFAULT_ENTRY_SCORE = 60;\n`,
);

// ---------------------------------------------------------------------------
// 2) Backtest defaults: exact same seven weights as the stock screener.
// ---------------------------------------------------------------------------
{
  const file = "src/lib/engine/backtest.ts";
  let s = read(file);
  s = replaceExact(
    file,
    s,
    'import { computeIndicators, periodReturn, type IndicatorSnapshot } from "./indicators";',
    'import { computeIndicators, periodReturn, type IndicatorSnapshot } from "./indicators";\nimport { VF_FEATURE_WEIGHTS } from "./vfConfig";',
    "vfConfig import",
  );

  const weights = {
    ICH_ABOVE_CLOUD: "VF_FEATURE_WEIGHTS.ICH_ABOVE_CLOUD",
    ICH_TENKAN_KIJUN: "VF_FEATURE_WEIGHTS.ICH_TENKAN_KIJUN",
    BB_BREAKOUT: "VF_FEATURE_WEIGHTS.BB_BREAKOUT",
    MA_ALIGNED: "VF_FEATURE_WEIGHTS.MA_ALIGNED",
    MA20_SLOPE_UP: "0",
    VOLUME_SURGE: "VF_FEATURE_WEIGHTS.VOLUME_SURGE",
    NEAR_52W_HIGH: "VF_FEATURE_WEIGHTS.NEAR_52W_HIGH",
    RS_POSITIVE: "0",
    FOREIGN_NET_POSITIVE: "VF_FEATURE_WEIGHTS.FOREIGN_NET_POSITIVE",
  };
  for (const [id, expr] of Object.entries(weights)) {
    const re = new RegExp(`(id: "${id}"[\\s\\S]*?defaultWeight:)\\s*[-\\d.]+,`);
    s = replaceRegex(file, s, re, `$1 ${expr},`, `defaultWeight ${id}`);
  }
  s = s.replace("Momentum Confirmation ① (Primary) — 1.5점 ÷ 3", "Momentum Confirmation — Vf 1.0점");
  s = s.replace("52주 최고가 대비 -10% 이내 (Priority 2점)", "52주 최고가 대비 -10% 이내 (Vf 2.5점)");
  s = s.replace("최근 20거래일 외국인 누적 순매수가 양수 (Priority 2점)", "최근 20거래일 외국인 누적 순매수가 양수 (Vf 2.0점)");
  write(file, s);
}

// ---------------------------------------------------------------------------
// 3) Scoring engine: finalized defaults + exact seven-feature stock Vf score.
// ---------------------------------------------------------------------------
{
  const file = "src/lib/engine/scoring.ts";
  let s = read(file);
  s = replaceExact(
    file,
    s,
    'import { DEFAULT_ROTATION_WEIGHTS, type RotationWeights } from "./sectorRotation";',
    'import { DEFAULT_ROTATION_WEIGHTS, type RotationWeights } from "./sectorRotation";\nimport { VF_FEATURE_WEIGHTS, VF_MODEL_VERSION } from "./vfConfig";',
    "vfConfig import",
  );
  s = replaceExact(file, s, 'export const STRATEGY_VERSION = "1.0.1";', 'export const STRATEGY_VERSION = "Vf";', "strategy version");

  const vfFunction = `\n/**\n * CloudTrend Vf stock score.\n * This is intentionally identical to the V5 backtest composite-score definition:\n * seven binary/state features, weighted sum, and missing-aware denominator.\n * MA20 slope and positive 20D return remain diagnostics only and never score.\n */\nexport function vfStockScore(\n  snap: IndicatorSnapshot,\n  cfg: ScoringConfig = DEFAULT_SCORING_CONFIG,\n): ScoreBlock {\n  const rows: RuleRow[] = [];\n  const t = cfg.technical;\n  const p = cfg.priority;\n  const flags = technicalFlagsV3(snap, cfg);\n\n  const add = (\n    group: string,\n    rule: string,\n    actual: string,\n    flag: boolean | null,\n    maxPoints: number,\n  ) =>\n    rows.push({\n      group,\n      rule,\n      actual,\n      threshold: \\`충족 시 +\\${maxPoints}\\`,\n      status: flag === null ? "NO_DATA" : flag ? "PASS" : "FAIL",\n      points: flag === true ? maxPoints : 0,\n      maxPoints,\n    });\n\n  add(\n    "Vf Trend",\n    "일목 구름 상단 위",\n    flags.cloudAbove === null\n      ? "데이터 없음"\n      : flags.cloudAbove\n        ? \\`종가 \\${fmtNum(snap.close)} > 구름 상단 \\${fmtNum(snap.ichimoku.cloudTop)}\\`\n        : "미충족",\n    flags.cloudAbove,\n    t.cloudAboveMax,\n  );\n  add(\n    "Vf Momentum",\n    "전환선 > 기준선",\n    flags.tenkanAboveKijun === null ? "데이터 없음" : flags.tenkanAboveKijun ? "충족" : "미충족",\n    flags.tenkanAboveKijun,\n    t.momentumMax,\n  );\n  add(\n    "Vf Breakout",\n    "볼린저 상단 돌파 (Head Fake 시 미충족)",\n    flags.bbBreakout === null ? "데이터 없음" : flags.bbBreakout ? "상단 돌파" : "미돌파",\n    flags.bbBreakout,\n    t.breakoutMax,\n  );\n  add(\n    "Vf Trend",\n    "이동평균 정배열 (MA20 > MA60 > MA120)",\n    flags.maAligned === null ? "데이터 없음" : flags.maAligned ? "정배열" : "미충족",\n    flags.maAligned,\n    t.maAlignedMax,\n  );\n  add(\n    "Vf Volume",\n    \\`고가 마감 거래량 (거래량 ≥ \\${t.volumeStrongRatio}% AND CLV ≥ \\${t.clvThreshold})\\`,\n    flags.highCloseVolume === null\n      ? "데이터 없음"\n      : \\`거래량 \\${snap.volumeRatio20!.toFixed(0)}% / CLV \\${snap.closeLocationValue!.toFixed(2)}\\`,\n    flags.highCloseVolume,\n    t.volumeMax,\n  );\n\n  const nearHigh =\n    snap.distanceFrom52wHigh === null\n      ? null\n      : snap.distanceFrom52wHigh >= p.nearHighThresholdPercent;\n  add(\n    "Vf Leadership",\n    \\`52주 신고가 대비 \\${Math.abs(p.nearHighThresholdPercent)}% 이내\\`,\n    snap.distanceFrom52wHigh === null ? "데이터 없음" : fmtPct(snap.distanceFrom52wHigh),\n    nearHigh,\n    p.nearHighPoints,\n  );\n\n  const foreignPositive = snap.foreignNet20d === null ? null : snap.foreignNet20d > 0;\n  add(\n    "Vf Flow",\n    "최근 20거래일 외국인 누적 순매수 > 0",\n    snap.foreignNet20d === null\n      ? "데이터 없음"\n      : \\`\\${(snap.foreignNet20d / 100_000_000).toFixed(1)}억 원\\`,\n    foreignPositive,\n    p.foreignPoints,\n  );\n\n  const points = Math.round(rows.reduce((sum, row) => sum + row.points, 0) * 100) / 100;\n  const maxPoints = Math.round(rows.reduce((sum, row) => sum + row.maxPoints, 0) * 100) / 100;\n  const availableMaxPoints =\n    Math.round(\n      rows.reduce((sum, row) => sum + (row.status === "NO_DATA" ? 0 : row.maxPoints), 0) * 100,\n    ) / 100;\n  return { points, maxPoints, availableMaxPoints, rows };\n}\n\n/** Vf score grade: 80+ A, 60+ B, otherwise C. */\nexport function vfGrade(score: number | null): TechnicalGrade {\n  if (score !== null && score >= 80) return "A";\n  if (score !== null && score >= 60) return "B";\n  return "C";\n}\n\n`;
  s = replaceExact(file, s, "\nexport type TechnicalGrade = \"A\" | \"B\" | \"C\";", `${vfFunction}export type TechnicalGrade = "A" | "B" | "C";`, "insert Vf score");

  s = replaceExact(
    file,
    s,
    `export const STOCK_WEIGHTS: Weights = {\n  technical: 0.45,\n  priority: 0.2,\n  fundamental: 0.25,\n  marketSector: 0.1,\n};`,
    `export const STOCK_WEIGHTS: Weights = {\n  // Vf stock ranking bypasses the legacy block-composite path; keep this explicit for UI/config clarity.\n  technical: 1,\n  priority: 0,\n  fundamental: 0,\n  marketSector: 0,\n};`,
    "stock legacy weights",
  );
  s = replaceExact(file, s, "export const SCORING_CONFIG_VERSION = 4;", "export const SCORING_CONFIG_VERSION = VF_MODEL_VERSION;", "config version");

  const defaultReplacements = [
    ["cloudAboveMax: 2,", "cloudAboveMax: VF_FEATURE_WEIGHTS.ICH_ABOVE_CLOUD,"],
    ["maAlignedMax: 2,", "maAlignedMax: VF_FEATURE_WEIGHTS.MA_ALIGNED,"],
    ["momentumMax: 1.5,", "momentumMax: VF_FEATURE_WEIGHTS.ICH_TENKAN_KIJUN,"],
    ["breakoutMax: 1,", "breakoutMax: VF_FEATURE_WEIGHTS.BB_BREAKOUT,"],
    ["volumeMax: 0.5,", "volumeMax: VF_FEATURE_WEIGHTS.VOLUME_SURGE,"],
    ["foreignPoints: 2,", "foreignPoints: VF_FEATURE_WEIGHTS.FOREIGN_NET_POSITIVE,"],
    ["nearHighPoints: 2,", "nearHighPoints: VF_FEATURE_WEIGHTS.NEAR_52W_HIGH,"],
    ["grade: { aMin: 6, bMin: 4 },", "grade: { aMin: 4, bMin: 3 },"],
  ];
  for (const [a, b] of defaultReplacements) s = replaceExact(file, s, a, b, `default ${a}`);
  s = s.replace("/** 현재 scoring 모델 버전 (V4) */", "/** 현재 scoring 모델 버전 (Vf) */");
  s = s.replace("/** 저장된 설정의 모델 버전. 현재 V4 = 4 */", "/** 저장된 설정의 모델 버전. 현재 Vf = 5 */");
  write(file, s);
}

// ---------------------------------------------------------------------------
// 4) Pipeline: stocks use the exact Vf score; ETFs keep the legacy composite.
// ---------------------------------------------------------------------------
{
  const file = "src/lib/engine/pipeline.ts";
  let s = read(file);
  s = replaceExact(file, s, "  totalScore,\n  type MarketGate,", "  totalScore,\n  vfGrade,\n  vfStockScore,\n  type MarketGate,", "scoring imports");
  s = replaceExact(file, s, "  priority: ScoreBlock;\n  quality: ScoreBlock;", "  priority: ScoreBlock;\n  /** Finalized seven-feature Vf score (stocks only). */\n  vf: ScoreBlock | null;\n  quality: ScoreBlock;", "ScreeningRow vf field");
  s = replaceExact(
    file,
    s,
    "    const tech = technicalScore(snap, valuePct, cfg);\n    const prio = priorityScore(inst, snap, financials, last.marketCap, bench.dayReturn, cfg);\n    const quality =",
    "    const tech = technicalScore(snap, valuePct, cfg);\n    const prio = priorityScore(inst, snap, financials, last.marketCap, bench.dayReturn, cfg);\n    const vf = inst.instrumentType === \"STOCK\" ? vfStockScore(snap, cfg) : null;\n    const vfNormalized = vf ? normalize(vf) : null;\n    const modelGrade =\n      inst.instrumentType === \"STOCK\" ? vfGrade(vfNormalized) : technicalGrade(tech.points, cfg);\n    const quality =",
    "build vf score",
  );
  s = replaceExact(file, s, "      priority: prio,\n      quality,", "      priority: prio,\n      vf,\n      quality,", "return vf");
  s = replaceExact(
    file,
    s,
    "      totalScoreNormalized: 0,\n      dataCompletenessRatio: 0,\n      grade: technicalGrade(tech.points, cfg),\n      actionLabelText: actionLabel(technicalGrade(tech.points, cfg), gate.status),",
    "      totalScoreNormalized: inst.instrumentType === \"STOCK\" ? (vfNormalized ?? 0) : 0,\n      dataCompletenessRatio:\n        inst.instrumentType === \"STOCK\" && vf && vf.maxPoints > 0\n          ? vf.availableMaxPoints / vf.maxPoints\n          : 0,\n      grade: modelGrade,\n      actionLabelText: actionLabel(modelGrade, gate.status),",
    "initial stock model score",
  );

  s = replaceExact(
    file,
    s,
    `    const weights =\n      row.instrument.instrumentType === "STOCK" ? cfg.weights.stock : cfg.weights.etf;\n    const { total, dataCompletenessRatio } = totalScore({\n      technicalNormalized: row.technicalNormalized,\n      priorityNormalized: row.priorityNormalized,\n      qualityScore: row.qualityScore,\n      marketSectorScore: row.marketSectorScore,\n      weights,\n    });\n    row.totalScoreNormalized = total;\n    row.dataCompletenessRatio = dataCompletenessRatio;`,
    `    let dataCompletenessRatio: number;\n    if (row.instrument.instrumentType === "STOCK" && row.vf) {\n      row.totalScoreNormalized = normalize(row.vf) ?? 0;\n      dataCompletenessRatio =\n        row.vf.maxPoints > 0 ? row.vf.availableMaxPoints / row.vf.maxPoints : 0;\n    } else {\n      const { total, dataCompletenessRatio: legacyCompleteness } = totalScore({\n        technicalNormalized: row.technicalNormalized,\n        priorityNormalized: row.priorityNormalized,\n        qualityScore: row.qualityScore,\n        marketSectorScore: row.marketSectorScore,\n        weights: cfg.weights.etf,\n      });\n      row.totalScoreNormalized = total;\n      dataCompletenessRatio = legacyCompleteness;\n    }\n    row.dataCompletenessRatio = dataCompletenessRatio;`,
    "final score loop",
  );
  write(file, s);
}

// ---------------------------------------------------------------------------
// 5) Browser config migration: force old V4 overrides to the finalized Vf defaults.
// ---------------------------------------------------------------------------
{
  const file = "src/lib/scoringConfigStore.ts";
  let s = read(file);
  s = replaceExact(file, s, 'const KEY = "cloudtrend.scoringConfig.v4";', 'const KEY = "cloudtrend.scoringConfig.v5";', "storage key");
  s = replaceExact(
    file,
    s,
    'const LEGACY_KEYS = ["cloudtrend.scoringConfig.v3", "trendscore.scoringConfig.v2"];',
    'const LEGACY_KEYS = [\n  "cloudtrend.scoringConfig.v4",\n  "cloudtrend.scoringConfig.v3",\n  "trendscore.scoringConfig.v2",\n];',
    "legacy keys",
  );
  s = s.replaceAll("V4 기본값", "Vf 기본값");
  s = s.replaceAll("V3 이하", "V4 이하");
  s = s.replace("configVersion < 현재 버전이면 mergeScoringConfig가 Vf 기본값을 반환한다.", "configVersion < 현재 버전이면 mergeScoringConfig가 Vf 기본값을 반환한다.");
  write(file, s);
}

// ---------------------------------------------------------------------------
// 6) Data / formula tab: explain and edit the exact Vf stock formula.
// ---------------------------------------------------------------------------
{
  const file = "src/routes/scoring.tsx";
  let s = read(file);
  s = s.replaceAll("restoreV4Defaults", "restoreVfDefaults");
  s = s.replaceAll("V4 기본값", "Vf 기본값");
  s = replaceExact(file, s, "  const prioMax = priorityMaxPoints(draft);", "  const prioMax = priorityMaxPoints(draft);\n  const vfMax = techMax + draft.priority.nearHighPoints + draft.priority.foreignPoints;", "vfMax");
  s = replaceExact(
    file,
    s,
    "          시세 데이터를 입력해 스크리닝을 시작하고, 아래 산식·가중치로 주식·ETF 스크리너와 종목\n          상세의 점수를 조정합니다.",
    "          시세 데이터를 입력해 스크리닝을 시작합니다. 주식은 검증 완료된 CloudTrend Vf 7개 피처\n          점수를 사용하고, ETF는 별도 기존 종합점수 구조를 유지합니다.",
    "page description",
  );
  s = replaceRegex(
    file,
    s,
    /\{`기술점수\(%\) = 획득 \/ 산정가능 만점 × 100[\s\S]*?종합점수 = Σ\(항목% × 가중치\) \/ Σ\(데이터가 있는 항목의 가중치\)`\}/,
    `{\`주식 CloudTrend Vf 점수 = Σ(충족한 피처 가중치) / Σ(산정 가능한 7개 피처 가중치) × 100\n기본 원점수 만점 = \\${vfMax}점\n\n피처 = 일목 구름 상단 위 + 전환선>기준선 + 볼린저 상단 돌파 + 이동평균 정배열\n      + 고가마감 거래량 + 52주 신고가 근접 + 외국인 20일 순매수\n\n데이터가 없는 피처는 0점 처리하지 않고 분모에서도 제외합니다.\nMA20 상승·20일 수익률 양수·펀더멘털·시장/섹터·지수편입·규모·당일 상대수익은 주식 Vf 점수에 미반영됩니다.\n\nETF 종합점수 = Σ(항목% × ETF 가중치) / Σ(데이터가 있는 항목의 가중치)\`}`,
    "formula block",
  );
  s = replaceExact(
    file,
    s,
    "          데이터가 없는 항목(예: 토스 API 미제공 재무)은 0점이 아니라 분모에서 제외됩니다. 따라서\n          가중치 합이 1이 아니어도 결과는 정규화됩니다.",
    "          주식 Vf는 백테스트와 동일하게 피처별 NO_DATA를 분모에서 제외합니다. 52주 신고가 피처는\n          정확히 252거래일이 확보된 시점부터만 계산됩니다.",
    "formula note",
  );
  s = replaceExact(file, s, 'title="1. 종합점수 가중치"', 'title="1. ETF 종합점수 가중치"', "section 1 title");
  s = replaceExact(
    file,
    s,
    'desc="주식과 ETF에 각각 다른 가중치를 적용합니다. 합계가 1이 아니어도 자동 정규화됩니다."',
    'desc="주식 Vf는 아래 7개 피처 고정 구조를 사용합니다. 이 블록 가중치는 ETF에만 적용됩니다."',
    "section 1 desc",
  );
  s = replaceExact(
    file,
    s,
    '{(["stock", "etf"] as const).map((k) => (',
    '<p className="rounded-md border border-border bg-surface p-2 text-[11px] text-muted-foreground">주식 점수는 블록 가중치가 아니라 Vf 7개 피처의 원점수 가중치를 직접 정규화합니다.</p>\n          {(["stock", "etf"] as Array<"stock" | "etf">).filter((k) => k === "etf").map((k) => (',
    "ETF-only block weights",
  );
  s = replaceRegex(file, s, /title=\{`2\. 기술 신호 배점 — V4 \(현재 만점 \$\{techMax\}점\)`\}/, 'title={`2. CloudTrend Vf 7개 피처 배점 — 현재 만점 ${vfMax}점`}', "section 2 title");
  s = replaceExact(
    file,
    s,
    'desc="Trend Core 4.0 + 전환선>기준선 1.5 + Breakout 1.0 + Volume 0.5. MA20 상승과 20일 수익률 양수는 피처에서 제거했습니다."',
    'desc="백테스트와 종목스크리너가 같은 7개 상태 피처와 같은 가중치를 사용합니다. 기본 만점은 9.5점입니다."',
    "section 2 desc",
  );
  const insertAfterVolume = `          <NumField\n            label="5. 고가마감 거래량"\n            hint="거래량 비율 기준 AND CLV = (종가-저가)/(고가-저가) 기준 동시 충족"\n            value={draft.technical.volumeMax}\n            step={0.5}\n            suffix="점"\n            onChange={(v) => patch((d) => void (d.technical.volumeMax = v))}\n          />`;
  const vfExtraFields = `${insertAfterVolume}\n          <NumField\n            label="6. 52주 신고가 근접"\n            hint="정확히 252거래일 기준 최고가 대비 허용 낙폭 이내"\n            value={draft.priority.nearHighPoints}\n            step={0.5}\n            suffix="점"\n            onChange={(v) => patch((d) => void (d.priority.nearHighPoints = v))}\n          />\n          <NumField\n            label="신고가 근접 기준"\n            hint="52주 최고가 대비 허용 낙폭 (음수)"\n            value={draft.priority.nearHighThresholdPercent}\n            step={1}\n            suffix="%"\n            onChange={(v) => patch((d) => void (d.priority.nearHighThresholdPercent = v))}\n          />\n          <NumField\n            label="7. 외국인 20일 순매수"\n            hint="최근 20거래일 외국인 누적 순매수 > 0"\n            value={draft.priority.foreignPoints}\n            step={0.5}\n            suffix="점"\n            onChange={(v) => patch((d) => void (d.priority.foreignPoints = v))}\n          />`;
  s = replaceExact(file, s, insertAfterVolume, vfExtraFields, "add Vf leadership/flow fields");
  s = s.replace("참고지표 (점수 미반영): 볼린저 스퀴즈 · 밴드폭 · MA20 이격률 · 밸류업 편입 · Head Fake\n            경고. 화면에는 계속 표시되지만 종합점수에는 반영되지 않습니다.", "참고지표 (Vf 점수 미반영): 볼린저 스퀴즈 · 밴드폭 · MA20 이격률 · 밸류업 편입 · Head Fake\n            경고. 화면에는 계속 표시되지만 주식 Vf 점수에는 반영되지 않습니다.");
  s = s.replace('label="A등급 최소 기술점수"', 'label="ETF A등급 최소 기술점수"');
  s = s.replace('label="B등급 최소 기술점수"', 'label="ETF B등급 최소 기술점수"');
  s = replaceRegex(file, s, /title=\{`3\. 우선순위 배점 \(현재 만점 \$\{prioMax\}점\)`\}/, 'title={`3. 보조 우선순위 배점 (Vf 주식점수 미반영 · 현재 만점 ${prioMax}점)`}', "section 3 title");
  s = replaceExact(file, s, 'desc="지수 편입·외국인 수급 등 항목별 배점과 임계값."', 'desc="지수 편입·규모·당일 상대성과는 진단/ETF용 보조 항목이며 주식 Vf 점수에는 들어가지 않습니다."', "section 3 desc");
  for (const block of [
`          <NumField\n            label="외국인 20일 순매수 배점"\n            hint="최근 20거래일 외국인 누적 순매수 > 0"\n            value={draft.priority.foreignPoints}\n            step={0.5}\n            suffix="점"\n            onChange={(v) => patch((d) => void (d.priority.foreignPoints = v))}\n          />\n`,
`          <NumField\n            label="52주 신고가 근접 배점"\n            hint="52주 고점 대비 허용 낙폭 이내"\n            value={draft.priority.nearHighPoints}\n            step={0.5}\n            suffix="점"\n            onChange={(v) => patch((d) => void (d.priority.nearHighPoints = v))}\n          />\n`,
`          <NumField\n            label="신고가 근접 기준"\n            hint="52주 최고가 대비 허용 낙폭 (음수)"\n            value={draft.priority.nearHighThresholdPercent}\n            step={1}\n            suffix="%"\n            onChange={(v) => patch((d) => void (d.priority.nearHighThresholdPercent = v))}\n          />\n`,
  ]) {
    s = replaceExact(file, s, block, "", "remove duplicate Vf priority field");
  }
  s = s.replace("V4 기본값으로 복원", "Vf 기본값으로 복원");
  write(file, s);
}

// ---------------------------------------------------------------------------
// 7) Screener/detail labels reflect the finalized model score.
// ---------------------------------------------------------------------------
{
  const file = "src/components/ScreenerTable.tsx";
  let s = read(file);
  s = s.replace('{ key: "total", label: "종합점수", id: "total" }', '{ key: "total", label: "모델점수", id: "total" }');
  s = s.replace('{ key: "static", label: "기술등급", id: "grade" }', '{ key: "static", label: "모델등급", id: "grade" }');
  write(file, s);
}

{
  const file = "src/routes/instrument.$symbol.tsx";
  let s = read(file);
  s = replaceExact(file, s, "    ruleEvaluations: [...row.technical.rows, ...row.priority.rows, ...row.quality.rows],", "    ruleEvaluations: [...(row.vf?.rows ?? []), ...row.technical.rows, ...row.priority.rows, ...row.quality.rows],", "detail Vf rules");
  s = replaceExact(file, s, "    finalScores: {\n      technical:", "    finalScores: {\n      vf: row.vf ? `${row.vf.points}/${row.vf.availableMaxPoints}` : null,\n      technical:", "detail Vf score");
  s = s.replace('label="종합점수"', 'label="Vf 점수"');
  write(file, s);
}

// ---------------------------------------------------------------------------
// 8) Regression tests for the locked Vf defaults and missing-aware normalization.
// ---------------------------------------------------------------------------
const testPath = "src/lib/engine/vf.test.ts";
write(
  testPath,
  `import { describe, expect, it } from "vitest";\n\nimport { DEFAULT_BACKTEST_PARAMS } from "./backtestV4";\nimport type { IndicatorSnapshot } from "./indicators";\nimport { DEFAULT_SCORING_CONFIG, normalize, vfStockScore } from "./scoring";\nimport { VF_FEATURE_WEIGHTS, VF_FEATURE_WEIGHT_TOTAL } from "./vfConfig";\n\nfunction snapshot(overrides: Partial<IndicatorSnapshot> = {}): IndicatorSnapshot {\n  return {\n    tradeDate: "2026-09-07",\n    close: 100,\n    ma20: 95,\n    ma60: 90,\n    ma120: 80,\n    ma20Slope: 1,\n    maAligned: true,\n    atr14: 3,\n    bollinger: {\n      bb: { middle: 90, upper: 99, lower: 81, width: 20 },\n      bbBreakout: true,\n      bbSqueezePrior: false,\n      bbSqueezeAbsolute: false,\n      bbWidthExpanding: true,\n      bbWalk: false,\n      headFakeWarning: false,\n    },\n    ichimoku: {\n      tenkan: 98,\n      kijun: 94,\n      cloudTop: 92,\n      cloudBottom: 88,\n      futureSenkouA: 96,\n      futureSenkouB: 90,\n      futureCloudBullish: true,\n      tenkanAboveKijun: true,\n      tenkanKijunGoldenCrossToday: false,\n      chikouAbovePast26Close: true,\n      chikouVsDisplayedCandle: true,\n    },\n    volumeRatio20: 160,\n    tradingValueRatio20: 160,\n    high52w: 104,\n    distanceFrom52wHigh: -3.85,\n    return20: 0.08,\n    return60: 0.15,\n    dayReturn: 0.01,\n    foreignNet5d: 100_000_000,\n    foreignNet20d: 300_000_000,\n    foreignNet60d: 500_000_000,\n    institutionNet20d: 0,\n    extensionFromMa20: 5.26,\n    atrExtension: 1.67,\n    closeLocationValue: 0.8,\n    ...overrides,\n  };\n}\n\ndescribe("CloudTrend Vf defaults", () => {\n  it("uses the validated feature weights in backtest defaults", () => {\n    for (const [id, weight] of Object.entries(VF_FEATURE_WEIGHTS)) {\n      expect(DEFAULT_BACKTEST_PARAMS.weights[id]).toBe(weight);\n    }\n    expect(DEFAULT_BACKTEST_PARAMS.weights.MA20_SLOPE_UP).toBe(0);\n    expect(DEFAULT_BACKTEST_PARAMS.weights.RS_POSITIVE).toBe(0);\n  });\n\n  it("scores all seven passing features as 100", () => {\n    const block = vfStockScore(snapshot(), DEFAULT_SCORING_CONFIG);\n    expect(block.maxPoints).toBe(VF_FEATURE_WEIGHT_TOTAL);\n    expect(block.availableMaxPoints).toBe(VF_FEATURE_WEIGHT_TOTAL);\n    expect(normalize(block)).toBe(100);\n  });\n\n  it("excludes missing features from the denominator", () => {\n    const block = vfStockScore(snapshot({ foreignNet20d: null }), DEFAULT_SCORING_CONFIG);\n    expect(block.availableMaxPoints).toBe(VF_FEATURE_WEIGHT_TOTAL - VF_FEATURE_WEIGHTS.FOREIGN_NET_POSITIVE);\n    expect(normalize(block)).toBe(100);\n  });\n});\n`,
);

console.log("CloudTrend Vf finalization applied.");
