/** Local repair-only failure diagnostics. No retries, credential changes, or raw error logging. */
const LIMIT = 2048;
const PATHS = new Set([
  "/rest/v1/portfolio_ledgers",
  "/rest/v1/portfolio_trades",
  "/rest/v1/us_actual_portfolio_ledgers",
  "/rest/v1/actual_entry_decisions",
  "/rest/v1/portfolio_settings",
  "/rest/v1/portfolio_signal_log",
  "/rest/v1/us_portfolio_trades",
  "/rest/v1/us_portfolio_snapshots",
  "/rest/v1/ledger_provenance_archive",
  "/rest/v1/ledger_model_series",
  "/rest/v1/ledger_model_sessions",
  "/rest/v1/analysis_source_files",
  "/rest/v1/shadow_replay_audit",
]);
const CODES: Record<string, string> = {
  PGRST303: "JWT_CLAIMS",
  PGRST301: "JWT_INVALID",
  "42501": "PERMISSIONS",
};
const MESSAGES: Record<string, string> = {
  "JWT issued at future": "JWT_ISSUED_AT_FUTURE",
  "JWT expired": "JWT_EXPIRED",
  "JWT not yet valid": "JWT_NOT_YET_VALID",
};
export type SafeReadDiagnostic = {
  event: "INTEGRATED_GAP_READ_FAILURE";
  path: string;
  method: "GET" | "HEAD";
  status: number;
  observedAt: string;
  codeCategory: string;
  messageCategory: string;
  bodyCategory: "JSON" | "OVERSIZED" | "UNREADABLE";
  responseDate?: string;
  requestId?: string;
};
async function boundedError(response: Response): Promise<{
  bodyCategory: SafeReadDiagnostic["bodyCategory"];
  codeCategory: string;
  messageCategory: string;
}> {
  const fallback = {
    bodyCategory: "UNREADABLE" as const,
    codeCategory: "OTHER",
    messageCategory: "OTHER",
  };
  const reader = response.clone().body?.getReader();
  if (!reader) return fallback;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const consume = async () => {
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        bytes += result.value.byteLength;
        if (bytes > LIMIT) return { ...fallback, bodyCategory: "OVERSIZED" as const };
        chunks.push(result.value);
      }
      const buffer = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) {
        buffer.set(chunk, offset);
        offset += chunk.length;
      }
      const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
      const object =
        parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
      return {
        bodyCategory: "JSON" as const,
        codeCategory:
          typeof object.code === "string" && Object.hasOwn(CODES, object.code)
            ? CODES[object.code]
            : "OTHER",
        messageCategory:
          typeof object.message === "string" && Object.hasOwn(MESSAGES, object.message)
            ? MESSAGES[object.message]
            : "OTHER",
      };
    };
    return await Promise.race([
      consume(),
      new Promise<typeof fallback>((resolve) => {
        timer = setTimeout(() => resolve(fallback), 1000);
      }),
    ]);
  } catch {
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
    // Awaiting cancellation of a tee branch can wait for the untouched original body.
    void reader.cancel().catch(() => undefined);
  }
}
/** Passes original arguments and response through unchanged, calls fetch exactly once. */
export function diagnosticFetch(
  base: typeof fetch,
  emit: (record: SafeReadDiagnostic) => void = (record) => console.error(JSON.stringify(record)),
): typeof fetch {
  return async (input, init) => {
    const response = await base(input, init);
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    if (response.ok || (method !== "GET" && method !== "HEAD")) return response;
    try {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const record: SafeReadDiagnostic = {
        event: "INTEGRATED_GAP_READ_FAILURE",
        path: PATHS.has(url.pathname) ? url.pathname : "OTHER",
        method,
        status: response.status,
        observedAt: new Date().toISOString(),
        ...(await boundedError(response)),
      };
      const date = response.headers.get("date");
      if (
        date &&
        /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(
          date,
        ) &&
        Number.isFinite(Date.parse(date)) &&
        new Date(date).toUTCString() === date
      )
        record.responseDate = date;
      const id = response.headers.get("sb-request-id");
      if (id && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(id))
        record.requestId = id.toLowerCase();
      emit(record);
    } catch {
      // Diagnostics cannot change the transport's original response or failure semantics.
    }
    return response;
  };
}

