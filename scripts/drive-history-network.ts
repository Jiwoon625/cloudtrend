/** Enforced transport boundary, not a counter that silently permits forbidden requests. */
export interface NetworkReceipt {
  allowed: Record<string, number>;
  denied: Array<{ method: string; category: string }>;
  historicalSourceGETs: number;
  supabaseWrites: number;
}
export function installDriveReadOnlyNetwork() {
  const original = globalThis.fetch;
  const receipt: NetworkReceipt = {
    allowed: {},
    denied: [],
    historicalSourceGETs: 0,
    supabaseWrites: 0,
  };
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? String(input));
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    if (url.hostname.endsWith(".supabase.co")) {
      const decoded = decodeURIComponent(url.pathname);
      const historical = /\/source\/(?:screening|us-screening)\//.test(decoded);
      const write = !["GET", "HEAD"].includes(method);
      const category = historical
        ? "historical-source"
        : write
          ? "supabase-write"
          : decoded.startsWith("/rest/")
            ? "db-read"
            : "storage-state-or-cache-read";
      if (historical || write) {
        receipt.denied.push({ method, category });
        throw new Error(`Drive validation blocked ${category}`);
      }
      receipt.allowed[category] = (receipt.allowed[category] ?? 0) + 1;
    } else receipt.allowed["other-read"] = (receipt.allowed["other-read"] ?? 0) + 1;
    return original(input, init);
  };
  return {
    receipt,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}
