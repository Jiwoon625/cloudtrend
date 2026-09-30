import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ANALYSIS_BUCKET } from "./analysis-run-store";

// Screening bundles contain plain JSON objects/arrays. Serialize each array item
// separately using native JSON semantics, without a bundle-sized JS string.
export function* screeningJsonChunks(bundle: Record<string, unknown>): Generator<string> {
  function* object(value: Record<string, unknown>): Generator<string> {
    yield "{";
    let first = true;
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined || typeof item === "function" || typeof item === "symbol") continue;
      if (!first) yield ",";
      first = false;
      yield `${JSON.stringify(key)}:`;
      if (Array.isArray(item)) {
        yield "[";
        for (let i = 0; i < item.length; i++) {
          if (i) yield ",";
          yield JSON.stringify(item[i]) ?? "null";
        }
        yield "]";
      } else if (
        item &&
        typeof item === "object" &&
        Object.getPrototypeOf(item) === Object.prototype
      ) {
        yield* object(item as Record<string, unknown>);
      } else {
        yield JSON.stringify(item);
      }
    }
    yield "}";
  }
  let chunk = "";
  for (const token of object(bundle)) {
    chunk += token;
    if (chunk.length >= 64 * 1024) {
      yield chunk;
      chunk = "";
    }
  }
  if (chunk) yield chunk;
}

export async function writeScreeningJson(filePath: string, bundle: Record<string, unknown>) {
  await pipeline(Readable.from(screeningJsonChunks(bundle)), createWriteStream(filePath));
}

export async function uploadScreeningJsonFile(
  client: SupabaseClient,
  objectPath: string,
  filePath: string,
) {
  const body = createReadStream(filePath);
  try {
    const { error } = await client.storage.from(ANALYSIS_BUCKET).upload(objectPath, body, {
      contentType: "application/json",
      upsert: true,
    });
    if (error) throw new Error(`Supabase 업로드 실패 (${objectPath}): ${error.message}`);
    return { objectPath, bytes: (await stat(filePath)).size };
  } finally {
    body.destroy();
  }
}