const DIAGNOSTIC_PATHS = [
  "/rest/v1/analysis_source_files",
  "/rest/v1/ledger_model_sessions",
  "/rest/v1/ledger_model_series",
  "/rest/v1/portfolio_ledgers",
  "/rest/v1/us_actual_portfolio_ledgers",
] as const;
/** One read-only minimal projection on each of five initial snapshot paths. */
export function diagnosticSnapshotFetch(
  base: typeof fetch,
  origin: string,
  owner: string,
  emit?: (record: SafeReadDiagnostic) => void,
): typeof fetch {
  const report = diagnosticFetch(base, emit);
  const seen = new Set<string>();
  let failed = false;
  return async (input, init) => {
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    const url = new URL(input instanceof Request ? input.url : String(input));
    const entries = [...url.searchParams.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    if (
      failed ||
      seen.size >= 5 ||
      seen.has(url.pathname) ||
      !["GET", "HEAD"].includes(method) ||
      url.origin !== new URL(origin).origin ||
      url.username ||
      url.password ||
      url.hash ||
      !(DIAGNOSTIC_PATHS as readonly string[]).includes(url.pathname) ||
      JSON.stringify(entries) !==
        JSON.stringify([
          ["limit", "1"],
          ["select", "user_id"],
          ["user_id", "eq." + owner],
        ])
    )
      throw new Error("INTEGRATED_GAP_DIAGNOSTIC_SCOPE_REJECTED");
    seen.add(url.pathname);
    try {
      const response = await report(input, init);
      if (!response.ok) failed = true;
      return response;
    } catch (error) {
      failed = true;
      throw error;
    }
  };
}
export async function runDiagnosticRead(
  connection: { origin: string; owner: string; key: string },
  base: typeof fetch = fetch,
  emit?: (record: SafeReadDiagnostic) => void,
) {
  const origin = new URL(connection.origin);
  if (
    origin.protocol !== "https:" ||
    !/^[a-z0-9]+\.supabase\.co$/.test(origin.hostname) ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password ||
    origin.port ||
    !connection.key ||
    !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(connection.owner)
  )
    throw new Error("INTEGRATED_GAP_DIAGNOSTIC_CONNECTION_REJECTED");
  const read = diagnosticSnapshotFetch(base, connection.origin, connection.owner, emit);
  await Promise.all(
    DIAGNOSTIC_PATHS.map(async (path) => {
      const url = new URL(path, connection.origin);
      url.search = new URLSearchParams({
        select: "user_id",
        user_id: "eq." + connection.owner,
        limit: "1",
      }).toString();
      const response = await read(url, {
        method: "GET",
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
        headers: {
          apikey: connection.key,
          Authorization: "Bearer " + connection.key,
          "Cache-Control": "no-cache",
          "Accept-Encoding": "identity",
        },
      });
      if (
        !response.ok ||
        response.redirected ||
        (response.url && new URL(response.url).origin !== origin.origin)
      )
        throw new Error("INTEGRATED_GAP_DIAGNOSTIC_READ_FAILED");
      const reader = response.body?.getReader();
      if (!reader) throw new Error("INTEGRATED_GAP_DIAGNOSTIC_BODY_REJECTED");
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > 4096) throw new Error("INTEGRATED_GAP_DIAGNOSTIC_BODY_REJECTED");
          chunks.push(part.value);
        }
        const buffer = new Uint8Array(bytes);
        let offset = 0;
        for (const chunk of chunks) {
          buffer.set(chunk, offset);
          offset += chunk.length;
        }
        const data: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
        if (
          !Array.isArray(data) ||
          data.length > 1 ||
          data.some(
            (row) =>
              !row ||
              typeof row !== "object" ||
              Object.keys(row).length !== 1 ||
              row.user_id !== connection.owner,
          )
        )
          throw new Error("INTEGRATED_GAP_DIAGNOSTIC_BODY_REJECTED");
      } finally {
        void reader.cancel().catch(() => undefined);
      }
    }),
  );
}
