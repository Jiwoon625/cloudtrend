import { CANONICAL_SOURCE_COLUMNS, type SourceValidationResult } from "../sourceData";

export const V8_INPUT_CONTRACT_VERSION = "toss-krx-102-v2" as const;

export const V8_REQUIRED_COLUMNS = [
  "symbol",
  "date",
  "market",
  "open",
  "high",
  "low",
  "close",
  "volume",
  "tradingValue",
  "foreignNetBuyValue",
] as const;

export interface V8InputQualityFile {
  fileName: string | null;
  rows: number;
  from: string | null;
  to: string | null;
  suppliedColumnCount: number;
  populatedColumnCount: number;
  completelyEmptySuppliedColumns: string[];
  missingRequiredColumns: string[];
  sectorUnmappedCount: number;
}

export function buildV8InputQualityReport(
  inputs: Array<{ fileName: string | null; validation: SourceValidationResult }>,
) {
  const files: V8InputQualityFile[] = inputs.map(({ fileName, validation }) => {
    const supplied = new Set(validation.columns);
    const completelyEmptySuppliedColumns = validation.stats.completelyEmptyColumns.filter((column) =>
      supplied.has(column),
    );
    return {
      fileName,
      rows: validation.stats.rowCount,
      from: validation.stats.minDate,
      to: validation.stats.maxDate,
      suppliedColumnCount: supplied.size,
      populatedColumnCount: validation.stats.populatedColumnCount,
      completelyEmptySuppliedColumns,
      missingRequiredColumns: V8_REQUIRED_COLUMNS.filter((column) => !supplied.has(column)),
      sectorUnmappedCount: validation.stats.sectorUnmappedCount,
    };
  });
  const missingRequired = files.filter((file) => file.missingRequiredColumns.length > 0);
  const allEmpty = [...new Set(files.flatMap((file) => file.completelyEmptySuppliedColumns))].sort();
  return {
    contractVersion: V8_INPUT_CONTRACT_VERSION,
    sourceContractColumnCount: 102,
    normalizedColumnCount: CANONICAL_SOURCE_COLUMNS.length, // 102 source fields + derived sector
    sourceFileCount: files.length,
    totalRows: files.reduce((sum, file) => sum + file.rows, 0),
    validForV8: missingRequired.length === 0,
    requiredColumns: [...V8_REQUIRED_COLUMNS],
    scoreCriticalColumns: ["market", "foreignNetBuyValue"],
    filesMissingRequiredColumns: missingRequired.map((file) => ({
      fileName: file.fileName,
      columns: file.missingRequiredColumns,
    })),
    completelyEmptySuppliedColumns: allEmpty,
    files,
    policy: {
      emptyOptionalColumnsAreWarnings: true,
      emptyValuesAreNeverCoercedToZero: true,
      foreignNetBuyValueMissing: "20D foreign flow becomes null; full Vf score stays null for that date",
      marketRequired: "KOSPI/KOSDAQ benchmark selection must not fall back from a missing market value",
      sectorFallback: "sector/sectorCode → reviewed symbol mapping → ETC",
      tradingValueFallback: "only close × volume when the input value is absent",
    },
  };
}
