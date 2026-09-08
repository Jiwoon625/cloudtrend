// 사용자가 편집한 산식 설정을 브라우저에 보관하고, 분석 요청에 함께 실어 보낸다.
import { useCallback, useEffect, useState } from "react";

import {
  DEFAULT_SCORING_CONFIG,
  mergeScoringConfig,
  SCORING_CONFIG_VERSION,
  type ScoringConfig,
} from "@/lib/engine/scoring";

const KEY = "cloudtrend.scoringConfig.v5";
/** 구버전 저장 키 — 값 의미가 달라 이어받지 않고 Vf 기본값으로 마이그레이션한다. */
const LEGACY_KEYS = [
  "cloudtrend.scoringConfig.v4",
  "cloudtrend.scoringConfig.v3",
  "trendscore.scoringConfig.v2",
];

let active: ScoringConfig = DEFAULT_SCORING_CONFIG;
let hydrated = false;
const listeners = new Set<() => void>();

function hydrate() {
  if (hydrated || typeof window === "undefined") return;
  hydrated = true;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) {
      // configVersion < 현재 버전이면 mergeScoringConfig가 Vf 기본값을 반환한다.
      active = mergeScoringConfig(JSON.parse(raw));
      if (active.configVersion !== SCORING_CONFIG_VERSION) active = DEFAULT_SCORING_CONFIG;
      window.localStorage.setItem(KEY, JSON.stringify(active));
    } else {
      // V4 이하 키가 남아 있으면 제거된 피처 설정을 이어받지 않고 Vf 기본값으로 1회 마이그레이션한다.
      const legacy = LEGACY_KEYS.map((k) => window.localStorage.getItem(k)).find(Boolean);
      active = DEFAULT_SCORING_CONFIG;
      if (legacy) {
        window.localStorage.setItem(KEY, JSON.stringify(active));
        for (const k of LEGACY_KEYS) window.localStorage.removeItem(k);
      }
    }
  } catch {
    active = DEFAULT_SCORING_CONFIG;
  }
}

/** 서버 함수 호출 시 사용할 현재 설정 */
export function getActiveScoringConfig(): ScoringConfig {
  hydrate();
  return active;
}

export function setActiveScoringConfig(next: ScoringConfig) {
  active = mergeScoringConfig(next);
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(active));
    } catch {
      // 저장 실패는 무시 (세션 내에서는 메모리 값 사용)
    }
  }
  for (const l of listeners) l();
}

/** Vf 기본값 전체로 복원 */
export function resetScoringConfig() {
  setActiveScoringConfig(DEFAULT_SCORING_CONFIG);
}

export function isDefaultScoringConfig(cfg: ScoringConfig): boolean {
  return JSON.stringify(cfg) === JSON.stringify(DEFAULT_SCORING_CONFIG);
}

export function useScoringConfig(): [ScoringConfig, (next: ScoringConfig) => void] {
  const [cfg, setCfg] = useState<ScoringConfig>(DEFAULT_SCORING_CONFIG);
  useEffect(() => {
    setCfg(getActiveScoringConfig());
    const l = () => setCfg(getActiveScoringConfig());
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };

  }, []);
  const update = useCallback((next: ScoringConfig) => setActiveScoringConfig(next), []);
  return [cfg, update];
}