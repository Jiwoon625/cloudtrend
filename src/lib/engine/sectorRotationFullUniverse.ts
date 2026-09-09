// 섹터 탭 전용 유니버스 보정 레이어.
//
// 핵심 원칙
// 1) 스크리닝 hard filter 통과 여부와 무관하게 MarketDataset에 존재하는 모든 주식을 섹터 유니버스로 본다.
// 2) 사용자 검토 완료 613종목 섹터 마스터를 최우선으로 다시 적용해 오래된 캐시/CSV 포맷 때문에 ETC가 남지 않게 한다.
// 3) 기존 sectorRotation 엔진이 계산 가능한 데이터가 부족해 제외한 단기 시계열 종목도 memberCount에는 포함하고,
//    실제 산출 가능 종목 비율만큼 신뢰도/완전성을 낮춰 데이터 부족을 숨기지 않는다.

import type { MarketDataset } from "./dataset";
import {
  computeSectorRotation as computeBaseSectorRotation,
  type RotationInput,
  type SectorRotationResult,
  type SectorRotationRow,
} from "./sectorRotation";
import { SECTOR_NAME_BY_CODE, THEME_SECTORS, resolveSectorCode } from "./sectors";
import {
  normalizeReviewedStockSymbol,
  resolveReviewedStockSectorCode,
} from "./stockSectorMaster";

export type { SectorRotationResult } from "./sectorRotation";

function canonicalSector(symbol: string, name: string, currentCode: string, currentName: string) {
  const normalized = normalizeReviewedStockSymbol(symbol);
  const reviewed = resolveReviewedStockSectorCode(normalized);
  if (reviewed) {
    return {
      code: reviewed,
      name: SECTOR_NAME_BY_CODE[reviewed] ?? currentName,
      reviewed: true,
    };
  }

  // 사용자 마스터 밖 종목은 기존 명시 섹터를 존중하고, ETC일 때만 규칙 기반으로 다시 시도한다.
  if (currentCode && currentCode !== "ETC") {
    return {
      code: currentCode,
      name: SECTOR_NAME_BY_CODE[currentCode] ?? currentName,
      reviewed: false,
    };
  }
  const fallback = resolveSectorCode(normalized, name, false);
  return { code: fallback.code, name: fallback.name, reviewed: false };
}

/** 섹터 분석 직전에 종목별 섹터를 최종 검토 마스터 기준으로 정규화한 데이터셋 복사본을 만든다. */
export function buildFullUniverseSectorDataset(ds: MarketDataset): MarketDataset {
  const instruments = ds.instruments.map((inst) => {
    if (inst.instrumentType !== "STOCK") return inst;
    const resolved = canonicalSector(
      inst.symbol,
      inst.name,
      inst.sectorCode,
      inst.sectorName,
    );
    if (resolved.code === inst.sectorCode && resolved.name === inst.sectorName) return inst;
    return {
      ...inst,
      sectorCode: resolved.code,
      sectorName: resolved.name,
    };
  });

  const usedCodes = new Set(instruments.map((i) => i.sectorCode));
  const sectors = THEME_SECTORS.filter((s) => usedCodes.has(s.code));
  return { ...ds, instruments, sectors };
}

function representativeStocks(ds: MarketDataset): Map<string, { symbol: string; name: string }> {
  const best = new Map<string, { symbol: string; name: string; value: number }>();
  for (const inst of ds.instruments) {
    if (inst.instrumentType !== "STOCK" || inst.sectorCode === "ETC" || inst.sectorCode === "MARKET_IDX")
      continue;
    const bars = ds.bars[inst.symbol] ?? [];
    const last = bars.at(-1);
    if (!last) continue;
    const value =
      last.marketCap !== null && Number.isFinite(last.marketCap)
        ? last.marketCap
        : last.tradingValue;
    const cur = best.get(inst.sectorCode);
    if (!cur || value > cur.value) {
      best.set(inst.sectorCode, { symbol: inst.symbol, name: inst.name, value });
    }
  }
  return new Map([...best].map(([code, v]) => [code, { symbol: v.symbol, name: v.name }]));
}

