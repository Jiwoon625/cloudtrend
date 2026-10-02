import { useQuery } from "@tanstack/react-query";
import { UsTaxEstimatePanel } from "./UsTaxEstimatePanel";
import { supabase } from "@/lib/cloud";
import { usModelTaxProjectionsServer } from "@/lib/usModelTax.functions";
import { modelUsTaxOverlay } from "@/lib/usTaxOverlay";
import type { UsPortfolioSnapshotRecord } from "@/lib/usProspectiveCloud";

/** Optional tax proof loading must not hold up portfolio holdings, NAV or order previews. */
export function UsModelTaxEstimatePanel({
  snapshot,
  title,
}: {
  snapshot: UsPortfolioSnapshotRecord | undefined;
  title: string;
}) {
  const query = useQuery({
    queryKey: [
      "us-model-tax-projection",
      snapshot?.strategy_id,
      snapshot?.date,
      snapshot?.rule_version,
      snapshot?.nav_usd,
      snapshot?.cash_usd,
    ],
    enabled: !!snapshot,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: false,
    queryFn: async () => {
      if (!snapshot) throw new Error("모델 스냅샷 확인 필요");
      const strategyId = snapshot.strategy_id;
      if (
        strategyId !== "A0_QUARTER_PRIMARY" &&
        strategyId !== "A2_QUARTER_SHADOW" &&
        strategyId !== "B3_BETA_SHADOW"
      )
        throw new Error("이 모델의 세무 원천 연결은 아직 지원하지 않습니다.");
      const { data, error } = await supabase.auth.getSession();
      if (error || !data.session) throw new Error("세금 원천 확인을 위한 로그인 세션이 없습니다.");
      const response = await usModelTaxProjectionsServer({
        data: {
          accessToken: data.session.access_token,
          requests: [{ strategyId, sourceDate: snapshot.date }],
        },
      });
      const projection = response.find(
        (r) => r.strategyId === strategyId && r.sourceDate === snapshot.date,
      );
      if (!projection) throw new Error("모델 세금 원천 응답이 없거나 기준일이 다릅니다.");
      return projection;
    },
  });
  const projection = query.data;
  const matches =
    projection?.strategyId === snapshot?.strategy_id && projection?.sourceDate === snapshot?.date;
  const estimate = modelUsTaxOverlay(
    snapshot
      ? {
          ...snapshot,
          state: {
            ...snapshot.state,
            taxEvidence: matches ? projection?.taxEvidence : null,
            taxSource: matches ? projection?.taxSource : null,
            taxProjectionMissing: query.error
              ? [query.error.message]
              : matches
                ? (projection?.missingFields ?? [])
                : [],
          },
        }
      : undefined,
  );
  return (
    <div className="min-w-0 space-y-2">
      {snapshot && query.isPending ? (
        <p role="status" className="text-xs text-muted-foreground">
          모델 세금 원천을 확인 중입니다. 보유·NAV는 먼저 표시합니다.
        </p>
      ) : null}
      <UsTaxEstimatePanel estimate={estimate} title={title} />
    </div>
  );
}
