import type { MarketDataset } from "./engine/dataset";
import { normalizeKrxSymbol } from "./engine/manualDataset";
import { visitDelimitedRows } from "./sourceData";
import type { ActiveSourceRecord } from "./screeningSources.server";
import type { IndexDiagnosticReport, UnderlyingIndexArtifact } from "./underlyingIndexSupplement";

/** Read-only evidence. Raw source rows are candidates, not asserted winning provenance. */
export function collectUnderlyingIndexEvidence(
  dataset: MarketDataset,
  artifact: UnderlyingIndexArtifact,
  report: IndexDiagnosticReport,
  sources: ActiveSourceRecord[],
  texts: string[],
) {
  if (sources.length !== texts.length) throw new Error("Source evidence alignment failed");
  const selected = report.rows.filter((row) => row.status === "quarantined");
  const bySymbol = new Map(artifact.symbols.map((row) => [row.symbol, row]));
  const requested = new Map(
    selected.map((row) => [
      row.symbol,
      new Set([
        ...report.window,
        ...row.conflicts,
        ...(bySymbol.get(row.symbol)?.observations.map((o) => o[0]) ?? []),
      ]),
    ]),
  );
  const observations = selected.flatMap((row) => {
    const active = new Map(
      (dataset.observedBars?.[row.symbol] ?? dataset.bars[row.symbol] ?? []).map((bar) => [
        bar.tradeDate,
        bar,
      ]),
    );
    const supplement = new Map(bySymbol.get(row.symbol)?.observations.map((o) => [o[0], o]) ?? []);
    return [...requested.get(row.symbol)!].sort().map((date) => {
      const a = active.get(date),
        s = supplement.get(date);
      return {
        symbol: row.symbol,
        date,
        activeValue: a?.etfUnderlyingIndexClose ?? null,
        activeIndexName: a?.etfUnderlyingIndexName ?? null,
        activeProvider: a?.etfUnderlyingIndexSource ?? null,
        supplementValue: s?.[1] ?? null,
        supplementIndexName: s?.[2] ?? null,
        supplementSourceId: s?.[3] ?? null,
        valueConflict: row.conflicts.includes(date),
      };
    });
  });
  const sourceRows: Array<Record<string, string | number>> = [];
  const canonical = (key: string) => key.replace(/\s|_/g, "").toLowerCase();
  texts.forEach((text, sourceIndex) => {
    let header: string[] = [];
    visitDelimitedRows(text, (cells, rowIndex) => {
      if (rowIndex === 0) {
        header = cells.map(canonical);
        return;
      }
      const get = (...aliases: string[]) => {
        const index = aliases.map((alias) => header.indexOf(alias)).find((i) => i >= 0);
        return index === undefined ? "" : (cells[index] ?? "");
      };
      const symbol = normalizeKrxSymbol(get("symbol", "code", "종목코드", "단축코드"));
      const dates = requested.get(symbol);
      if (!dates) return;
      const rawDate = get("date", "tradedate", "기준일", "일자");
      const digits = rawDate.replace(/\D/g, "");
      const date = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
      if (!dates.has(date)) return;
      sourceRows.push({
        sourceId: sources[sourceIndex]!.id,
        sourceOrder: sourceIndex,
        rowNumber: rowIndex + 1,
        symbol,
        date,
        rawDate,
        indexValue: get("etfunderlyingindexclose"),
        indexName: get("etfunderlyingindexname"),
        marketCapSource: get("marketcapsource"),
        tradingValueSource: get("tradingvaluesource"),
        type: get("type", "종류", "securitytype"),
        market: get("market", "시장"),
      });
    });
  });
  return {
    version: "underlying-index-evidence-v1",
    usage: "diagnostic-only",
    writesPerformed: 0,
    sourceRowsAreCandidatesNotWinningProvenance: true,
    observations,
    sourceRows,
    activeSources: sources.map((s, sourceOrder) => ({
      id: s.id,
      sourceOrder,
      filename: s.original_filename,
      sha256: s.file_hash,
      activatedAt: s.activated_at,
      createdAt: s.created_at,
    })),
    supplementSources: artifact.sources,
  };
}
