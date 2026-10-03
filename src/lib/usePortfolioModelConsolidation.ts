import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "./cloud";
import { octoberShadowSummaryServer } from "./octoberShadowSummary.functions";
import { isPortfolioModelComparisonReady } from "./portfolioModelConsolidation";

/** Owner-bound, read-only proof that all replacement comparison panels are available. */
export function usePortfolioModelConsolidation(enabled: boolean) {
  const [owner, setOwner] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    let authRevision = 0;
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      authRevision++;
      if (!active) return;
      setOwner(session?.user.id ?? null);
      setAuthError(session ? null : "Shadow 비교 화면의 로그인 소유자를 확인해 주세요.");
    });
    const requestedRevision = authRevision;
    void supabase.auth
      .getSession()
      .then(({ data, error }) => {
        // A delayed initial lookup must not restore an owner after sign-out/account switch.
        if (!active || authRevision !== requestedRevision) return;
        setOwner(!error && data.session ? data.session.user.id : null);
        setAuthError(
          !error && data.session ? null : "Shadow 비교 화면의 로그인 소유자를 확인해 주세요.",
        );
      })
      .catch(() => {
        if (!active || authRevision !== requestedRevision) return;
        setOwner(null);
        setAuthError("Shadow 비교 화면의 로그인 상태를 확인하지 못했습니다.");
      });
    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);
  const query = useQuery({
    queryKey: ["october-shadow-summary", owner],
    enabled: enabled && !!owner,
    staleTime: 60_000,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const { data, error } = await supabase.auth.getSession();
      if (error || !data.session || data.session.user.id !== owner)
        throw new Error("Shadow 비교 화면의 로그인 소유자 확인 필요");
      return octoberShadowSummaryServer({ data: { accessToken: data.session.access_token } });
    },
  });
  return {
    ready:
      enabled &&
      !!owner &&
      !authError &&
      !query.isError &&
      isPortfolioModelComparisonReady(query.data),
    checking: enabled && !authError && (!owner || query.isPending),
    error: authError ?? query.error?.message ?? null,
    refresh: () => query.refetch(),
    refreshing: query.isFetching,
  };
}
