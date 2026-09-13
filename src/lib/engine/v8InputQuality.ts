import { CANONICAL_SOURCE_COLUMNS, type SourceValidationResult } from "../sourceData";

export const V8_INPUT_CONTRACT_VERSION = "toss-krx-102-v1" as const;

const REQUIRED_FOR_V8 = [
  "symbol", "date", "open", "high", "low", "close", "volume", "tradingValue",
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
      missingRequiredColumns: REQUIRED_FOR_V8.filter((column) => !supplied.has(column)),
      sectorUnmappedCount: validation.stats.sectorUnmappedCount,
    };
  });
  const missingRequired = files.filter((file) => file.missingRequiredColumns.length > 0);
  const allEmpty = [...new Set(files.flatMap((file) => file.completelyEmptySuppliedColumns))].sort();
  return {
    contractVersion: V8_INPUT_CONTRACT_VERSION,
    canonicalColumnCount: CANONICAL_SOURCE_COLUMNS.length,
    sourceFileCount: files.length,
    totalRows: files.reduce((sum, file) => sum + file.rows, 0),
    validForV8: missingRequired.length === 0,
    filesMissingRequiredColumns: missingRequired.map((file) => ({
      fileName: file.fileName,
      columns: file.missingRequiredColumns,
    })),
    completelyEmptySuppliedColumns: allEmpty,
    files,
    policy: {
      emptyOptionalColumnsAreWarnings: true,
      emptyValuesAreNeverCoercedToZero: true,
      sectorFallback: "sector/sectorCode → reviewed symbol mapping → ETC",
      tradingValueFallback: "only close × volume when the input value is absent",
    },
  };
}

