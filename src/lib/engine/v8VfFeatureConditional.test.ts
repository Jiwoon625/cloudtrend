import { describe, expect, it } from "vitest";

import { crossSectionalOls } from "./v8VfFeatureConditional";

describe("V8 Vf conditional OLS", () => {
  it("recovers exact intercept and binary-feature coefficients", () => {
    const x = [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ];
    const y = x.map(([a, b]) => 2 + 3 * a - 1 * b);
    const beta = crossSectionalOls(x, y);
    expect(beta).not.toBeNull();
    expect(beta![0]).toBeCloseTo(2, 10);
    expect(beta![1]).toBeCloseTo(3, 10);
    expect(beta![2]).toBeCloseTo(-1, 10);
  });

  it("returns null for a singular design", () => {
    const x = [
      [0, 0],
      [1, 1],
      [0, 0],
      [1, 1],
    ];
    const y = [0, 1, 0, 1];
    expect(crossSectionalOls(x, y)).toBeNull();
  });
});
