// V8 Final 설정을 브라우저에 보관한다. 운영 배점은 UI에서 편집하지 않으며 버전 변경 시 기본값으로 마이그레이션한다.
import { useCallback, useEffect, useState } from "react";

import {
  DEFAULT_SCORING_CONFIG,
  mergeScoringConfig,
  SCORING_CONFIG_VERSION,
  type ScoringConfig,
} from "@/lib/engine/scoring";

const KEY = "cloudtrend.scoringConfig.v8-final";
const LEGACY_KEYS = [
  "cloudtrend.scoringConfig.v5",
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
      active = mergeScoringConfig(JSON.parse(raw));
      if (active.configVersion !== SCORING_CONFIG_VERSION) active = DEFAULT_SCORING_CONFIG;
      window.localStorage.setItem(KEY, JSON.stringify(active));
    } else {
      active = DEFAULT_SCORING_CONFIG;
      window.localStorage.setItem(KEY, JSON.stringify(active));
    }
    for (const legacyKey of LEGACY_KEYS) window.localStorage.removeItem(legacyKey);
  } catch {
    active = DEFAULT_SCORING_CONFIG;
  }
}

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
      // 세션 내 메모리 값은 유지한다.
    }
  }
  for (const listener of listeners) listener();
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
    const listener = () => setCfg(getActiveScoringConfig());
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  const update = useCallback((next: ScoringConfig) => setActiveScoringConfig(next), []);
  return [cfg, update];
}
