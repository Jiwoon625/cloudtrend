import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { hashSeriesValue } from "../src/lib/ledger/modelSeries";

/** Transitive calculation sources only: no git HEAD, UI, deployment config, or unrelated docs. */
export const SHADOW_ENGINE_ROOTS = [
  "src/lib/ledger/octoberShadowPipeline.ts",
  "src/lib/ledger/modelSeries.ts",
  "src/lib/ledger/krAdoptedShadow.ts",
  "src/lib/ledger/etfAdoptedShadow.ts",
  "src/lib/ledger/kospiAdoptedShadow.ts",
  "src/lib/engine/fullMarketAnalysis.ts",
  "src/lib/engine/manualDataset.ts",
  "src/lib/engine/usProspective.ts",
  "src/lib/engine/kospiShadowDataset.ts",
] as const;

type ExecutableSyntax = [kind: number, value: string | ExecutableSyntax[]];

export {
  ADOPTED_SHADOW_FROZEN_CODE_HASH,
  PRE_FIRST_SESSION_KOSPI_CONFIRMATION_FIX_RUNTIME_HASH,
  PENDING_MARKET_CAP_FIX_RUNTIME_HASH,
  A0_OPERATING_COST_ALIGNMENT_RUNTIME_HASH,
  OCTOBER12_CONSISTENCY_RUNTIME_HASH,
  OCTOBER12_REAUDIT_RUNTIME_HASH,
  US_PRIORITY_SHARED_COMPARATOR_RUNTIME_HASH,
  REAUDIT_OBSERVATION_METADATA_RUNTIME_HASH,
  REVIEWED_SHADOW_RUNTIME_CODE_HASHES,
  adoptedShadowFrozenCodeHash,
  assertAdoptedShadowRuntime,
} from "../src/lib/ledger/octoberShadowRuntime";

/**
 * Parse executable output rather than stripping whitespace or scanning without
 * parser context: regexes, template chunks and ASI must retain their meaning.
 * getChildren includes keyword/operator tokens that forEachChild can omit.
 */
export function shadowExecutableSyntax(content: string, fileName = "engine.ts") {
  const result = ts.transpileModule(content, {
    fileName,
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: false,
      removeComments: true,
    },
  });
  const errors = result.diagnostics?.filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  if (errors?.length) {
    throw new Error(
      `Invalid engine manifest source ${fileName}: ${errors
        .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, " "))
        .join("; ")}`,
    );
  }
  const source = ts.createSourceFile(
    "executable.js",
    result.outputText,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.JS,
  );
  // Transpilation can recover from invalid source grammar (such as throw followed
  // by a line break) without reporting an error, yet emit invalid JavaScript.
  // Check the emitted tree via the public compiler API, using an in-memory host.
  const emittedErrors = ts
    .createProgram(
      [source.fileName],
      { allowJs: true, noLib: true, noResolve: true },
      {
        getSourceFile: (name) => (name === source.fileName ? source : undefined),
        getDefaultLibFileName: () => "lib.d.ts",
        writeFile: () => {},
        getCurrentDirectory: () => "/",
        getCanonicalFileName: (name) => name,
        useCaseSensitiveFileNames: () => true,
        getNewLine: () => "\n",
        fileExists: (name) => name === source.fileName,
        readFile: (name) => (name === source.fileName ? result.outputText : undefined),
      },
    )
    .getSyntacticDiagnostics(source);
  if (emittedErrors.length) {
    throw new Error(
      `Invalid engine manifest executable ${fileName}: ${emittedErrors
        .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, " "))
        .join("; ")}`,
    );
  }
  function syntax(node: ts.Node): ExecutableSyntax {
    // Exact token spelling preserves string/regex/template whitespace and escapes.
    if (node.kind <= ts.SyntaxKind.LastToken) return [node.kind, node.getText(source)];
    const children = node.getChildren(source);
    const meaningfulChildren = children.filter((child, index) => {
      // List punctuation is redundant with the parsed elements. Keep omitted
      // array elements, so [1,] and [1,,] remain distinct despite the trailing comma.
      if (
        node.kind === ts.SyntaxKind.SyntaxList &&
        index === children.length - 1 &&
        child.kind === ts.SyntaxKind.CommaToken
      )
        return false;
      // x => x and (x) => x differ only in arrow-parameter presentation.
      // Parenthesized expressions in the body remain separate syntax nodes.
      if (
        ts.isArrowFunction(node) &&
        (child.kind === ts.SyntaxKind.OpenParenToken ||
          child.kind === ts.SyntaxKind.CloseParenToken)
      )
        return false;
      return true;
    });
    return [node.kind, meaningfulChildren.map(syntax)];
  }
  return { executable: result.outputText, canonicalSyntax: JSON.stringify(syntax(source)) };
}

export async function shadowEngineManifest(root = process.cwd()) {
  const files = new Map<string, string>();
  async function visit(relative: string): Promise<void> {
    if (files.has(relative)) return;
    const content = await readFile(path.join(root, relative), "utf8");
    if (relative.endsWith(".json")) {
      files.set(relative, await hashSeriesValue(JSON.parse(content)));
      return;
    }
    const { executable, canonicalSyntax } = shadowExecutableSyntax(content, relative);
    files.set(relative, `sha256:${createHash("sha256").update(canonicalSyntax).digest("hex")}`);
    const imports = ts.preProcessFile(executable).importedFiles;
    for (const imported of imports) {
      const name = imported.fileName;
      if (!name.startsWith(".") && !name.startsWith("@/")) continue;
      // Calendar evidence may be extended without redefining strategy calculations.
      if (name.endsWith("/octoberShadowCalendarEvidence.json")) continue;
      const base = name.startsWith("@/")
        ? `src/${name.slice(2)}`
        : path.posix.join(path.posix.dirname(relative), name);
      let resolved: string | undefined;
      for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
        try {
          await readFile(path.join(root, candidate));
          resolved = candidate;
          break;
        } catch {
          /* try module suffix */
        }
      }
      if (!resolved)
        throw new Error(`Unresolved engine manifest dependency: ${name} from ${relative}`);
      await visit(resolved);
    }
  }
  for (const entry of SHADOW_ENGINE_ROOTS) await visit(entry);
  const manifest = {
    version: "october-shadow-engine-manifest-v2",
    files: Object.fromEntries([...files].sort(([a], [b]) => a.localeCompare(b))),
    dependencies: { typescript: ts.version },
    normalization: "ES2022_ESMODULE_PARSED_TOKEN_TREE_WITHOUT_TRIVIA_V1",
  };
  return { manifest, codeHash: await hashSeriesValue(manifest) };
}
