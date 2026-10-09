/** Explicit research opt-in. Dates stay real; production's adoption guards stay the default. */
export interface OperatingPolicyContext {
  mode: "CURRENT_RULES_RESEARCH";
}

export const CURRENT_RULES_RESEARCH: OperatingPolicyContext = Object.freeze({
  mode: "CURRENT_RULES_RESEARCH",
});

export const isCurrentRulesResearch = (context?: OperatingPolicyContext) =>
  context?.mode === "CURRENT_RULES_RESEARCH";
