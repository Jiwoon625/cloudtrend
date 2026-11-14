/**
 * One-time migration of the mutable screening/dashboard pointers to their gzip objects.
 *
 *   npx vite-node --script scripts/migrate-screening-cache-gzip.ts            # dry run (reads only)
 *   npx vite-node --script scripts/migrate-screening-cache-gzip.ts --apply    # write *.json.gz
 *   npx vite-node --script scripts/migrate-screening-cache-gzip.ts --apply --prune-legacy
 *
 * The uncompressed object is deleted only after the compressed object has been written and
 * read back with identical content, and only with an explicit `--prune-legacy`, because open
 * tabs and a not-yet-redeployed runner still read the uncompressed object as their fallback.
 *
 * Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY: the migration must not depend on a
 * browser session, and it verifies through a fresh, CDN-bypassing read.
 */
import process from "node:process";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  COMPRESSED_CACHE_CONTENT_TYPE,
  COMPRESSED_CACHE_OBJECT_TAILS,
  compressedCacheObjectPath,
  gunzipJson,
  gzipJson,
  sha256Hex,
} from "../src/lib/cacheObjectEncoding";
import { decodeCacheBytes, downloadFreshBytes } from "../src/lib/cacheObjectStorage";
import { stableCacheJson } from "../src/lib/screeningCacheContract";
import { ANALYSIS_BUCKET, trustedSupabaseClient } from "./analysis-run-store";

const OWNER = process.env["SUPABASE_USER_ID"] ?? "bdfc8818-33a7-4030-9dbd-ecad39f223ac";
const APPLY = process.argv.includes("--apply");
const PRUNE_LEGACY = process.argv.includes("--prune-legacy");

type Outcome = {
  object: string;
  state: "DRY_RUN" | "ALREADY_COMPRESSED" | "MIGRATED" | "PRUNED_LEGACY" | "NO_LEGACY";
  legacyBytes: number | null;
  gzipBytes: number | null;
  saving: string | null;
};

function saving(compressed: number, plain: number) {
  return `${(((plain - compressed) / plain) * 100).toFixed(1)}% 절감 (${plain} → ${compressed} bytes)`;
}

async function removeLegacy(
  client: SupabaseClient,
  legacyPath: string,
  gzipPath: string,
  expected: unknown,
) {
  const legacy = await downloadFreshBytes(client, ANALYSIS_BUCKET, legacyPath);
  if (!legacy) return false;
  if (stableCacheJson(await decodeCacheBytes(legacy)) !== stableCacheJson(expected))
    throw new Error(
      `${legacyPath} 내용이 압축 객체와 다릅니다. 살아 있는 대체본은 지우지 않습니다.`,
    );
  const { error } = await client.storage.from(ANALYSIS_BUCKET).remove([legacyPath]);
  if (error) throw new Error(`legacy 삭제 실패: ${error.message}`);
  if (await downloadFreshBytes(client, ANALYSIS_BUCKET, legacyPath))
    throw new Error(`${legacyPath}가 삭제 후에도 남아 있습니다.`);
  if (!(await downloadFreshBytes(client, ANALYSIS_BUCKET, gzipPath)))
    throw new Error(`${gzipPath}를 다시 읽지 못했습니다.`);
  return true;
}

async function migrateOne(client: SupabaseClient, tail: string): Promise<Outcome> {
  const legacyPath = `${OWNER}/${tail}`;
  const gzipPath = compressedCacheObjectPath(legacyPath);
  const existingGzip = await downloadFreshBytes(client, ANALYSIS_BUCKET, gzipPath);
  if (existingGzip) {
    const stored = await gunzipJson<unknown>(existingGzip);
    if (PRUNE_LEGACY) {
      const legacy = await downloadFreshBytes(client, ANALYSIS_BUCKET, legacyPath);
      const pruned = await removeLegacy(client, legacyPath, gzipPath, stored);
      if (pruned)
        return {
          object: tail,
          state: "PRUNED_LEGACY",
          legacyBytes: legacy?.byteLength ?? null,
          gzipBytes: existingGzip.byteLength,
          saving: legacy ? saving(existingGzip.byteLength, legacy.byteLength) : null,
        };
    }
    return {
      object: tail,
      state: "ALREADY_COMPRESSED",
      legacyBytes: null,
      gzipBytes: existingGzip.byteLength,
      saving: null,
    };
  }

  const legacy = await downloadFreshBytes(client, ANALYSIS_BUCKET, legacyPath);
  if (!legacy) {
    return { object: tail, state: "NO_LEGACY", legacyBytes: null, gzipBytes: null, saving: null };
  }
  const value = await decodeCacheBytes<unknown>(legacy);
  const bytes = await gzipJson(value);
  if (!APPLY)
    return {
      object: tail,
      state: "DRY_RUN",
      legacyBytes: legacy.byteLength,
      gzipBytes: bytes.byteLength,
      saving: saving(bytes.byteLength, legacy.byteLength),
    };

  const { error } = await client.storage
    .from(ANALYSIS_BUCKET)
    .upload(gzipPath, Buffer.from(bytes), {
      upsert: true,
      contentType: COMPRESSED_CACHE_CONTENT_TYPE,
      cacheControl: "0",
    });
  if (error) throw new Error(`압축 캐시 저장 실패 (${gzipPath}): ${error.message}`);
  const stored = await downloadFreshBytes(client, ANALYSIS_BUCKET, gzipPath);
  if (!stored || (await sha256Hex(stored)) !== (await sha256Hex(bytes)))
    throw new Error(`${gzipPath} 저장 후 재검증에 실패했습니다. legacy는 그대로 둡니다.`);
  if (stableCacheJson(await gunzipJson<unknown>(stored)) !== stableCacheJson(value))
    throw new Error(`${gzipPath} 내용이 원본과 다릅니다. legacy는 그대로 둡니다.`);

  if (PRUNE_LEGACY) await removeLegacy(client, legacyPath, gzipPath, value);
  return {
    object: tail,
    state: PRUNE_LEGACY ? "PRUNED_LEGACY" : "MIGRATED",
    legacyBytes: legacy.byteLength,
    gzipBytes: bytes.byteLength,
    saving: saving(bytes.byteLength, legacy.byteLength),
  };
}

async function main() {
  if (PRUNE_LEGACY && !APPLY)
    throw new Error(
      "--prune-legacy는 --apply와 함께만 쓸 수 있습니다. 먼저 gzip 저장을 검증해야 합니다.",
    );
  const client = trustedSupabaseClient();
  console.log(JSON.stringify({ owner: OWNER, apply: APPLY, pruneLegacy: PRUNE_LEGACY }));
  const outcomes: Outcome[] = [];
  for (const tail of COMPRESSED_CACHE_OBJECT_TAILS) outcomes.push(await migrateOne(client, tail));
  for (const outcome of outcomes)
    console.log(`${outcome.object}: ${outcome.state}${outcome.saving ? ` · ${outcome.saving}` : ""}`);
  console.log(JSON.stringify({ outcomes }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
