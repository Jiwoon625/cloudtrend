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
  const limits = {
    maxRows: 5000,
    maxScalarCharacters: 1000,
    maxSourceBytes: 1_600_000,
    maxObservationBytes: 1_400_000,
  };
  const limitations = new Set<string>();
  const bySymbol = new Map(artifact.symbols.map((row) => [row.symbol, row]));
  const requested = new Map(
    selected.map((row) => [
      row.symbol,
      new Set([
        ...row.conflicts,
        ...(row.issues.length === 1 && row.conflicts.length
          ? []
          : [...report.window, ...(bySymbol.get(row.symbol)?.observations.map((o) => o[0]) ?? [])]),
      ]),
    ]),
  );
  const encoder = new TextEncoder();
  let observationBytes = 0;
  const observations = selected.flatMap((row) => {
    const active = new Map(
      (dataset.observedBars?.[row.symbol] ?? dataset.bars[row.symbol] ?? []).map((bar) => [
        bar.tradeDate,
        bar,
      ]),
    );
    const supplement = new Map(bySymbol.get(row.symbol)?.observations.map((o) => [o[0], o]) ?? []);
    return [...requested.get(row.symbol)!]
      .sort()
      .map((date) => {
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
      })
      .filter((entry) => {
        const size = encoder.encode(JSON.stringify(entry)).length;
        if (
          Object.values(entry).some(
            (v) => typeof v === "string" && v.length > limits.maxScalarCharacters,
          ) ||
          observationBytes + size > limits.maxObservationBytes
        ) {
          limitations.add(
            "Normalized observation evidence limit reached; some observations omitted",
          );
          return false;
        }
        observationBytes += size;
        return true;
      });
  });
  const sourceRows: Array<Record<string, string | number>> = [];
  const canonical = (key: string) => key.replace(/\s|_/g, "").toLowerCase();
  let sourceBytes = 0;
  texts.forEach((text, sourceIndex) => {
    if (!selected.length) return;
    const sourceId = sources[sourceIndex]!.id;
    if (text.trimStart().startsWith("[") || text.trimStart().startsWith("{")) {
      limitations.add(
        `${sourceId}: JSON raw source evidence unsupported; normalized observations remain available`,
      );
      return;
    }
    let header: string[] = [];
    const columnCache = new Map<string, number | undefined>();
    visitDelimitedRows(text, (cells, rowIndex) => {
      if (rowIndex === 0) {
        header = cells.map(canonical);
        if (new Set(header).size !== header.length)
          limitations.add(
            `${sourceId}: duplicate normalized headers; raw rows are ambiguous candidates`,
          );
        return;
      }
      const get = (...aliases: string[]) => {
        const key = aliases.join("|");
        if (!columnCache.has(key)) {
          const indexes = header.flatMap((name, index) => (aliases.includes(name) ? [index] : []));
          if (indexes.length > 1)
            limitations.add(`${sourceId}: alias collision; raw rows are ambiguous candidates`);
          columnCache.set(key, indexes.at(-1));
        }
        const index = columnCache.get(key);
        return index === undefined ? "" : (cells[index] ?? "");
      };
      const symbol = normalizeKrxSymbol(get("symbol", "code", "종목코드", "단축코드"));
      const dates = requested.get(symbol);
      if (!dates) return;
      const rawDate = get("date", "tradedate", "기준일", "일자");
      const digits = rawDate.replace(/\D/g, "");
      const date = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
      if (!dates.has(date)) return;
      const candidate = {
        sourceId: sources[sourceIndex]!.id,
        sourceOrder: sourceIndex,
        logicalRecordNumber: rowIndex + 1,
        symbol,
        date,
        rawDate,
        indexValue: get("etfunderlyingindexclose"),
        indexName: get("etfunderlyingindexname"),
        marketCapSource: get("marketcapsource"),
        tradingValueSource: get("tradingvaluesource"),
        type: get("type", "종류", "securitytype"),
        market: get("market", "시장"),
      };
      if (
        Object.values(candidate).some(
          (value) => typeof value === "string" && value.length > limits.maxScalarCharacters,
        )
      ) {
        limitations.add(`${sourceId}: oversized scalar omitted`);
        return;
      }
      const size = encoder.encode(JSON.stringify(candidate)).length;
      if (sourceRows.length >= limits.maxRows || sourceBytes + size > limits.maxSourceBytes) {
        limitations.add(`${sourceId}: source evidence limit reached; some candidates omitted`);
        return;
      }
      sourceRows.push(candidate);
      sourceBytes += size;
    });
  });
  return {
    version: "underlying-index-evidence-v1",
    usage: "diagnostic-only",
    writesPerformed: 0,
    sourceRowsAreCandidatesNotWinningProvenance: true,
    sourceScalarsAreTrimmedParsedValues: true,
    observationScope:
      "conflict dates for value-only quarantine; retained dates for identity quarantine",
    sourceEvidenceComplete: limitations.size === 0,
    limitations: [...limitations],
    limits,
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
