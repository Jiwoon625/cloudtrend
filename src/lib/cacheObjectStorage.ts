import type { SupabaseClient } from "@supabase/supabase-js";
import {
  COMPRESSED_CACHE_CONTENT_TYPE,
  compressedCacheObjectPath,
  gunzipJson,
  gzipJson,
  isGzipEncoded,
} from "./cacheObjectEncoding";
import { downloadFreshObject } from "./freshStorage";

/** Mutable pointers must bypass the CDN, so every cache read is a fresh, uncached GET. */
export async function downloadFreshBytes(
  client: SupabaseClient,
  bucket: string,
  path: string,
): Promise<Uint8Array | null> {
  const { data, error } = await downloadFreshObject(client, bucket, path);
  if (error) {
    if (isMissingObject(error as { statusCode?: string; message: string })) return null;
    throw error;
  }
  return data ? new Uint8Array(await data.arrayBuffer()) : null;
}

function isMissingObject(error: { statusCode?: string; message: string }) {
  return String(error.statusCode) === "404" || /object not found|not_found|404/i.test(error.message);
}

/**
 * Reads one mutable cache pointer. The compressed object is authoritative; the plain
 * object is the pre-migration body an older deploy still writes, so a read must keep
 * working while a publication or a deployment is only half-way through the change.
 */
export async function readFreshCacheObject<T>(
  client: SupabaseClient,
  bucket: string,
  path: string,
): Promise<T | null> {
  let compressedError: unknown = null;
  try {
    const compressed = await downloadFreshBytes(client, bucket, compressedCacheObjectPath(path));
    if (compressed) return await gunzipJson<T>(compressed);
  } catch (error) {
    // A damaged or half-written compressed body must not hide a readable fallback.
    compressedError = error;
    console.warn(
      `압축 캐시를 읽지 못했습니다. 기존 캐시로 대체합니다: ${compressedCacheObjectPath(path)}`,
      error,
    );
  }
  let legacy: Uint8Array | null = null;
  try {
    legacy = await downloadFreshBytes(client, bucket, path);
  } catch (error) {
    if (compressedError) throw compressedError;
    throw error;
  }
  if (!legacy) {
    if (compressedError) throw compressedError;
    return null;
  }
  // A body that is gzip despite its plain name is read too, so an encoding decision
  // made by a newer writer is never mistaken for corrupt JSON.
  return decodeCacheBytes<T>(legacy);
}

/** Decodes a stored cache body by its magic bytes rather than by its object name. */
export async function decodeCacheBytes<T>(bytes: Uint8Array): Promise<T> {
  if (isGzipEncoded(bytes)) return gunzipJson<T>(bytes);
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

/**
 * Writes the compressed pointer. The uncompressed object is left in place: an open
 * publication may still verify it, and dropping it is a separate, explicit migration
 * step (`scripts/migrate-screening-cache-gzip.ts`) that only runs after a verified read.
 */
export async function writeFreshCacheObject(
  client: SupabaseClient,
  bucket: string,
  path: string,
  value: unknown,
): Promise<number> {
  const bytes = await gzipJson(value);
  const target = compressedCacheObjectPath(path);
  const { error } = await client.storage.from(bucket).upload(
    target,
    new Blob([bytes as BlobPart], { type: COMPRESSED_CACHE_CONTENT_TYPE }),
    {
      upsert: true,
      contentType: COMPRESSED_CACHE_CONTENT_TYPE,
      cacheControl: "0",
    },
  );
  if (error) throw new Error(`압축 캐시 저장 실패 (${target}): ${error.message}`);
  return bytes.byteLength;
}
