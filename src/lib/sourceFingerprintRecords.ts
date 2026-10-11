/** Registry queries return calculation precedence order; identity must retain that order. */
export function sourceFingerprintRecords(
  sources: ReadonlyArray<{
    id: string;
    data_hash: string;
    schema_hash: string;
    activated_at: string | null;
    created_at?: string;
  }>,
) {
  return sources.map((source) => ({
    id: source.id,
    dataHash: source.data_hash,
    schemaHash: source.schema_hash,
    activatedAt: source.activated_at,
    createdAt: source.created_at ?? null,
  }));
}
