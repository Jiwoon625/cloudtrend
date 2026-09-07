import { createClient } from "@supabase/supabase-js";

// Publishable credentials only. Authorization is enforced by Supabase RLS.
export const supabase = createClient(
  import.meta.env["VITE_SUPABASE_URL"] || "https://ahbvrtugugwnbrfnbxzp.supabase.co",
  import.meta.env["VITE_SUPABASE_PUBLISHABLE_KEY"] ||
    "sb_publishable_j1o5NMjbXz7UA1CsbCj1dA_hiMBgBlE",
);
export async function userId() {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  if (!data.session) throw new Error("먼저 로그인해 주세요.");
  return data.session.user.id;
}
export type DatasetKind = "kr" | "us" | "backtest";
export interface CloudFile<M> {
  text: string;
  meta: M;
}
export async function readFile<M>(kind: DatasetKind): Promise<CloudFile<M> | null> {
  const path = `${await userId()}/${kind}.json`;
  const { data, error } = await supabase.storage.from("cloudtrend-data").download(path);
  if (error) {
    if (
      String((error as { statusCode?: string }).statusCode) === "404" ||
      error.message === "Object not found"
    )
      return null;
    throw new Error(`클라우드 파일을 불러오지 못했습니다: ${error.message}`);
  }
  return JSON.parse(await data.text()) as CloudFile<M>;
}
export async function writeFile<M>(kind: DatasetKind, value: CloudFile<M>) {
  const body = new Blob([JSON.stringify(value)], { type: "application/json" });
  if (body.size > 45 * 1024 * 1024)
    throw new Error("무료 저장 한도 보호: 파일과 메타정보 합계는 45MB 이하여야 합니다.");
  const { error } = await supabase.storage
    .from("cloudtrend-data")
    .upload(`${await userId()}/${kind}.json`, body, {
      upsert: true,
      contentType: "application/json",
    });
  if (error) throw new Error(`클라우드 저장 실패: ${error.message}`);
}
export async function removeFile(kind: DatasetKind) {
  const { error } = await supabase.storage
    .from("cloudtrend-data")
    .remove([`${await userId()}/${kind}.json`]);
  if (error) throw error;
}
