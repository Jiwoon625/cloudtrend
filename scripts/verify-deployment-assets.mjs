import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

export async function verifyDeployment(base, expectedCommit) {
  const origin = new URL(base).origin;
  if (!expectedCommit) throw new Error("An expected commit is required");
  async function get(path, mime) {
    const url = new URL(path, origin);
    if (url.origin !== origin) throw new Error("Cross-origin asset rejected");
    const response = await fetch(url, {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`${url.pathname}: HTTP ${response.status}`);
    if (!mime.test(response.headers.get("content-type") ?? ""))
      throw new Error(`${url.pathname}: unexpected content type`);
    return response;
  }
  const manifestResponse = await get(
    `/deployment-manifest.json?commit=${encodeURIComponent(expectedCommit)}`,
    /application\/json/,
  );
  const manifest = await manifestResponse.json();
  if (manifest.commit !== expectedCommit)
    throw new Error(`Expected ${expectedCommit}, received ${manifest.commit}`);
  if (!Array.isArray(manifest.assets) || manifest.assets.length === 0)
    throw new Error("Empty asset manifest");
  const paths = new Set(manifest.assets.map((asset) => asset.path));
  for (const path of ["/", "/scoring"]) {
    const response = await get(path, /text\/html/);
    if (response.headers.get("x-cloudtrend-code-version") !== expectedCommit)
      throw new Error(`${path}: HTML is from another deployment`);
    if (!response.headers.get("cache-control")?.includes("no-store"))
      throw new Error(`${path}: HTML must not be cached`);
    const html = await response.text();
    const refs = [...html.matchAll(/(?:src|href)="([^"<>]+\.(?:js|css)(?:\?[^"<>]*)?)"/g)]
      .map((match) => new URL(match[1], origin))
      .filter((url) => url.origin === origin);
    if (
      !refs.some((url) => url.pathname.endsWith(".js")) ||
      !refs.some((url) => url.pathname.endsWith(".css"))
    )
      throw new Error(`${path}: missing JS/CSS references`);
    for (const url of refs)
      if (!paths.has(url.pathname)) throw new Error(`${path}: unlisted asset ${url.pathname}`);
  }
  let cursor = 0;
  await Promise.all(
    Array.from({ length: 5 }, async () => {
      while (cursor < manifest.assets.length) {
        const asset = manifest.assets[cursor++];
        if (!asset.path.startsWith(`/assets/${expectedCommit}/`))
          throw new Error(`Asset from another release: ${asset.path}`);
        const response = await get(
          asset.path,
          asset.path.endsWith(".css") ? /text\/css/ : /(?:application|text)\/javascript/,
        );
        const actual = createHash("sha256")
          .update(new Uint8Array(await response.arrayBuffer()))
          .digest("hex");
        if (actual !== asset.sha256) throw new Error(`Asset content mismatch: ${asset.path}`);
      }
    }),
  );
  return { commit: expectedCommit, pages: 2, verifiedAssets: manifest.assets.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyDeployment(process.argv[2], process.argv[3])
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
