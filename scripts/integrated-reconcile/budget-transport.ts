/** Invocation-local budgets. Counts payload bytes actually read, not sensitive URLs or bodies. */
export function budgetTransport(options: {
  expectedOrigin: string;
  fetch: typeof globalThis.fetch;
  maxBytes: number;
  maxRequests: number;
}) {
  const origin = new URL(options.expectedOrigin);
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    !Number.isSafeInteger(options.maxBytes) ||
    options.maxBytes <= 0 ||
    !Number.isSafeInteger(options.maxRequests) ||
    options.maxRequests <= 0
  )
    throw Error("Valid origin and positive bounded transport limits required");
  let bytes = 0,
    requests = 0,
    exhausted = false;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== origin.origin) return options.fetch(input, init);
    if (exhausted || requests >= options.maxRequests) {
      exhausted = true;
      throw Error("Reconciliation transport budget exhausted");
    }
    requests++;
    const response = await options.fetch(input, init);
    if (!response.body) return response;
    const reader = response.body.getReader();
    const stream = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          try {
            if (exhausted) throw Error("Reconciliation transport budget exhausted");
            const { done, value } = await reader.read();
            if (done) {
              controller.close();
              return;
            }
            if (value.byteLength > options.maxBytes - bytes) {
              exhausted = true;
              throw Error("Reconciliation transport byte budget exhausted");
            }
            bytes += value.byteLength;
            controller.enqueue(value);
          } catch (error) {
            // Cancel unread bytes without masking the primary budget/read error.
            await reader.cancel().catch(() => {});
            controller.error(error);
          }
        },
        cancel(reason) {
          return reader.cancel(reason);
        },
      },
      { highWaterMark: 0 },
    );
    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
  return { fetch, usage: () => ({ bytes, requests, exhausted }) };
}
