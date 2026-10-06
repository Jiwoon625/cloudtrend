import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { format } from "prettier";
import {
  ADOPTED_SHADOW_FROZEN_CODE_HASH,
  adoptedShadowFrozenCodeHash,
  REVIEWED_SHADOW_RUNTIME_CODE_HASHES,
  shadowEngineManifest,
  shadowExecutableSyntax,
} from "../../../scripts/october-shadow-code-manifest";

function executableHash(content: string) {
  return createHash("sha256").update(shadowExecutableSyntax(content).canonicalSyntax).digest("hex");
}

describe("canonical executable syntax", () => {
  it("ignores layout, comments, erased types, arrow parentheses, and trailing list commas", () => {
    const compact = `export const compute = (rows: number[]) => rows.map(x=>({value:x+1}));
export function empty(){}; export const list=[1,2];`;
    const formatted = `// Reviewed calculation; layout is not part of the contract.
export const compute = (
  rows: Array<number>,
) => rows.map(
  (x) => ({
    value: x + 1,
  }),
);
export function empty() {

};
export const list = [
  1,
  2,
];`;
    expect(executableHash(formatted)).toBe(executableHash(compact));
    expect(executableHash(formatted.replaceAll("\n", "\r\n"))).toBe(executableHash(compact));
  });

  it("ignores expression layout without altering regex or nested template chunks", () => {
    const compact =
      'export const result=tag` a ${/a b/g.test(value)?` x ${value+1} y `:" z "} b `;';
    const formatted = `export const result = tag\` a \${
      /a b/g.test(value)
        ? \` x \${value + 1} y \`
        : " z "
    } b \`;`;
    expect(executableHash(formatted)).toBe(executableHash(compact));
  });

  it.each([
    ["numeric literal", "export const budget = 5000;", "export const budget = 5001;"],
    ["string whitespace", 'export const label = "a b";', 'export const label = "ab";'],
    [
      "string escape",
      String.raw`export const label = "a\nb";`,
      String.raw`export const label = "a\\nb";`,
    ],
    ["regex whitespace", "export const match = /a b/g;", "export const match = /ab/g;"],
    ["regex flags", "export const match = /ab/g;", "export const match = /ab/i;"],
    [
      "regex escape",
      String.raw`export const match = /\s+/;`,
      String.raw`export const match = /s+/;`,
    ],
    ["template whitespace", "export const label = `a b`;", "export const label = `ab`;"],
    [
      "template interpolation",
      "export const label = `a ${x + 1} b`;",
      "export const label = `a ${x + 2} b`;",
    ],
    [
      "tagged template raw escape",
      String.raw`export const label = tag\`a\nb\`;`.replaceAll("\\`", "`"),
      String.raw`export const label = tag\`a\\nb\`;`.replaceAll("\\`", "`"),
    ],
    ["var versus let", "export var count = 1;", "export let count = 1;"],
    ["let versus const", "export let count = 1;", "export const count = 1;"],
    [
      "async modifier",
      "export function value() { return 1; }",
      "export async function value() { return 1; }",
    ],
    [
      "generator modifier",
      "export function value() { return 1; }",
      "export function* value() { return 1; }",
    ],
    [
      "yield delegation",
      "export function* value() { yield rows; }",
      "export function* value() { yield* rows; }",
    ],
    [
      "optional property access",
      "export const value = row.price;",
      "export const value = row?.price;",
    ],
    ["optional call", "export const value = row.price();", "export const value = row.price?.();"],
    [
      "optional chain location",
      "export const value = row?.price();",
      "export const value = row.price?.();",
    ],
    [
      "optional chain parentheses",
      "export const value = (row?.price).value;",
      "export const value = row?.price.value;",
    ],
    [
      "directive parentheses",
      'function value() { "use strict"; return this; }',
      'function value() { ("use strict"); return this; }',
    ],
    ["unary operator", "export const value = +price;", "export const value = -price;"],
    [
      "postfix operator",
      "export function value() { return count++; }",
      "export function value() { return count--; }",
    ],
    ["binary operator", "export const value = price + fee;", "export const value = price - fee;"],
    [
      "comparison operator",
      "export const value = price > fee;",
      "export const value = price >= fee;",
    ],
    [
      "return ASI",
      "export function value() { return { price: 1 }; }",
      "export function value() { return\n{ price: 1 }; }",
    ],
    [
      "postfix ASI",
      "export function value() { let a = 1, b = 2; a++\nb; return [a, b]; }",
      "export function value() { let a = 1, b = 2; a\n++b; return [a, b]; }",
    ],
    ["regex versus division", "export const value = /x/g;", "export const value = x / g;"],
    ["array holes", "export const values = [1,];", "export const values = [1,,];"],
    ["empty versus sparse array", "export const values = [];", "export const values = [,];"],
    ["comma operator", "export const value = (price, fee);", "export const value = (price + fee);"],
    [
      "expression grouping",
      "export const value = price * (fee + tax);",
      "export const value = (price * fee) + tax;",
    ],
  ])("detects meaningful %s changes", (_label, before, after) => {
    expect(executableHash(after)).not.toBe(executableHash(before));
  });

  it("rejects invalid source instead of hashing parser recovery output", () => {
    expect(() => executableHash("export const value = ;")).toThrow(
      "Invalid engine manifest source",
    );
  });

  it("rejects malformed emitted JavaScript even when transpilation reports no error", () => {
    expect(() => executableHash("export function value() { throw\n new Error(); }")).toThrow(
      "Invalid engine manifest executable",
    );
  });

  it("keeps extra expression parentheses conservatively distinct", () => {
    // This is syntax canonicalization, not broad semantic equivalence. A formatter
    // that adds/removes expression parentheses can still require an explicit review.
    expect(executableHash("export function value() { return (a ?? b); }")).not.toBe(
      executableHash("export function value() { return a ?? b; }"),
    );
  });
});

