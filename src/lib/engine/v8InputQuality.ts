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
  emptyRequiredColumns: string[];
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
      emptyRequiredColumns: V8_REQUIRED_COLUMNS.filter((column) =>
        completelyEmptySuppliedColumns.includes(column),
      ),
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
      foreignNetBuyValueMissing:
        "row-level nulls are allowed; the rolling 20D foreign flow and full Vf score become null for affected dates",
      marketRequired: "KOSPI/KOSDAQ benchmark selection must not fall back from a missing market column",
      sectorFallback: "sector/sectorCode → reviewed symbol mapping → ETC",
      tradingValueFallback: "only close × volume when the input value is absent",
    },
  };
}
