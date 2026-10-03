/** Inert provenance only. A source link is not a fetched document or verified evidence. */
export interface ExecutionSourceLink {
  system: "notion";
  url: string;
  label?: string;
}

export const EXECUTION_MEMO_URL_MESSAGE =
  "메모에는 Notion URL을 입력할 수 없습니다. 링크를 제외한 메모만 입력해 주세요. 기존 출처 링크는 별도로 보존됩니다.";

export function isNotionSourceUrl(value: string): boolean {
  // Keep the same accepted grammar as the SQL guard. Do not normalize the stored address.
  const match =
    /^(?:(https?):\/\/)?((?:[a-z0-9-]+\.)*notion\.(?:so|site|com)\.?)(?::(80|443))?([/?#][^\s<>"']*)?$/i.exec(
      value,
    );
  if (!match) return false;
  const protocol = (match[1] ?? "https").toLowerCase();
  return !match[3] || match[3] === (protocol === "http" ? "80" : "443");
}

export function validateExecutionSourceLinks(
  value: unknown,
): asserts value is ExecutionSourceLink[] | undefined {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 50) throw new Error("Invalid execution source links");
  for (const link of value) {
    if (
      !link ||
      typeof link !== "object" ||
      Array.isArray(link) ||
      Object.keys(link).some((key) => !["system", "url", "label"].includes(key)) ||
      link.system !== "notion" ||
      typeof link.url !== "string" ||
      !link.url ||
      link.url.length > 2048 ||
      /[\s<>"']/.test(link.url) ||
      !isNotionSourceUrl(link.url) ||
      (link.label !== undefined && (typeof link.label !== "string" || link.label.length > 300))
    )
      throw new Error("Invalid execution source link");
  }
}

export function mergeExecutionSourceLinks(
  ...groups: (readonly ExecutionSourceLink[] | undefined)[]
): ExecutionSourceLink[] {
  const merged = new Map<string, ExecutionSourceLink>();
  for (const group of groups) {
    validateExecutionSourceLinks(group);
    for (const link of group ?? []) {
      // Keep distinct labels as observations; never mutate references held by old revisions.
      const key = JSON.stringify([link.url, link.label ?? null]);
      if (!merged.has(key)) merged.set(key, { ...link });
    }
  }
  const result = [...merged.values()];
  validateExecutionSourceLinks(result);
  return result;
}

/** Remove only the URL/link syntax. All surrounding whitespace and non-link text stays exact. */
export function splitExecutionMemo(note: string): {
  note: string;
  sourceLinks: ExecutionSourceLink[];
} {
  const links: ExecutionSourceLink[] = [];
  let memo = note.replace(
    /\[([^\]\r\n]*)\]\(<?([^\s<>]+?)>?\)/g,
    (whole: string, label: string, url: string) => {
      if (!isNotionSourceUrl(url)) return whole;
      links.push({ system: "notion", url, ...(label ? { label } : {}) });
      return label;
    },
  );
  memo = memo.replace(/<([^\s<>]+)>/g, (whole: string, url: string) => {
    if (!isNotionSourceUrl(url)) return whole;
    links.push({ system: "notion", url });
    return "";
  });
  memo = memo.replace(
    /https?:\/\/[^\s<>"'[\]]+|(?<![\w@./-])(?:[a-z0-9-]+\.)*notion\.(?:so|site|com)(?=[/?#\s<>"'[\]().,!?;:]|$)[^\s<>"'[\]]*/gi,
    (token: string) => {
      let url = token.replace(/[.,;:!?]+$/, "");
      // Preserve sentence/bracket punctuation but allow balanced parentheses in URL paths.
      while (/[)}]$/.test(url)) {
        const last = url.at(-1)!;
        const open = last === ")" ? "(" : "{";
        if (url.split(last).length <= url.split(open).length) break;
        url = url.slice(0, -1);
      }
      if (!isNotionSourceUrl(url)) return token;
      links.push({ system: "notion", url });
      return token.slice(url.length);
    },
  );
  return { note: memo, sourceLinks: mergeExecutionSourceLinks(links) };
}

/** UI-only projection. Never apply before raw canonical/document integrity comparisons. */
export function projectExecutionMemo<
  T extends { note: string; sourceLinks?: ExecutionSourceLink[] | undefined },
>(execution: T): T {
  const split = splitExecutionMemo(execution.note);
  const sourceLinks = mergeExecutionSourceLinks(execution.sourceLinks, split.sourceLinks);
  return { ...execution, note: split.note, ...(sourceLinks.length ? { sourceLinks } : {}) };
}

/** Reject new pasted URLs explicitly instead of silently discarding user input. */
export function rejectExecutionMemoUrls(note: string): void {
  if (splitExecutionMemo(note).sourceLinks.length) throw new Error(EXECUTION_MEMO_URL_MESSAGE);
}

/** Called on an explicit save; legacy observations remain in immutable original revisions. */
export function savedExecutionMemo(
  input: { note: string; sourceLinks?: ExecutionSourceLink[] | undefined },
  existing?: { note: string; sourceLinks?: ExecutionSourceLink[] | undefined },
): { note: string; sourceLinks?: ExecutionSourceLink[] | undefined } {
  rejectExecutionMemoUrls(input.note);
  const sourceLinks = mergeExecutionSourceLinks(
    existing?.sourceLinks,
    existing ? splitExecutionMemo(existing.note).sourceLinks : [],
    input.sourceLinks,
  );
  return { note: input.note, ...(sourceLinks.length ? { sourceLinks } : {}) };
}
