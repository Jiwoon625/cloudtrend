"""Reuse the known-event preflight with new, explicit per-strategy identities."""
from . import runtime
from .plan import manifest, REFERENCE_CONTRACT
from .replay import ResearchReplay, SplitMarketPanels, POLICY
from dataclasses import asdict, replace
from pathlib import Path
import json
from cm06_fresh_driver_v1 import PreparedFreshDiagnostic, source_hashes, digest, file_hash
from cm06_fresh_codec_v1 import bind_identity
from cm06_comparison_panels import MonthlyDayPanels
from cm06_exact_units_resume_state_v1 import frame_fingerprint

class PreparedResearch(PreparedFreshDiagnostic):
    def __init__(self, config, candidate, references=None, execution_optimization=None):
        runtime.activate()
        self.research_candidate=candidate
        self.references=references or {}
        self.execution_optimization=execution_optimization
        super().__init__(config)
        self._bind_research_identity()

    def _bind_research_identity(self):
        runtime.activate()
        candidate=self.research_candidate
        self.base_identity=dict(self.base_identity)
        self.base_identity.update(schema='CM_RESEARCH_STRATEGY_V1',scope='CM_RESEARCH_ONLY',
            candidate=candidate.to_dict(),execution=asdict(self.research_contract()),
            batch_execution_authorized=True,plan_sha256=manifest()['definition_sha256'],
            code_hashes=runtime.code_hashes(),runtime_versions=runtime.fingerprint(),exception_policy=POLICY,
            reference_contract=REFERENCE_CONTRACT,
            reference_nav_fingerprint=frame_fingerprint(self.references.get('nav')),
            reference_demands_fingerprint=frame_fingerprint(self.references.get('demands')),
            reference_capital=self.references.get('capital'),
            execution_optimization=self.execution_optimization,
            evaluation_completed=False)
        self.identity=bind_identity(self.base_identity,self.factory())
        self.trial_key='cm-'+candidate.candidate_id+'-'+digest(self.identity)

    def clone(self,candidate,references=None):
        other=object.__new__(type(self))
        other.__dict__=dict(self.__dict__)
        other.research_candidate=candidate
        other.references=references or {}
        other._bind_research_identity()
        return other

    def research_contract(self):
        if self.research_candidate.stage=='references':
            return replace(self.contract,cash_movement='NONE')
        return self.contract

    def factory(self):
        runtime.activate()
        if source_hashes()!=self.sources:raise ValueError('Source changed after preflight')
        panels={e:MonthlyDayPanels(self.inputs/e/'manifest.json',self.prep['engines'][e]['sha256']) for e in 'KEU'}
        calendars=self.calendars
        split='P' in self.research_candidate.initial_weights
        if split:
            panels={'P':SplitMarketPanels(panels['K'],'KOSPI'),
                'Q':SplitMarketPanels(MonthlyDayPanels(self.inputs/'K/manifest.json',self.prep['engines']['K']['sha256']),'KOSDAQ'),
                'E':panels['E'],'U':panels['U']}
            calendars={'P':self.calendars['K'],'Q':self.calendars['K'],'E':self.calendars['E'],'U':self.calendars['U']}
        if self.research_candidate.policy_id and not self.references:
            raise ValueError('Dynamic strategies require completed independent reference runs')
        return ResearchReplay(self.research_candidate,self.research_contract(),panels,calendars,self.fx,
            registry=self.registry,contexts=self.contexts,instrument_identities=self.identities,
            hazards=self.hazards,coverages=self.coverages,quote_rules=self.quote_rules,
            entitlement_bridge=self.entitlement_bridge,context_sha256=self.context_sha256,
            structural_split=split,reference_nav=self.references.get('nav'),
            reference_demands=self.references.get('demands'),reference_capital=self.references.get('capital'))


def configuration(work, evidence, state_root):
    """Paths are a data-only private overlay of the source-bound known profile."""
    work=Path(work);evidence=Path(evidence)
    paths={
        'frozen_input_contract':evidence/'evidence/FROZEN_INPUT_CONTRACT.json',
        'candidate_registry':evidence/'evidence/CANDIDATE_REGISTRY_POLICY_V2.jsonl',
        'quote_rules':evidence/'evidence/DOCUMENTED_QUOTE_RULES.json',
        'evidence_receipt':evidence/'evidence/INDEPENDENT_VERIFICATION_RECEIPT.json',
        'original_experiment':evidence/'evidence/ORIGINAL_EXPERIMENT_DESCRIPTOR.json'}
    config={k:str(v) for k,v in paths.items()}
    lock={'schema':'CM06_FRESH_SOURCE_LOCK_V1','source_files':source_hashes(),
        'data_files':{k:file_hash(v) for k,v in paths.items()}}
    target=work/'research_source_lock.json'
    target.parent.mkdir(parents=True,exist_ok=True)
    target.write_text(json.dumps(lock,sort_keys=True))
    config.update(work=str(work),source_lock=str(target),state_root=str(state_root),
        evidence_parts=str(evidence/'reference_parts'))
    return config
