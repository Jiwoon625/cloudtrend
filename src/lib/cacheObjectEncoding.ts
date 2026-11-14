/**
 * Mutable screening/dashboard pointers are stored gzip-encoded.
 *
 * The stored payload schema is unchanged; only the storage encoding is (see
 * docs/screening-cache-gzip.md). The uncompressed `latest.json` object stays
 * readable for the migration period: a tab or a runner deployed before this
 * change still reads and writes it, and a publication may still have only the
 * old object. Every reader therefore asks for the `.json.gz` object first and
 * falls back to the uncompressed object.
 */
export const COMPRESSED_CACHE_OBJECT_TAILS = [
  "cache/screening/latest.json",
  "cache/dashboard/latest.json",
] as const;

/**
 * The bucket MIME allowlist accepts `application/octet-stream` (already used by the
 * instrument and chart caches) but not `application/gzip`, so compressed bodies are
 * stored as opaque bytes and decoded by the reader.
 */
export const COMPRESSED_CACHE_CONTENT_TYPE = "application/octet-stream";

export function isCompressedCacheObject(path: string): boolean {
  return COMPRESSED_CACHE_OBJECT_TAILS.some((tail) => path === tail || path.endsWith(`/${tail}`));
}

export function compressedCacheObjectPath(path: string): string {
  return `${path}.gz`;
}

export function isGzipEncoded(bytes: Uint8Array): boolean {
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

export async function gzipJson(value: unknown): Promise<Uint8Array> {
  if (typeof CompressionStream === "undefined")
    throw new Error("이 브라우저는 gzip 캐시 생성을 지원하지 않습니다.");
  const stream = new Blob([JSON.stringify(value)], { type: "application/json" })
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function gunzipJson<T>(bytes: Uint8Array): Promise<T> {
  if (typeof DecompressionStream === "undefined")
    throw new Error("이 브라우저는 gzip 캐시 해제를 지원하지 않습니다.");
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(await new Response(stream).text()) as T;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}
