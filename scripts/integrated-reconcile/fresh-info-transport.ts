/** Scoped storage metadata transport; other SDK requests retain their original arguments. */
export function freshInfoTransport(options: {
  expectedOrigin: string;
  fetch: typeof globalThis.fetch;
  nonce?: () => string;
}): typeof globalThis.fetch {
  const origin = new URL(options.expectedOrigin);
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw Error("Exact HTTPS storage origin required");
  const nonce = options.nonce ?? (() => crypto.randomUUID());
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!url.pathname.startsWith("/storage/v1/object/info/")) return options.fetch(input, init);
    if (url.origin !== origin.origin || url.username || url.password)
      throw Error("Cross-origin storage metadata request refused");
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    if (method !== "GET") return options.fetch(input, init);
    const value = nonce();
    if (!value || typeof value !== "string") throw Error("Fresh metadata nonce required");
    url.searchParams.set("cacheNonce", value);
    const original = new Request(input, init);
    const headers = new Headers(original.headers);
    headers.set("Cache-Control", "no-store, no-cache");
    headers.set("Pragma", "no-cache");
    // Request cloning preserves authorization, API key, signal and credential mode.
    const fresh = new Request(new Request(url, original), { headers, cache: "no-store" });
    return options.fetch(fresh);
  };
}
