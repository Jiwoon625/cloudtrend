import React from "react";
import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BreakdownTable } from "./BreakdownTable";
it("preserves a negative supply-risk contribution in the displayed sum", () => {
  const html = renderToStaticMarkup(
    <BreakdownTable
      title="Priority"
      asOfDate="2026-10-12"
      source="saved"
      block={{
        points: 2.84,
        availableMaxPoints: 4,
        maxPoints: 5,
        rows: [
          {
            group: "Supply Risk",
            rule: "대차 증가",
            actual: "+766798",
            threshold: "-0.5",
            status: "FAIL",
            points: -0.5,
            maxPoints: 0,
          },
        ],
      }}
    />,
  );
  expect(html).toContain('class="num px-2 py-1.5">-0.5</td>');
  expect(html).toContain("획득 2.84");
});

it("does not present an empty score block as an observed zero score", () => {
  const html = renderToStaticMarkup(
    <BreakdownTable
      title="Fundamental"
      asOfDate="2026-10-12"
      source="saved"
      block={{ points: 0, availableMaxPoints: 0, maxPoints: 0, rows: [] }}
    />,
  );
  expect(html).toContain("표시할 산정 항목 없음");
  expect(html).not.toContain("획득 0");
});
