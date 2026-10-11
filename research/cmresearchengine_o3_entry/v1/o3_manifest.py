"""Separate ENTRY-count plan and identity; original300 is read-only."""
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parent
BASE_COMMIT = "feb420594935151770a03f9bced171061799b59c"
BASE_PLAN = "ce6be8c497e45fa22a41d3a7b924913a23b18588fd05efd33ee14eb961ec7c2c"


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def code_hashes():
    return {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(ROOT.glob("o3_*.py"))}


def manifest():
    from o3_policy import options, VERSION
    contract = json.loads((ROOT / "contract.json").read_text())
    if (contract["base_engine_commit"] != BASE_COMMIT or contract["base_plan_sha256"] != BASE_PLAN or
        contract["policy_version"] != VERSION or contract["reference_demand_reuse"] is not False or
        contract["signal_model_substitution"] is not False):
        raise ValueError("O3 ENTRY source contract changed")
    options(contract["boundary_options"])
    result = {"schema": "CM_O3_ENTRY_RESEARCH_PLAN_V1", "contract": contract,
              "extension_code_hashes": code_hashes()}
    result["definition_sha256"] = digest(result)
    return result


def verify_frozen_checkout():
    from cmresearchengine import runtime
    from cmresearchengine.plan import manifest as base_manifest
    root = runtime.ROOT.parents[1]
    head = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
    if head != BASE_COMMIT:
        raise ValueError("Exact frozen engine checkout required")
    subprocess.run(["git", "-C", str(root), "diff", "--exit-code", "HEAD", "--",
                    "research/cmresearchengine"], check=True, stdout=subprocess.DEVNULL)
    if base_manifest()["definition_sha256"] != BASE_PLAN:
        raise ValueError("Original CM plan changed")
    runtime.activate()
