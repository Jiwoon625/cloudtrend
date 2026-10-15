import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { KospiShadowContent } from "../src/components/KospiShadowPanel";
import {
  createShadowRevisionFixture,
  SHADOW_TEST_COMPUTED_AT,
} from "./fixtures/kospiShadowRevision";
vi.mock("@/lib/kospiShadowCloud", () => ({ loadKospiShadow: vi.fn() }));
const baseProps = { loading: false, error: null, fromDate: "", toDate: "", refresh: () => {} };
function visibleText(html: string) {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
}
function withoutButtons(html: string) {
  return html.replace(/<button\b[^>]*>[\s\S]*?<\/button>/g, "");
}
describe("truthful retrospective KOSPI Shadow display", () => {
  it("labels correction timing, inherited history and capital", async () => {
    const f = await createShadowRevisionFixture(),
      html = renderToStaticMarkup(
        <KospiShadowContent
          {...baseProps}
          view={f.correctedView}
          originalSelected={false}
          toggleOriginal={() => {}}
        />,
      ),
      text = visibleText(html);
    expect(text).toContain("사후 정정본");
    expect(text).toContain("초기자금을 재설정하지 않았습니다");
    expect(text).toContain("이전 구간은 재계산하지 않았으며");
    expect(html).toContain(SHADOW_TEST_COMPUTED_AT);
    expect(text).toContain("2026-10-13");
    expect(text).toContain("2026-10-14");
    expect(text).toContain(f.original.registry.initializedDate);
    expect(text).toContain(
      `${Math.round(f.correctedView.latest.state.cashKrw).toLocaleString("ko-KR")}원`,
    );
    expect(text).toContain("TEST_HELD");
  });
  it.each([false, true])("labels preserved original when selected=%s", async (originalSelected) => {
    const f = await createShadowRevisionFixture(),
      html = renderToStaticMarkup(
        <KospiShadowContent
          {...baseProps}
          view={f.original}
          originalSelected={originalSelected}
          toggleOriginal={() => {}}
        />,
      ),
      content = visibleText(withoutButtons(html));
    expect(content).toMatch(/원본.{0,40}보존|보존.{0,40}원본/);
    expect(html).not.toContain('aria-label="사후 정정본 안내"');
    expect(content).not.toContain("초기자금을 재설정하지 않았습니다");
    expect(content).not.toContain("이전 구간은 재계산하지 않았으며");
    expect(html).not.toContain(SHADOW_TEST_COMPUTED_AT);
    expect(content).toContain(f.original.registry.initializedDate);
  });
  it("does not invent correction when no record exists", () => {
    const html = renderToStaticMarkup(<KospiShadowContent {...baseProps} view={null} />),
      text = visibleText(withoutButtons(html));
    expect(text).toContain("아직 확정된 KOSPI Shadow 기록이 없습니다");
    expect(text).not.toContain("사후 정정본");
    expect(text).not.toContain("원본 보존");
    expect(text).not.toContain("초기자금을 재설정하지 않았습니다");
  });
  it("shows integrity error not false success", () => {
    const html = renderToStaticMarkup(
      <KospiShadowContent
        {...baseProps}
        view={null}
        error="Synthetic correction integrity failure"
      />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("Synthetic correction integrity failure");
    expect(html).not.toContain("아직 확정된 KOSPI Shadow 기록이 없습니다");
    expect(visibleText(withoutButtons(html))).not.toContain("사후 정정본");
  });
  it("does not render malformed revision as original", async () => {
    const f = await createShadowRevisionFixture(),
      malformed = structuredClone(f.correctedView);
    (malformed.registry as unknown as { revision: unknown }).revision = { revisionId: "../escape" };
    expect(() =>
      renderToStaticMarkup(<KospiShadowContent {...baseProps} view={malformed} />),
    ).toThrow();
  });
});
