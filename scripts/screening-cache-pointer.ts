/**
 * Publisher-side read/write of the mutable screening/dashboard pointers.
 *
 * These two objects are stored gzip-encoded (see docs/screening-cache-gzip.md). The generic
 * `uploadJson`/`downloadJson` helpers in `analysis-run-store` stay plain because that module
 * is part of the reviewed KOSPI Shadow publication runtime; publishers that touch the
 * pointers call these functions instead.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  COMPRESSED_CACHE_CONTENT_TYPE,
  compressedCacheObjectPath,
  gzipJson,
} from "../src/lib/cacheObjectEncoding";
import { readFreshCacheObject } from "../src/lib/cacheObjectStorage";
import { ANALYSIS_BUCKET } from "./analysis-run-store";
import { retryIdempotentStorageUpload } from "./storage-upload-retry";

export async function uploadCachePointer(
  client: SupabaseClient,
  objectPath: string,
  value: unknown,
): Promise<Buffer> {
  const bytes = await gzipJson(value);
  const target = compressedCacheObjectPath(objectPath);
  await retryIdempotentStorageUpload(
    async () => {
      const { error } = await client.storage.from(ANALYSIS_BUCKET).upload(
        target,
        Buffer.from(bytes),
        {
          contentType: COMPRESSED_CACHE_CONTENT_TYPE,
          upsert: true,
          cacheControl: "0",
        },
      );
      if (error) throw error;
    },
    { bucket: ANALYSIS_BUCKET, objectPath: target, bytes: bytes.byteLength },
  );
  return Buffer.from(bytes);
}

/** Null when the pointer is absent in both encodings. */
export async function downloadCachePointer<T>(
  client: SupabaseClient,
  objectPath: string,
): Promise<T | null> {
  return readFreshCacheObject<T>(client, ANALYSIS_BUCKET, objectPath);
}
