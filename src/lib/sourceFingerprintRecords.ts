/** Registry queries return calculation precedence order; identity must retain that order. */
export function sourceFingerprintRecords(
  sources: ReadonlyArray<{
    id: string;
    data_hash: string;
    schema_hash: string;
    activated_at: string | null;
    created_at?: string;
    validation_result?: unknown;
  }>,
) {
  return sources.map((source) => ({
    ...((source.validation_result as { krPublication?: unknown } | undefined)?.krPublication
      ? { krPublication: (source.validation_result as { krPublication: unknown }).krPublication }
      : {}),
    id: source.id,
    dataHash: source.data_hash,
    schemaHash: source.schema_hash,
    activatedAt: source.activated_at,
    createdAt: source.created_at ?? null,
  }));
}
