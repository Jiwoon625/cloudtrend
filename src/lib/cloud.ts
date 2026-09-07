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
const BUCKET = "cloudtrend-data";
/** 파일 1개 크기 상한(무료 플랜의 파일당 50MB 제한 보호). 전체 개수는 제한하지 않는다. */
export const MAX_FILE_BYTES = 45 * 1024 * 1024;

function isMissing(error: { statusCode?: string; message: string }) {
  return String(error.statusCode) === "404" || error.message === "Object not found";
}

/** 로그인한 계정 폴더 기준 경로를 만든다. */
export async function ownerPath(relative: string) {
  return `${await userId()}/${relative}`;
}

export async function readObject<T>(path: string): Promise<T | null> {
  const { data, error } = await supabase.storage.from(BUCKET).download(path);
  if (error) {
    if (isMissing(error as { statusCode?: string; message: string })) return null;
    throw new Error(`클라우드 파일을 불러오지 못했습니다: ${error.message}`);
  }
  return JSON.parse(await data.text()) as T;
}

export async function writeObject(path: string, value: unknown) {
  const body = new Blob([JSON.stringify(value)], { type: "application/json" });
  if (body.size > MAX_FILE_BYTES)
    throw new Error("파일 1개 크기는 45MB 이하여야 합니다. 파일을 나눠 여러 개로 올려 주세요.");
  const { error } = await supabase.storage.from(BUCKET).upload(path, body, {
    upsert: true,
    contentType: "application/json",
  });
  if (error) throw new Error(`클라우드 저장 실패: ${error.message}`);
}

export async function removeObjects(paths: string[]) {
  if (paths.length === 0) return;
  const { error } = await supabase.storage.from(BUCKET).remove(paths);
  if (error) throw error;
}

export async function readFile<M>(kind: DatasetKind): Promise<CloudFile<M> | null> {
  return readObject<CloudFile<M>>(await ownerPath(`${kind}.json`));
}
export async function writeFile<M>(kind: DatasetKind, value: CloudFile<M>) {
  await writeObject(await ownerPath(`${kind}.json`), value);
}
export async function removeFile(kind: DatasetKind) {
  await removeObjects([await ownerPath(`${kind}.json`)]);
}
