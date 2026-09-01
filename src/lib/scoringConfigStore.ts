// 사용자가 편집한 산식 설정을 브라우저에 보관하고, 분석 요청에 함께 실어 보낸다.
import { useCallback, useEffect, useState } from "react";

import { DEFAULT_SCORING_CONFIG, mergeScoringConfig, type ScoringConfig } from "@/lib/engine/scoring";

const KEY = "trendscore.scoringConfig.v1";

let active: ScoringConfig = DEFAULT_SCORING_CONFIG;
let hydrated = false;
const listeners = new Set<() => void>();

function hydrate() {
  if (hydrated || typeof window === "undefined") return;
  hydrated = true;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) active = mergeScoringConfig(JSON.parse(raw));
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
