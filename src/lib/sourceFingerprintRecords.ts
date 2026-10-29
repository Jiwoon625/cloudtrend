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
    ...((source.validation_result as { krLifecycle?: unknown } | undefined)?.krLifecycle
      ? { krLifecycle: (source.validation_result as { krLifecycle: unknown }).krLifecycle }
      : {}),
    id: source.id,
    dataHash: source.data_hash,
    schemaHash: source.schema_hash,
    activatedAt: source.activated_at,
    createdAt: source.created_at ?? null,
  }));
}
