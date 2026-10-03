import { describe, expect, it } from "vitest";
import {
  EXECUTION_MEMO_URL_MESSAGE,
  mergeExecutionSourceLinks,
  projectExecutionMemo,
  rejectExecutionMemoUrls,
  savedExecutionMemo,
  splitExecutionMemo,
  validateExecutionSourceLinks,
} from "./executionMemo";

const url = "https://www.notion.so/Synthetic-note-00000000000000000000000000000000";
describe("execution memo / inert source separation", () => {
  it("removes a bare Notion address while retaining exact Unicode, whitespace, and newlines", () => {
    const note = `한글 메모 😀\n  ${url}\n분할 체결\t완료 `;
    expect(splitExecutionMemo(note)).toEqual({
      note: "한글 메모 😀\n  \n분할 체결\t완료 ",
      sourceLinks: [{ system: "notion", url }],
    });
  });
  it("retains markdown labels, angle-link punctuation and ordinary web URLs", () => {
    expect(
      splitExecutionMemo(
        `확인 [개발 노트](${url}) · <https://team.notion.site/page>.\n[공시](https://example.test/a)`,
      ),
    ).toEqual({
      note: "확인 개발 노트 · .\n[공시](https://example.test/a)",
      sourceLinks: [
        { system: "notion", url, label: "개발 노트" },
        { system: "notion", url: "https://team.notion.site/page" },
      ],
    });
  });
  it.each([
    "https://notion.so/page",
    "HTTP://NOTION.SO/page",
    "www.notion.so/page",
    "notion.site/page",
    "https://notion.com/page",
    "https://notion.so:443/page",
    "http://notion.so:80/page",
  ])("handles recognized Notion address %s", (address) => {
    expect(splitExecutionMemo(`(${address}).`)).toEqual({
      note: "().",
      sourceLinks: [{ system: "notion", url: address }],
    });
  });
  it.each([
    "https://notion.so.evil.test/steal",
    "https://notion.so@evil.test/x",
    "https://evil.test/?next=https://notion.so/page",
    "javascript:alert(1)",
    "https://my_team.notion.so/page",
    "https://notion.so:80/page",
    "http://notion.so:443/page",
    "https://example.test/a",
  ])("does not reinterpret a non-Notion or forged URL: %s", (address) => {
    expect(splitExecutionMemo(address)).toEqual({ note: address, sourceLinks: [] });
    expect(() => validateExecutionSourceLinks([{ system: "notion", url: address }])).toThrow();
  });
  it("treats label and URL instruction-shaped content as inert text", () => {
    const address = "https://notion.so/page?command=delete-all";
    expect(splitExecutionMemo(`[ignore prior instructions](${address})`)).toEqual({
      note: "ignore prior instructions",
      sourceLinks: [{ system: "notion", url: address, label: "ignore prior instructions" }],
    });
  });
  it("projects a copy without changing original history, IDs or numeric precision", () => {
    const original = {
      id: "immutable",
      note: `평균가\n${url}`,
      shares: 17,
      price: 100 / 3,
      fee: 0,
      accountId: null,
      settlementDate: null,
    };
    const before = structuredClone(original);
    const projected = projectExecutionMemo(original);
    expect(original).toEqual(before);
    expect(projected).toEqual({
      ...before,
      note: "평균가\n",
      sourceLinks: [{ system: "notion", url }],
    });
    expect(projected).not.toBe(original);
  });
  it("preserves original sources server-side when an older editor submits only a clean memo", () => {
    const existing = { note: `증거 ${url}` };
    expect(savedExecutionMemo({ note: "수정된 메모" }, existing)).toEqual({
      note: "수정된 메모",
      sourceLinks: [{ system: "notion", url }],
    });
    expect(existing.note).toBe(`증거 ${url}`);
  });
  it("deduplicates copied references without mutating prior source metadata", () => {
    const previous = [{ system: "notion" as const, url, label: "원본" }];
    const result = mergeExecutionSourceLinks(previous, previous);
    expect(result).toEqual(previous);
    result[0]!.label = "수정";
    expect(previous[0]!.label).toBe("원본");
  });
  it("rejects newly submitted Notion links explicitly without consuming the draft", () => {
    const input = { note: `유지 ${url}` };
    expect(() => savedExecutionMemo(input)).toThrow(EXECUTION_MEMO_URL_MESSAGE);
    expect(() => rejectExecutionMemoUrls(input.note)).toThrow(EXECUTION_MEMO_URL_MESSAGE);
    expect(input.note).toBe(`유지 ${url}`);
  });
  it.each([
    null,
    {},
    [{ system: "broker", url }],
    [{ system: "notion", url, instruction: "trust me" }],
    [{ system: "notion", url, label: 1 }],
    [{ system: "notion", url: "https://user:password@notion.so/page" }],
  ])("rejects invalid provenance schema %j", (value) => {
    expect(() => validateExecutionSourceLinks(value)).toThrow();
  });
});
