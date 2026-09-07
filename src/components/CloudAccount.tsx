import { useEffect, useState, type ReactNode } from "react";
import { supabase } from "@/lib/cloud";
import { hydrateManualData } from "@/lib/manualDataStore";
import { hydrateUsData } from "@/lib/usDataStore";
import { hydrateSnapshots } from "@/lib/screeningHistory";

export function CloudAccount({ children }: { children: ReactNode }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [account, setAccount] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    let alive = true;
    let previous: string | null | undefined;
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      const id = session?.user.id ?? null;
      if (previous !== undefined && previous !== id) {
        window.location.reload();
        return;
      }
      previous = id;
      if (alive) setAccount(session?.user.email ?? null);
    });
    void supabase.auth
      .getSession()
      .then(async ({ data, error }) => {
        if (error) throw error;
        if (data.session)
          await Promise.all([hydrateManualData(), hydrateUsData(), hydrateSnapshots()]);
        if (alive) setReady(true);
      })
      .catch((e: Error) => {
        if (alive) setMessage(e.message);
      });
    return () => {
      alive = false;
      subscription.unsubscribe();
    };
  }, []);
  async function authenticate(signUp: boolean) {
    setBusy(true);
    setMessage("");
    try {
      const { error } = signUp
        ? await supabase.auth.signUp({ email, password })
        : await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      if (signUp) setMessage("가입 확인 이메일을 확인한 뒤 이 화면에서 로그인해 주세요.");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "로그인 실패");
    } finally {
      setBusy(false);
    }
  }
  if (!ready && !message) return <p className="p-8">클라우드 데이터 불러오는 중…</p>;
  if (account && ready)
    return (
      <>
        <div className="flex flex-wrap items-center gap-3 border-b p-2 text-xs">
          <span>클라우드 · {account}</span>
          <button onClick={() => window.location.reload()}>다른 기기의 최신 데이터 불러오기</button>
          <button
            onClick={() =>
              void supabase.auth.signOut().then(({ error }) => {
                if (error) setMessage(error.message);
              })
            }
          >
            로그아웃
          </button>
          {message && <span role="alert">{message}</span>}
        </div>
        {children}
      </>
    );
  return (
    <main className="mx-auto max-w-md space-y-4 p-8">
      <h1 className="text-xl font-bold">CloudTrend 로그인</h1>
      <p>같은 계정으로 로그인하면 어느 기기에서든 CSV와 스크리닝 이력을 불러옵니다.</p>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void authenticate(false);
        }}
      >
        <label className="block">
          이메일
          <input
            className="w-full rounded border bg-background p-2"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className="block">
          비밀번호
          <input
            className="w-full rounded border bg-background p-2"
            type="password"
            minLength={8}
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <button className="rounded border p-2" disabled={busy} type="submit">
          로그인
        </button>{" "}
        <button
          className="rounded border p-2"
          disabled={busy || !email || password.length < 8}
          type="button"
          onClick={() => void authenticate(true)}
        >
          처음 사용 · 회원가입
        </button>
      </form>
      {message && <p role="alert">{message}</p>}
      {account && <button onClick={() => window.location.reload()}>불러오기 재시도</button>}
      <p className="text-xs text-muted-foreground">
        무료 플랜 · CSV 종류별 최신 파일 1개(저장 크기 45MB 이하), 이력 최근 90개 날짜. 기존 기기
        파일은 로그인 후 다시 업로드해 주세요.
      </p>
    </main>
  );
}
