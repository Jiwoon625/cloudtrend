import { mergeScoringConfig } from "./engine/scoring";
import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import {
  installUnderlyingIndexArtifact,
  readUnderlyingIndexDiagnostics,
} from "./underlyingIndexDiagnostics.server";
const URL = import.meta.env["VITE_SUPABASE_URL"] || "https://ahbvrtugugwnbrfnbxzp.supabase.co";
const KEY =
  import.meta.env["VITE_SUPABASE_PUBLISHABLE_KEY"] ||
  "sb_publishable_j1o5NMjbXz7UA1CsbCj1dA_hiMBgBlE";
async function authenticate(accessToken: string) {
  if (accessToken.length < 20) throw new Error("로그인 세션을 확인해 주세요.");
  const client = createClient(URL, KEY, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await client.auth.getUser(accessToken);
  if (error || !data.user || data.user.is_anonymous) throw new Error("사용자 인증에 실패했습니다.");
  return { client, owner: data.user.id };
}
export const readUnderlyingIndexDiagnosticsServer = createServerFn({ method: "POST" })
  .inputValidator((input: { accessToken: string }) => ({
    accessToken: String(input.accessToken ?? ""),
  }))
  .handler(async ({ data }) => {
    const { client, owner } = await authenticate(data.accessToken);
    return readUnderlyingIndexDiagnostics(client, owner, new Date().toISOString());
  });
export const installUnderlyingIndexArtifactServer = createServerFn({ method: "POST" })
  .inputValidator(
    (input: {
      accessToken: string;
      compressedBase64: string;
      originalCompressedBase64?: string;
    }) => ({
      accessToken: String(input.accessToken ?? ""),
      compressedBase64: String(input.compressedBase64 ?? ""),
      originalCompressedBase64: input.originalCompressedBase64
        ? String(input.originalCompressedBase64)
        : undefined,
    }),
  )
  .handler(async ({ data }) => {
    const { client, owner } = await authenticate(data.accessToken);
    return installUnderlyingIndexArtifact(
      client,
      owner,
      data.compressedBase64,
      new Date().toISOString(),
      data.originalCompressedBase64,
    );
  });

export const compareOperationalIndexServer = createServerFn({ method: "POST" })
  .inputValidator((input: { accessToken: string; config?: unknown }) => ({
    accessToken: String(input.accessToken ?? ""),
    config: mergeScoringConfig(input.config),
  }))
  .handler(async ({ data }) => {
    const { client, owner } = await authenticate(data.accessToken);
    const { compareOperationalIndex } = await import("./operationalUnderlyingIndex.server");
    return compareOperationalIndex(client, owner, new Date().toISOString(), data.config);
  });
