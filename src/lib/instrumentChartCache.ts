import { useEffect, useState } from "react";
import { supabase } from "./cloud";
import type { AnalysisPayload } from "./marketPayload";

// React Query must not merge different payloads just because calculatedAt is equal.
// Storage reuse is still based on the full input fingerprint and result digest.
const revisions = new WeakMap<AnalysisPayload, number>();
let nextRevision = 0;
export function instrumentChartQueryRevision(payload: AnalysisPayload) {
  let revision = revisions.get(payload);
  if (revision === undefined) {
    revision = ++nextRevision;
    revisions.set(payload, revision);
  }
  return revision;
}

export function useInstrumentChartOwner() {
  const [owner, setOwner] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  useEffect(() => {
    let active = true;
    let authEvents = 0;
    const applyOwner = (uid: string | null) => {
      if (!active) return;
      setOwner(uid);
      setAuthError(uid ? null : "로그인이 필요합니다.");
    };
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      authEvents++;
      applyOwner(session?.user.id ?? null);
    });
    void supabase.auth
      .getSession()
      .then(({ data, error }) => {
        if (error) throw error;
        if (!authEvents) applyOwner(data.session?.user.id ?? null);
      })
      .catch((error: unknown) => {
        if (active && !authEvents)
          setAuthError(error instanceof Error ? error.message : "세션 확인 실패");
      });
    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [retryCount]);
  const retryOwner = () => {
    setOwner(null);
    setAuthError(null);
    setRetryCount((count) => count + 1);
  };
  return { owner, authError, retryOwner };
}
