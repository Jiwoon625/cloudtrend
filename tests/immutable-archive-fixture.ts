/** In-memory immutable table used by publication integration tests. */
export function createImmutableArchiveFixture() {
  const rows = new Map<string, Record<string, unknown>>();
  return () => {
    const filters = new Map<string, unknown>();
    const query = {
      select: () => query,
      eq: (key: string, value: unknown) => {
        filters.set(key, value);
        return query;
      },
      upsert: async (row: Record<string, unknown>, options: { ignoreDuplicates?: boolean }) => {
        if (!options.ignoreDuplicates) throw new Error("Archive must be immutable");
        const key = JSON.stringify([row.user_id, row.run_id]);
        if (!rows.has(key)) rows.set(key, structuredClone(row));
        return { error: null };
      },
      single: async () => {
        const data = rows.get(JSON.stringify([filters.get("user_id"), filters.get("run_id")]));
        return { data: data ?? null, error: data ? null : { message: "Missing archive" } };
      },
    };
    return query;
  };
}
