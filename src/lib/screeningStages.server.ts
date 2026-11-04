import type { SupabaseClient } from "@supabase/supabase-js";
import { screeningStagesPath, type ScreeningStages } from "./screeningStages";

/** Small owner-private status sidecar; never changes an immutable screening archive. */
export async function saveScreeningStages(
  client: SupabaseClient,
  userId: string,
  runId: string,
  stages: ScreeningStages,
) {
  const { error } = await client.storage.from("cloudtrend-data").upload(
    screeningStagesPath(userId, runId),
    new Blob(
      [
        JSON.stringify({
          version: 1,
          runId,
          updatedAt: new Date().toISOString(),
          pipelineStatus: stages,
        }),
      ],
      { type: "application/json" },
    ),
    { upsert: true, contentType: "application/json", cacheControl: "0" },
  );
  if (error) throw new Error("스크리닝 단계별 상태 저장 실패");
}
