/** Invocation-local cache: never substitutes a cached value for a fresh generation probe. */
export interface StrongGeneration {
  /** Callers must assert that both fields identify an immutable storage object generation. */
  kind: "strong";
  objectId: string;
  version: string;
  etag: string;
  size: number;
}
export type GenerationProbe = StrongGeneration | { kind: "weak" } | null;
function strong(value: GenerationProbe): value is StrongGeneration {
  return (
    value?.kind === "strong" &&
    typeof value.objectId === "string" &&
    value.objectId.trim().length > 0 &&
    typeof value.version === "string" &&
    value.version.trim().length > 0 &&
    typeof value.etag === "string" &&
    value.etag.trim().length > 0 &&
    Number.isSafeInteger(value.size) &&
    value.size >= 0
  );
}
function same(a: StrongGeneration, b: StrongGeneration) {
  return (
    a.objectId === b.objectId && a.version === b.version && a.etag === b.etag && a.size === b.size
  );
}
/** Each instance belongs to one invocation and one immutable object key. Values must not be mutated. */
export function generationCachedLoader<T>(options: {
  probe: () => Promise<GenerationProbe>;
  /** Must fully validate content, provenance and hash before returning a non-null value. */
  loadValidated: () => Promise<T | null>;
}) {
  let cached: { generation: StrongGeneration; value: T } | null = null;
  return async (): Promise<T | null> => {
    const before = await options.probe();
    if (strong(before) && cached && same(before, cached.generation)) return cached.value;
    // Drop stale entries even when validation or a probe subsequently fails.
    cached = null;
    const value = await options.loadValidated();
    const after = await options.probe();
    if (strong(before)) {
      if (!strong(after) || !same(before, after))
        throw Error("Storage generation changed during validated read");
      if (value !== null) cached = { generation: { ...after }, value };
    }
    // Missing objects and weak/unavailable metadata are deliberately never cached.
    return value;
  };
}
