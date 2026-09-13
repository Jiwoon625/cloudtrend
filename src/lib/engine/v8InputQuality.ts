import { CANONICAL_SOURCE_COLUMNS, type SourceValidationResult } from "../sourceData";

export const V8_INPUT_CONTRACT_VERSION = "toss-krx-102-v2" as const;

const V8_STRUCTURAL_REQUIRED_COLUMNS = [
  "symbol",
  "date",
  "market",
  "open",
  "high",
  "low",
  "close",
  "volume",
  "tradingValue",
] as const;

export const V8_STOCK_SCORE_REQUIRED_COLUMNS = ["foreignNetBuyValue"] as const;
export const V8_REQUIRED_COLUMNS = [
  ...V8_STRUCTURAL_REQUIRED_COLUMNS,
  ...V8_STOCK_SCORE_REQUIRED_COLUMNS,
] as const;

export function v8RequiredColumnsForFile(stockCount: number): readonly string[] {
  return stockCount > 0 ? V8_REQUIRED_COLUMNS : V8_STRUCTURAL_REQUIRED_COLUMNS;
}

export interface V8InputQualityFile {
  fileName: string | null;
  rows: number;
  from: string | null;
  to: string | null;
  suppliedColumnCount: number;
  populatedColumnCount: number;
  completelyEmptySuppliedColumns: string[];
  missingRequiredColumns: string[];
  emptyRequiredColumns: string[];
  requiresStockScoreColumns: boolean;
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
    const requiredColumns = v8RequiredColumnsForFile(validation.stats.stockCount);
    return {
      fileName,
      rows: validation.stats.rowCount,
      from: validation.stats.minDate,
      to: validation.stats.maxDate,
      suppliedColumnCount: supplied.size,
      populatedColumnCount: validation.stats.populatedColumnCount,
      completelyEmptySuppliedColumns,
      missingRequiredColumns: requiredColumns.filter((column) => !supplied.has(column)),
      emptyRequiredColumns: requiredColumns.filter((column) =>
        completelyEmptySuppliedColumns.includes(column),
      ),
      requiresStockScoreColumns: validation.stats.stockCount > 0,
      sectorUnmappedCount: validation.stats.sectorUnmappedCount,
    };
  });
  const invalidRequired = files.filter(
    (file) => file.missingRequiredColumns.length > 0 || file.emptyRequiredColumns.length > 0,
  );
  const allEmpty = [...new Set(files.flatMap((file) => file.completelyEmptySuppliedColumns))].sort();
  return {
    contractVersion: V8_INPUT_CONTRACT_VERSION,
    sourceContractColumnCount: 102,
    normalizedColumnCount: CANONICAL_SOURCE_COLUMNS.length, // 102 source fields + derived sector
    sourceFileCount: files.length,
    totalRows: files.reduce((sum, file) => sum + file.rows, 0),
    validForV8: invalidRequired.length === 0,
    requiredColumns: [...V8_REQUIRED_COLUMNS],
    structuralRequiredColumns: [...V8_STRUCTURAL_REQUIRED_COLUMNS],
    stockScoreRequiredColumns: [...V8_STOCK_SCORE_REQUIRED_COLUMNS],
    scoreCriticalColumns: ["market", "foreignNetBuyValue"],
    filesInvalidRequiredColumns: invalidRequired.map((file) => ({
      fileName: file.fileName,
      missingColumns: file.missingRequiredColumns,
      emptyColumns: file.emptyRequiredColumns,
    })),
    filesMissingRequiredColumns: files
      .filter((file) => file.missingRequiredColumns.length > 0)
      .map((file) => ({ fileName: file.fileName, columns: file.missingRequiredColumns })),
    filesEmptyRequiredColumns: files
      .filter((file) => file.emptyRequiredColumns.length > 0)
      .map((file) => ({ fileName: file.fileName, columns: file.emptyRequiredColumns })),
    completelyEmptySuppliedColumns: allEmpty,
    files,
    policy: {
      emptyOptionalColumnsAreWarnings: true,
      completelyEmptyRequiredColumnsAreErrors: true,
      emptyValuesAreNeverCoercedToZero: true,
      stockScoreColumnsApplyOnlyToFilesContainingStockRows: true,
      foreignNetBuyValueMissing:
        "required for files containing STOCK rows; row-level nulls are allowed and make the rolling 20D foreign flow/full Vf score null for affected dates",
      marketRequired: "KOSPI/KOSDAQ benchmark selection must not fall back from a missing market column",
      sectorFallback: "sector/sectorCode → reviewed symbol mapping → ETC",
      tradingValueFallback: "only close × volume when the input value is absent",
    },
  };
}
