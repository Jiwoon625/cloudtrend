import { queryOptions } from "@tanstack/react-query";

import {
  getDataStatus,
  getInstrumentDetail,
  getMarketAnalysis,
  getServerEgressIp,
} from "@/lib/market.functions";


export const analysisQueryOptions = queryOptions({
  queryKey: ["market-analysis"],
  queryFn: () => getMarketAnalysis(),
  staleTime: 5 * 60 * 1000,
  retry: false,
});

export const dataStatusQueryOptions = queryOptions({
  queryKey: ["data-status"],
  queryFn: () => getDataStatus(),
  staleTime: 5 * 60 * 1000,
  retry: false,
});

export const instrumentQueryOptions = (symbol: string) =>
  queryOptions({
    queryKey: ["instrument", symbol],
    queryFn: () => getInstrumentDetail({ data: { symbol } }),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

export const ipQueryOptions = queryOptions({
  queryKey: ["server-egress-ip"],
  queryFn: () => getServerEgressIp(),
  staleTime: 60 * 1000,
});