it("keeps PR195 runtime provenance compatible with the eight frozen Shadow contracts", async () => {
  const runtime = await shadowEngineManifest();
  expect(runtime.codeHash).toBe(
    "sha256:ffd26d07d50564c6c734dc9c96ede00f7786e1122df3eb373ad56a4648929033",
  );
  expect(REVIEWED_SHADOW_RUNTIME_CODE_HASHES).toContain(runtime.codeHash);
  expect(adoptedShadowFrozenCodeHash(runtime.codeHash)).toBe(
    ADOPTED_SHADOW_FROZEN_CODE_HASH,
  );
  expect(ADOPTED_SHADOW_FROZEN_CODE_HASH).toBe(
    "sha256:ca565a5ec7bff10815a4943989ae3b02fd52fd508bbd283ae5c4d23eb79607c6",
  );
  expect(() =>
    adoptedShadowFrozenCodeHash(`sha256:${"f".repeat(64)}`),
  ).toThrow(/Unreviewed October Shadow runtime hash/);
});

it("freezes calculation sources independently of deployment/UI/docs while detecting engine changes", async () => {
  const original = await shadowEngineManifest();
  expect(Object.keys(original.manifest.files)).toHaveLength(40);
  expect(original).toEqual(
    JSON.parse(await readFile("src/lib/ledger/octoberShadowEngineManifest.generated.json", "utf8")),
  );
  expect(original.manifest.files).not.toHaveProperty("README.md");
  expect(original.manifest.files).not.toHaveProperty("src/lib/cloud.ts");
  expect(original.manifest.files).not.toHaveProperty("src/lib/ledger/validation.ts");
  expect(original.manifest.files).not.toHaveProperty("src/lib/ledger/executionMemo.ts");
  expect(original.manifest.files).not.toHaveProperty(
    "src/lib/ledger/octoberShadowCalendarEvidence.json",
  );
  expect(original.manifest.files).toHaveProperty("src/lib/ledger/octoberShadowCalendar.ts");
  const root = await mkdtemp(path.join(os.tmpdir(), "shadow-manifest-"));
  try {
    for (const file of Object.keys(original.manifest.files)) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), await readFile(file));
    }
    await writeFile(path.join(root, "README.md"), "unrelated deployment documentation");
    const same = await shadowEngineManifest(root);
    expect(same.codeHash).toBe(original.codeHash);
    const archive = "src/lib/ledger/octoberShadowArchive.ts";
    await writeFile(
      path.join(root, archive),
      await format(await readFile(archive, "utf8"), {
        parser: "typescript",
        printWidth: 160,
        arrowParens: "avoid",
        trailingComma: "none",
        useTabs: true,
      }),
    );
    expect((await shadowEngineManifest(root)).codeHash).toBe(original.codeHash);
    const changed = "src/lib/engine/usProspectivePortfolio.ts";
    await writeFile(
      path.join(root, changed),
      `${await readFile(changed, "utf8")}\n// reviewed engine revision\n`,
    );
    expect((await shadowEngineManifest(root)).codeHash).toBe(original.codeHash);
    await writeFile(
      path.join(root, changed),
      (await readFile(changed, "utf8")).replace(
        "US_PROSPECTIVE_INITIAL_CAPITAL = 100_000",
        "US_PROSPECTIVE_INITIAL_CAPITAL = 100_001",
      ),
    );
    expect((await shadowEngineManifest(root)).codeHash).not.toBe(original.codeHash);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20000);