function reliabilityTag(value: number): SectorRotationRow["reliabilityTag"] {
  return value >= 85 ? "HIGH" : value >= 70 ? "MEDIUM" : value >= 50 ? "CAUTION" : "LIMITED";
}

/**
 * 기존 로테이션 계산식을 유지하면서 유니버스만 전체 데이터 기준으로 보정한다.
 * hardFilterPassed는 이 함수에서 전혀 참조하지 않는다.
 */
export function computeFullUniverseSectorRotation(
  ds: MarketDataset,
  input: RotationInput,
): SectorRotationResult | null {
  const canonical = buildFullUniverseSectorDataset(ds);

  // ETF 후보가 없거나 섹터 코드가 오래된 경우를 대비해 대표주를 보조 후보로 채운다.
  const representativeEtf = representativeStocks(canonical);
  for (const [code, item] of input.representativeEtf) representativeEtf.set(code, item);

  const result = computeBaseSectorRotation(canonical, { ...input, representativeEtf });
  if (!result) return null;

  const stocks = canonical.instruments.filter((i) => i.instrumentType === "STOCK");
  const fullBySector = new Map<string, typeof stocks>();
  for (const inst of stocks) {
    const arr = fullBySector.get(inst.sectorCode) ?? [];
    arr.push(inst);
    fullBySector.set(inst.sectorCode, arr);
  }

  const validNowBySector = new Map<string, number>();
  for (const [code, members] of fullBySector) {
    // 기존 엔진의 memberMetric 현재시점 조건(li >= 1)과 동일. 1봉 종목은 통계 계산은 불가하지만 구성원에는 포함한다.
    validNowBySector.set(
      code,
      members.filter((m) => (canonical.bars[m.symbol]?.length ?? 0) >= 2).length,
    );
  }

  const corrected = result.sectors.map((row) => {
    const fullCount = fullBySector.get(row.sectorCode)?.length ?? row.memberCount;
    const validCount = validNowBySector.get(row.sectorCode) ?? row.memberCount;
    const coverage = fullCount > 0 ? Math.min(1, validCount / fullCount) : 1;
    const anomalies = [...row.anomalies];
    if (validCount < fullCount) {
      anomalies.unshift(
        `전체 ${fullCount}종목 중 ${validCount}종목만 2봉 이상 확보되어 수익률·Breadth 산출 가능 (${fullCount - validCount}종목은 구성원 수에만 포함)`,
      );
    }
    const reliability = Math.max(0, Math.min(100, row.reliability * coverage));
    return {
      ...row,
      memberCount: fullCount,
      reliability,
      reliabilityTag: reliabilityTag(reliability),
      dataCompleteness: row.dataCompleteness * coverage,
      anomalies,
    };
  });

  const fullStockCount = stocks.length;
  const includedCount = [...fullBySector.values()].reduce((a, x) => a + x.length, 0);
  const reviewedCount = stocks.filter((i) => resolveReviewedStockSectorCode(i.symbol) !== undefined).length;
  const unmapped = stocks.filter((i) => i.sectorCode === "ETC");
  const indexCodes = canonical.indexSeries.map((s) => s.indexCode);
  const benchmarkText = ["KOSPI", "KOSDAQ"].filter((x) => indexCodes.includes(x)).join("/") || "없음";
  const coverageComment =
    `섹터 유니버스: 데이터 내 주식 ${fullStockCount}종목 중 ${includedCount}종목을 구성원으로 집계` +
    ` · 최종 검토 마스터 일치 ${reviewedCount}종목 · 기준지수 ${benchmarkText}` +
    (unmapped.length === 0
      ? " · 기타(ETC) 0종목"
      : ` · 미매핑 ${unmapped.length}종목(${unmapped.slice(0, 8).map((i) => `${i.name}/${i.symbol}`).join(", ")}${unmapped.length > 8 ? " 외" : ""})`);

  const overallCompleteness =
    corrected.length === 0
      ? 0
      : corrected.reduce((a, r) => a + r.dataCompleteness, 0) / corrected.length;

  return {
    ...result,
    sectors: corrected,
    overallCompleteness,
    commentary: [coverageComment, ...result.commentary],
  };
}
