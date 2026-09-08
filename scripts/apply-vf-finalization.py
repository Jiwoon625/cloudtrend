from pathlib import Path
import re

ROOT = Path.cwd()


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def write(path: str, text: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, encoding="utf-8")


def replace_exact(path: str, text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise RuntimeError(f"{path}: target not found: {label}")
    return text.replace(old, new, 1)


def replace_regex(path: str, text: str, pattern: str, repl, label: str, flags=0) -> str:
    out, count = re.subn(pattern, repl, text, count=1, flags=flags)
    if count != 1:
        raise RuntimeError(f"{path}: regex target count={count}: {label}")
    return out


# ---------------------------------------------------------------------------
# 1) Single source of truth for finalized Vf defaults.
# ---------------------------------------------------------------------------
write(
    "src/lib/engine/vfConfig.ts",
    '''/** CloudTrend Vf — 2026-09-09 validation-finalized defaults. */
export const VF_MODEL_VERSION = 5;
export const VF_MODEL_LABEL = "Vf";

export const VF_FEATURE_WEIGHTS = {
  ICH_ABOVE_CLOUD: 1,
  ICH_TENKAN_KIJUN: 1,
  BB_BREAKOUT: 1.5,
  MA_ALIGNED: 1,
  VOLUME_SURGE: 0.5,
  NEAR_52W_HIGH: 2.5,
  FOREIGN_NET_POSITIVE: 2,
} as const;

export const VF_FEATURE_WEIGHT_TOTAL = Object.values(VF_FEATURE_WEIGHTS).reduce(
  (sum, value) => sum + value,
  0,
);

export const VF_DEFAULT_HORIZON_DAYS = 30;
export const VF_DEFAULT_ENTRY_SCORE = 60;
''',
)

# ---------------------------------------------------------------------------
# 2) Backtest defaults = exact same seven weights.
# ---------------------------------------------------------------------------
path = "src/lib/engine/backtest.ts"
s = read(path)
s = replace_exact(
    path,
    s,
    'import { computeIndicators, periodReturn, type IndicatorSnapshot } from "./indicators";',
    'import { computeIndicators, periodReturn, type IndicatorSnapshot } from "./indicators";\nimport { VF_FEATURE_WEIGHTS } from "./vfConfig";',
    "vfConfig import",
)
weights = {
    "ICH_ABOVE_CLOUD": "VF_FEATURE_WEIGHTS.ICH_ABOVE_CLOUD",
    "ICH_TENKAN_KIJUN": "VF_FEATURE_WEIGHTS.ICH_TENKAN_KIJUN",
    "BB_BREAKOUT": "VF_FEATURE_WEIGHTS.BB_BREAKOUT",
    "MA_ALIGNED": "VF_FEATURE_WEIGHTS.MA_ALIGNED",
    "MA20_SLOPE_UP": "0",
    "VOLUME_SURGE": "VF_FEATURE_WEIGHTS.VOLUME_SURGE",
    "NEAR_52W_HIGH": "VF_FEATURE_WEIGHTS.NEAR_52W_HIGH",
    "RS_POSITIVE": "0",
    "FOREIGN_NET_POSITIVE": "VF_FEATURE_WEIGHTS.FOREIGN_NET_POSITIVE",
}
for feature_id, expr in weights.items():
    pattern = rf'(id: "{feature_id}"[\s\S]*?defaultWeight:)\s*[-\d.]+,'
    s = replace_regex(path, s, pattern, rf'\1 {expr},', f"defaultWeight {feature_id}")
s = s.replace("Momentum Confirmation ① (Primary) — 1.5점 ÷ 3", "Momentum Confirmation — Vf 1.0점")
s = s.replace("52주 최고가 대비 -10% 이내 (Priority 2점)", "52주 최고가 대비 -10% 이내 (Vf 2.5점)")
s = s.replace("최근 20거래일 외국인 누적 순매수가 양수 (Priority 2점)", "최근 20거래일 외국인 누적 순매수가 양수 (Vf 2.0점)")
write(path, s)

# ---------------------------------------------------------------------------
# 3) Scoring engine: finalized defaults + exact 7-feature stock score.
# ---------------------------------------------------------------------------
path = "src/lib/engine/scoring.ts"
s = read(path)
s = replace_exact(
    path,
    s,
    'import { DEFAULT_ROTATION_WEIGHTS, type RotationWeights } from "./sectorRotation";',
    'import { DEFAULT_ROTATION_WEIGHTS, type RotationWeights } from "./sectorRotation";\nimport { VF_FEATURE_WEIGHTS, VF_MODEL_VERSION } from "./vfConfig";',
    "vfConfig import",
)
s = replace_exact(path, s, 'export const STRATEGY_VERSION = "1.0.1";', 'export const STRATEGY_VERSION = "Vf";', "strategy version")

vf_function = r'''
/**
 * CloudTrend Vf stock score.
 * Identical to the V5 backtest composite-score definition:
 * seven state features, weighted sum, missing-aware denominator.
 * MA20 slope and positive 20D return remain diagnostics only.
 */
export function vfStockScore(
  snap: IndicatorSnapshot,
  cfg: ScoringConfig = DEFAULT_SCORING_CONFIG,
): ScoreBlock {
  const rows: RuleRow[] = [];
  const t = cfg.technical;
  const p = cfg.priority;
  const flags = technicalFlagsV3(snap, cfg);

  const add = (
    group: string,
    rule: string,
    actual: string,
    flag: boolean | null,
    maxPoints: number,
  ) =>
    rows.push({
      group,
      rule,
      actual,
      threshold: `충족 시 +${maxPoints}`,
      status: flag === null ? "NO_DATA" : flag ? "PASS" : "FAIL",
      points: flag === true ? maxPoints : 0,
      maxPoints,
    });

  add(
    "Vf Trend",
    "일목 구름 상단 위",
    flags.cloudAbove === null
      ? "데이터 없음"
      : flags.cloudAbove
        ? `종가 ${fmtNum(snap.close)} > 구름 상단 ${fmtNum(snap.ichimoku.cloudTop)}`
        : "미충족",
    flags.cloudAbove,
    t.cloudAboveMax,
  );
  add(
    "Vf Momentum",
    "전환선 > 기준선",
    flags.tenkanAboveKijun === null ? "데이터 없음" : flags.tenkanAboveKijun ? "충족" : "미충족",
    flags.tenkanAboveKijun,
    t.momentumMax,
  );
  add(
    "Vf Breakout",
    "볼린저 상단 돌파 (Head Fake 시 미충족)",
    flags.bbBreakout === null ? "데이터 없음" : flags.bbBreakout ? "상단 돌파" : "미돌파",
    flags.bbBreakout,
    t.breakoutMax,
  );
  add(
    "Vf Trend",
    "이동평균 정배열 (MA20 > MA60 > MA120)",
    flags.maAligned === null ? "데이터 없음" : flags.maAligned ? "정배열" : "미충족",
    flags.maAligned,
    t.maAlignedMax,
  );
  add(
    "Vf Volume",
    `고가 마감 거래량 (거래량 ≥ ${t.volumeStrongRatio}% AND CLV ≥ ${t.clvThreshold})`,
    flags.highCloseVolume === null
      ? "데이터 없음"
      : `거래량 ${snap.volumeRatio20!.toFixed(0)}% / CLV ${snap.closeLocationValue!.toFixed(2)}`,
    flags.highCloseVolume,
    t.volumeMax,
  );

  const nearHigh =
    snap.distanceFrom52wHigh === null
      ? null
      : snap.distanceFrom52wHigh >= p.nearHighThresholdPercent;
  add(
    "Vf Leadership",
    `52주 신고가 대비 ${Math.abs(p.nearHighThresholdPercent)}% 이내`,
    snap.distanceFrom52wHigh === null ? "데이터 없음" : fmtPct(snap.distanceFrom52wHigh),
    nearHigh,
    p.nearHighPoints,
  );

  const foreignPositive = snap.foreignNet20d === null ? null : snap.foreignNet20d > 0;
  add(
    "Vf Flow",
    "최근 20거래일 외국인 누적 순매수 > 0",
    snap.foreignNet20d === null
      ? "데이터 없음"
      : `${(snap.foreignNet20d / 100_000_000).toFixed(1)}억 원`,
    foreignPositive,
    p.foreignPoints,
  );

  const points = Math.round(rows.reduce((sum, row) => sum + row.points, 0) * 100) / 100;
  const maxPoints = Math.round(rows.reduce((sum, row) => sum + row.maxPoints, 0) * 100) / 100;
  const availableMaxPoints =
    Math.round(
      rows.reduce((sum, row) => sum + (row.status === "NO_DATA" ? 0 : row.maxPoints), 0) * 100,
    ) / 100;
  return { points, maxPoints, availableMaxPoints, rows };
}

/** Vf score grade: 80+ A, 60+ B, otherwise C. */
export function vfGrade(score: number | null): TechnicalGrade {
  if (score !== null && score >= 80) return "A";
  if (score !== null && score >= 60) return "B";
  return "C";
}

'''
s = replace_exact(path, s, '\nexport type TechnicalGrade = "A" | "B" | "C";', vf_function + 'export type TechnicalGrade = "A" | "B" | "C";', "insert Vf score")

s = replace_exact(
    path,
    s,
    '''export const STOCK_WEIGHTS: Weights = {
  technical: 0.45,
  priority: 0.2,
  fundamental: 0.25,
  marketSector: 0.1,
};''',
    '''export const STOCK_WEIGHTS: Weights = {
  // Vf stock ranking bypasses the legacy block-composite path; kept explicit for config/UI clarity.
  technical: 1,
  priority: 0,
  fundamental: 0,
  marketSector: 0,
};''',
    "stock legacy weights",
)
s = replace_exact(path, s, "export const SCORING_CONFIG_VERSION = 4;", "export const SCORING_CONFIG_VERSION = VF_MODEL_VERSION;", "config version")
for old, new in [
    ("cloudAboveMax: 2,", "cloudAboveMax: VF_FEATURE_WEIGHTS.ICH_ABOVE_CLOUD,"),
    ("maAlignedMax: 2,", "maAlignedMax: VF_FEATURE_WEIGHTS.MA_ALIGNED,"),
    ("momentumMax: 1.5,", "momentumMax: VF_FEATURE_WEIGHTS.ICH_TENKAN_KIJUN,"),
    ("breakoutMax: 1,", "breakoutMax: VF_FEATURE_WEIGHTS.BB_BREAKOUT,"),
    ("volumeMax: 0.5,", "volumeMax: VF_FEATURE_WEIGHTS.VOLUME_SURGE,"),
    ("foreignPoints: 2,", "foreignPoints: VF_FEATURE_WEIGHTS.FOREIGN_NET_POSITIVE,"),
    ("nearHighPoints: 2,", "nearHighPoints: VF_FEATURE_WEIGHTS.NEAR_52W_HIGH,"),
    ("grade: { aMin: 6, bMin: 4 },", "grade: { aMin: 4, bMin: 3 },"),
]:
    s = replace_exact(path, s, old, new, f"default {old}")
s = s.replace("/** 현재 scoring 모델 버전 (V4) */", "/** 현재 scoring 모델 버전 (Vf) */")
s = s.replace("/** 저장된 설정의 모델 버전. 현재 V4 = 4 */", "/** 저장된 설정의 모델 버전. 현재 Vf = 5 */")
write(path, s)

# ---------------------------------------------------------------------------
# 4) Pipeline: stocks use exact Vf; ETFs keep legacy composite.
# ---------------------------------------------------------------------------
path = "src/lib/engine/pipeline.ts"
s = read(path)
s = replace_exact(path, s, "  totalScore,\n  type MarketGate,", "  totalScore,\n  vfGrade,\n  vfStockScore,\n  type MarketGate,", "scoring imports")
s = replace_exact(path, s, "  priority: ScoreBlock;\n  quality: ScoreBlock;", "  priority: ScoreBlock;\n  /** Finalized seven-feature Vf score (stocks only). */\n  vf: ScoreBlock | null;\n  quality: ScoreBlock;", "ScreeningRow vf field")
s = replace_exact(
    path,
    s,
    '''    const tech = technicalScore(snap, valuePct, cfg);
    const prio = priorityScore(inst, snap, financials, last.marketCap, bench.dayReturn, cfg);
    const quality =''',
    '''    const tech = technicalScore(snap, valuePct, cfg);
    const prio = priorityScore(inst, snap, financials, last.marketCap, bench.dayReturn, cfg);
    const vf = inst.instrumentType === "STOCK" ? vfStockScore(snap, cfg) : null;
    const vfNormalized = vf ? normalize(vf) : null;
    const modelGrade =
      inst.instrumentType === "STOCK" ? vfGrade(vfNormalized) : technicalGrade(tech.points, cfg);
    const quality =''',
    "build vf score",
)
s = replace_exact(path, s, "      priority: prio,\n      quality,", "      priority: prio,\n      vf,\n      quality,", "return vf")
s = replace_exact(
    path,
    s,
    '''      totalScoreNormalized: 0,
      dataCompletenessRatio: 0,
      grade: technicalGrade(tech.points, cfg),
      actionLabelText: actionLabel(technicalGrade(tech.points, cfg), gate.status),''',
    '''      totalScoreNormalized: inst.instrumentType === "STOCK" ? (vfNormalized ?? 0) : 0,
      dataCompletenessRatio:
        inst.instrumentType === "STOCK" && vf && vf.maxPoints > 0
          ? vf.availableMaxPoints / vf.maxPoints
          : 0,
      grade: modelGrade,
      actionLabelText: actionLabel(modelGrade, gate.status),''',
    "initial stock model score",
)
s = replace_exact(
    path,
    s,
    '''    const weights =
      row.instrument.instrumentType === "STOCK" ? cfg.weights.stock : cfg.weights.etf;
    const { total, dataCompletenessRatio } = totalScore({
      technicalNormalized: row.technicalNormalized,
      priorityNormalized: row.priorityNormalized,
      qualityScore: row.qualityScore,
      marketSectorScore: row.marketSectorScore,
      weights,
    });
    row.totalScoreNormalized = total;
    row.dataCompletenessRatio = dataCompletenessRatio;''',
    '''    let dataCompletenessRatio: number;
    if (row.instrument.instrumentType === "STOCK" && row.vf) {
      row.totalScoreNormalized = normalize(row.vf) ?? 0;
      dataCompletenessRatio =
        row.vf.maxPoints > 0 ? row.vf.availableMaxPoints / row.vf.maxPoints : 0;
    } else {
      const { total, dataCompletenessRatio: legacyCompleteness } = totalScore({
        technicalNormalized: row.technicalNormalized,
        priorityNormalized: row.priorityNormalized,
        qualityScore: row.qualityScore,
        marketSectorScore: row.marketSectorScore,
        weights: cfg.weights.etf,
      });
      row.totalScoreNormalized = total;
      dataCompletenessRatio = legacyCompleteness;
    }
    row.dataCompletenessRatio = dataCompletenessRatio;''',
    "final score loop",
)
write(path, s)

# ---------------------------------------------------------------------------
# 5) Browser config migration to Vf.
# ---------------------------------------------------------------------------
path = "src/lib/scoringConfigStore.ts"
s = read(path)
s = replace_exact(path, s, 'const KEY = "cloudtrend.scoringConfig.v4";', 'const KEY = "cloudtrend.scoringConfig.v5";', "storage key")
s = replace_exact(
    path,
    s,
    'const LEGACY_KEYS = ["cloudtrend.scoringConfig.v3", "trendscore.scoringConfig.v2"];',
    'const LEGACY_KEYS = [\n  "cloudtrend.scoringConfig.v4",\n  "cloudtrend.scoringConfig.v3",\n  "trendscore.scoringConfig.v2",\n];',
    "legacy keys",
)
s = s.replace("V4 기본값", "Vf 기본값")
s = s.replace("V3 이하", "V4 이하")
write(path, s)

# ---------------------------------------------------------------------------
# 6) Data / formula tab shows and edits the exact Vf stock formula.
# ---------------------------------------------------------------------------
path = "src/routes/scoring.tsx"
s = read(path)
s = s.replace("restoreV4Defaults", "restoreVfDefaults")
s = s.replace("V4 기본값", "Vf 기본값")
s = replace_exact(path, s, "  const prioMax = priorityMaxPoints(draft);", "  const prioMax = priorityMaxPoints(draft);\n  const vfMax = techMax + draft.priority.nearHighPoints + draft.priority.foreignPoints;", "vfMax")
s = replace_exact(
    path,
    s,
    '''          시세 데이터를 입력해 스크리닝을 시작하고, 아래 산식·가중치로 주식·ETF 스크리너와 종목
          상세의 점수를 조정합니다.''',
    '''          시세 데이터를 입력해 스크리닝을 시작합니다. 주식은 검증 완료된 CloudTrend Vf 7개 피처
          점수를 사용하고, ETF는 별도 기존 종합점수 구조를 유지합니다.''',
    "page description",
)
formula_re = r'\{`기술점수\(%\) = 획득 / 산정가능 만점 × 100[\s\S]*?종합점수 = Σ\(항목% × 가중치\) / Σ\(데이터가 있는 항목의 가중치\)`\}'
formula_new = r'''{`주식 CloudTrend Vf 점수 = Σ(충족한 피처 가중치) / Σ(산정 가능한 7개 피처 가중치) × 100
기본 원점수 만점 = ${vfMax}점

피처 = 일목 구름 상단 위 + 전환선>기준선 + 볼린저 상단 돌파 + 이동평균 정배열
      + 고가마감 거래량 + 52주 신고가 근접 + 외국인 20일 순매수

데이터가 없는 피처는 0점 처리하지 않고 분모에서도 제외합니다.
MA20 상승·20일 수익률 양수·펀더멘털·시장/섹터·지수편입·규모·당일 상대수익은 주식 Vf 점수에 미반영됩니다.

ETF 종합점수 = Σ(항목% × ETF 가중치) / Σ(데이터가 있는 항목의 가중치)`}'''
s = replace_regex(path, s, formula_re, lambda _: formula_new, "formula block")
s = replace_exact(
    path,
    s,
    '''          데이터가 없는 항목(예: 토스 API 미제공 재무)은 0점이 아니라 분모에서 제외됩니다. 따라서
          가중치 합이 1이 아니어도 결과는 정규화됩니다.''',
    '''          주식 Vf는 백테스트와 동일하게 피처별 NO_DATA를 분모에서 제외합니다. 52주 신고가 피처는
          정확히 252거래일이 확보된 시점부터만 계산됩니다.''',
    "formula note",
)
s = replace_exact(path, s, 'title="1. 종합점수 가중치"', 'title="1. ETF 종합점수 가중치"', "section 1 title")
s = replace_exact(path, s, 'desc="주식과 ETF에 각각 다른 가중치를 적용합니다. 합계가 1이 아니어도 자동 정규화됩니다."', 'desc="주식 Vf는 아래 7개 피처 구조를 사용합니다. 이 블록 가중치는 ETF에만 적용됩니다."', "section 1 desc")
s = replace_exact(
    path,
    s,
    '{(["stock", "etf"] as const).map((k) => (',
    '<p className="rounded-md border border-border bg-surface p-2 text-[11px] text-muted-foreground">주식 점수는 블록 가중치가 아니라 Vf 7개 피처 원점수를 직접 정규화합니다.</p>\n          {(["stock", "etf"] as Array<"stock" | "etf">).filter((k) => k === "etf").map((k) => (',
    "ETF-only block weights",
)
s = replace_regex(path, s, r'title=\{`2\. 기술 신호 배점 — V4 \(현재 만점 \$\{techMax\}점\)`\}', 'title={`2. CloudTrend Vf 7개 피처 배점 — 현재 만점 ${vfMax}점`}', "section 2 title")
s = replace_exact(path, s, 'desc="Trend Core 4.0 + 전환선>기준선 1.5 + Breakout 1.0 + Volume 0.5. MA20 상승과 20일 수익률 양수는 피처에서 제거했습니다."', 'desc="백테스트와 종목스크리너가 같은 7개 상태 피처와 같은 가중치를 사용합니다. 기본 만점은 9.5점입니다."', "section 2 desc")
volume_block = '''          <NumField
            label="5. 고가마감 거래량"
            hint="거래량 비율 기준 AND CLV = (종가-저가)/(고가-저가) 기준 동시 충족"
            value={draft.technical.volumeMax}
            step={0.5}
            suffix="점"
            onChange={(v) => patch((d) => void (d.technical.volumeMax = v))}
          />'''
extra = volume_block + '''
          <NumField
            label="6. 52주 신고가 근접"
            hint="정확히 252거래일 기준 최고가 대비 허용 낙폭 이내"
            value={draft.priority.nearHighPoints}
            step={0.5}
            suffix="점"
            onChange={(v) => patch((d) => void (d.priority.nearHighPoints = v))}
          />
          <NumField
            label="신고가 근접 기준"
            hint="52주 최고가 대비 허용 낙폭 (음수)"
            value={draft.priority.nearHighThresholdPercent}
            step={1}
            suffix="%"
            onChange={(v) => patch((d) => void (d.priority.nearHighThresholdPercent = v))}
          />
          <NumField
            label="7. 외국인 20일 순매수"
            hint="최근 20거래일 외국인 누적 순매수 > 0"
            value={draft.priority.foreignPoints}
            step={0.5}
            suffix="점"
            onChange={(v) => patch((d) => void (d.priority.foreignPoints = v))}
          />'''
s = replace_exact(path, s, volume_block, extra, "Vf fields")
s = s.replace("참고지표 (점수 미반영):", "참고지표 (Vf 점수 미반영):")
s = s.replace("화면에는 계속 표시되지만 종합점수에는 반영되지 않습니다.", "화면에는 계속 표시되지만 주식 Vf 점수에는 반영되지 않습니다.")
s = s.replace('label="A등급 최소 기술점수"', 'label="ETF A등급 최소 기술점수"')
s = s.replace('label="B등급 최소 기술점수"', 'label="ETF B등급 최소 기술점수"')
s = replace_regex(path, s, r'title=\{`3\. 우선순위 배점 \(현재 만점 \$\{prioMax\}점\)`\}', 'title={`3. 보조 우선순위 배점 (Vf 주식점수 미반영 · 현재 만점 ${prioMax}점)`}', "section 3 title")
s = replace_exact(path, s, 'desc="지수 편입·외국인 수급 등 항목별 배점과 임계값."', 'desc="지수 편입·규모·당일 상대성과는 진단/ETF용 보조 항목이며 주식 Vf 점수에는 들어가지 않습니다."', "section 3 desc")
for block in [
    '''          <NumField
            label="외국인 20일 순매수 배점"
            hint="최근 20거래일 외국인 누적 순매수 > 0"
            value={draft.priority.foreignPoints}
            step={0.5}
            suffix="점"
            onChange={(v) => patch((d) => void (d.priority.foreignPoints = v))}
          />
''',
    '''          <NumField
            label="52주 신고가 근접 배점"
            hint="52주 고점 대비 허용 낙폭 이내"
            value={draft.priority.nearHighPoints}
            step={0.5}
            suffix="점"
            onChange={(v) => patch((d) => void (d.priority.nearHighPoints = v))}
          />
''',
    '''          <NumField
            label="신고가 근접 기준"
            hint="52주 최고가 대비 허용 낙폭 (음수)"
            value={draft.priority.nearHighThresholdPercent}
            step={1}
            suffix="%"
            onChange={(v) => patch((d) => void (d.priority.nearHighThresholdPercent = v))}
          />
''',
]:
    s = replace_exact(path, s, block, "", "remove duplicate Vf field")
s = s.replace("V4 기본값으로 복원", "Vf 기본값으로 복원")
write(path, s)

# ---------------------------------------------------------------------------
# 7) Labels and detail calculation log.
# ---------------------------------------------------------------------------
path = "src/components/ScreenerTable.tsx"
s = read(path)
s = s.replace('{ key: "total", label: "종합점수", id: "total" }', '{ key: "total", label: "모델점수", id: "total" }')
s = s.replace('{ key: "static", label: "기술등급", id: "grade" }', '{ key: "static", label: "모델등급", id: "grade" }')
write(path, s)

path = "src/routes/instrument.$symbol.tsx"
s = read(path)
s = replace_exact(path, s, "    ruleEvaluations: [...row.technical.rows, ...row.priority.rows, ...row.quality.rows],", "    ruleEvaluations: [...(row.vf?.rows ?? []), ...row.technical.rows, ...row.priority.rows, ...row.quality.rows],", "detail Vf rules")
s = replace_exact(path, s, "    finalScores: {\n      technical:", "    finalScores: {\n      vf: row.vf ? `${row.vf.points}/${row.vf.availableMaxPoints}` : null,\n      technical:", "detail Vf score")
s = s.replace('label="종합점수"', 'label="Vf 점수"')
write(path, s)

# ---------------------------------------------------------------------------
# 8) Regression tests.
# ---------------------------------------------------------------------------
write(
    "src/lib/engine/vf.test.ts",
    '''import { describe, expect, it } from "vitest";

import { DEFAULT_BACKTEST_PARAMS } from "./backtestV4";
import type { IndicatorSnapshot } from "./indicators";
import { DEFAULT_SCORING_CONFIG, normalize, vfStockScore } from "./scoring";
import { VF_FEATURE_WEIGHTS, VF_FEATURE_WEIGHT_TOTAL } from "./vfConfig";

function snapshot(overrides: Partial<IndicatorSnapshot> = {}): IndicatorSnapshot {
  return {
    tradeDate: "2026-09-07",
    close: 100,
    ma20: 95,
    ma60: 90,
    ma120: 80,
    ma20Slope: 1,
    maAligned: true,
    atr14: 3,
    bollinger: {
      bb: { middle: 90, upper: 99, lower: 81, width: 20 },
      bbBreakout: true,
      bbSqueezePrior: false,
      bbSqueezeAbsolute: false,
      bbWidthExpanding: true,
      bbWalk: false,
      headFakeWarning: false,
    },
    ichimoku: {
      tenkan: 98,
      kijun: 94,
      cloudTop: 92,
      cloudBottom: 88,
      futureSenkouA: 96,
      futureSenkouB: 90,
      futureCloudBullish: true,
      tenkanAboveKijun: true,
      tenkanKijunGoldenCrossToday: false,
      chikouAbovePast26Close: true,
      chikouVsDisplayedCandle: true,
    },
    volumeRatio20: 160,
    tradingValueRatio20: 160,
    high52w: 104,
    distanceFrom52wHigh: -3.85,
    return20: 0.08,
    return60: 0.15,
    dayReturn: 0.01,
    foreignNet5d: 100_000_000,
    foreignNet20d: 300_000_000,
    foreignNet60d: 500_000_000,
    institutionNet20d: 0,
    extensionFromMa20: 5.26,
    atrExtension: 1.67,
    closeLocationValue: 0.8,
    ...overrides,
  };
}

describe("CloudTrend Vf defaults", () => {
  it("uses validated weights in backtest defaults", () => {
    for (const [id, weight] of Object.entries(VF_FEATURE_WEIGHTS)) {
      expect(DEFAULT_BACKTEST_PARAMS.weights[id]).toBe(weight);
    }
    expect(DEFAULT_BACKTEST_PARAMS.weights.MA20_SLOPE_UP).toBe(0);
    expect(DEFAULT_BACKTEST_PARAMS.weights.RS_POSITIVE).toBe(0);
  });

  it("scores all seven passing features as 100", () => {
    const block = vfStockScore(snapshot(), DEFAULT_SCORING_CONFIG);
    expect(block.maxPoints).toBe(VF_FEATURE_WEIGHT_TOTAL);
    expect(block.availableMaxPoints).toBe(VF_FEATURE_WEIGHT_TOTAL);
    expect(normalize(block)).toBe(100);
  });

  it("excludes missing features from the denominator", () => {
    const block = vfStockScore(snapshot({ foreignNet20d: null }), DEFAULT_SCORING_CONFIG);
    expect(block.availableMaxPoints).toBe(
      VF_FEATURE_WEIGHT_TOTAL - VF_FEATURE_WEIGHTS.FOREIGN_NET_POSITIVE,
    );
    expect(normalize(block)).toBe(100);
  });
});
''',
)

print("CloudTrend Vf finalization applied.")
