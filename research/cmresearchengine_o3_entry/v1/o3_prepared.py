"""Reuse original preflight and exact checkpoint codec, no independent REF ledger."""
from dataclasses import asdict
from cmresearchengine import runtime
from cmresearchengine.prepared import PreparedResearch
from cmresearchengine.replay import POLICY
from cm06.registry import Candidate
from cm06_fresh_codec_v1 import bind_identity
from cm06_fresh_driver_v1 import source_hashes
from cm06_comparison_panels import MonthlyDayPanels
from o3_manifest import manifest, digest, code_hashes
from o3_replay import O3ResearchReplay


def candidate():
    return Candidate("O3", "O", manifest()["contract"]["boundary_options"]["initial_weights"],
                     policy_id="O3", stage="o3_entry_extension_v1")


class PreparedO3(PreparedResearch):
    @classmethod
    def from_prototype(cls, prototype):
        other = object.__new__(cls)
        other.__dict__ = dict(prototype.__dict__)
        other.research_candidate = candidate()
        other.references = {}
        other.o3_plan = manifest()
        other.execution_optimization = {"schema": "CM_O3_EXECUTION_OPTIMIZATION_V1",
            "mode": "O3_OBSERVER_EXECUTOR_ONE_SESSION_V1", "backend": "FROZEN_LOCKSTEP_SHARED_US_ANALYSIS_V1",
            "cache_key": "EXACT_FULL_SESSION_ROWS_AND_PRIOR_MARKET_RANK_STATE", "lifetime": "ONE_CLOSE_EVENT"}
        other._bind_research_identity()
        return other

    def _bind_research_identity(self):
        runtime.activate()
        self.base_identity = dict(self.base_identity)
        self.base_identity.update(
            schema="CM_O3_ENTRY_RESEARCH_STRATEGY_V1", scope="CM_RESEARCH_ONLY",
            candidate=self.research_candidate.to_dict(), execution=asdict(self.research_contract()),
            batch_execution_authorized=True, plan_sha256=self.o3_plan["definition_sha256"],
            o3_extension_plan=self.o3_plan, code_hashes=runtime.code_hashes(),
            runtime_versions=runtime.fingerprint(), exception_policy=POLICY,
            reference_contract=None, reference_nav_fingerprint=None,
            reference_demands_fingerprint=None, reference_capital=None,
            execution_optimization=self.execution_optimization, evaluation_completed=False)
        self.identity = bind_identity(self.base_identity, self.factory())
        self.trial_key = "cm-O3-entry-" + digest(self.identity)

    def factory(self):
        runtime.activate()
        if source_hashes() != self.sources:
            raise ValueError("Original frozen source changed after preflight")
        if code_hashes() != self.o3_plan["extension_code_hashes"] or manifest() != self.o3_plan:
            raise ValueError("O3 extension changed after identity binding")
        if self.research_candidate != candidate() or self.references:
            raise ValueError("O3 requires intrinsic signals, never reference demands")
        panels = {e: MonthlyDayPanels(self.inputs / e / "manifest.json", self.prep["engines"][e]["sha256"])
                  for e in "KEU"}
        return O3ResearchReplay(
            self.research_candidate, self.research_contract(), panels, self.calendars, self.fx,
            registry=self.registry, contexts=self.contexts, instrument_identities=self.identities,
            hazards=self.hazards, coverages=self.coverages, quote_rules=self.quote_rules,
            entitlement_bridge=self.entitlement_bridge, context_sha256=self.context_sha256,
            policy_options=self.o3_plan["contract"]["boundary_options"])
