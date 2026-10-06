# CloudTrend KR 스크리닝 원천 정리: 기존 Colab의 새 셀에서 이 파일 전체를 실행하세요.
# 기존 수집/등록 셀은 동시에 실행하지 마세요. 원본은 삭제하지 않습니다.
# 비밀키는 기존 Colab Secrets에서 마지막 실행 직전에만 읽습니다.
# 원시/정규화 CSV는 /content 로컬에만 두고 Drive에는 검증 메타데이터만 저장합니다.
"""Pinned one-time Colab launcher. Importing this module does not run anything.

Release preparation: replace exactly BUNDLE_SHA256 below with the final ZIP's
SHA-256. Do NOT put this launcher in that ZIP (it would create a circular hash).
The ZIP root must contain runtime-bundle.json; see validate_bundle_metadata().
No network, package installation, Colab secret read, or remote mutation occurs
until main() is explicitly called (or the complete release cell is executed).
"""
from pathlib import Path, PurePosixPath
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
import platform
import queue
import re
import shutil
import signal
import stat
import subprocess
import tarfile
import tempfile
import threading
import time
import urllib.request
import zipfile

BUNDLE_NAME = "cloudtrend_screening_compaction_runtime_v1.zip"
BUNDLE_SHA256 = "__FINAL_RUNTIME_ZIP_SHA256__"
SOURCE_BASE = "e30fa74549c48338318d873469b04ae6efb897db"
EXPECTED_SOURCE_HASH = "sha256:8c8f171d2b6bce3d722e39b8810148b5d7f8fc6e41493327f0b2bb4dd636f558"
PURPOSE = "kr-screening-compaction-20261006"
OWNER = "bdfc8818-33a7-4030-9dbd-ecad39f223ac"
SUPABASE_URL = "https://ahbvrtugugwnbrfnbxzp.supabase.co"
DRIVE_FOLDER = Path("/content/drive/MyDrive/CloudTrend")
EVIDENCE_DIR = DRIVE_FOLDER / "compaction_evidence/kr_screening_compaction_20261006"
LOCAL_OUTPUT = Path("/content/cloudtrend-screening-compaction/kr_screening_compaction_20261006")
NODE_VERSION = "22.16.0"
NODE_NAME = f"node-v{NODE_VERSION}-linux-x64"
EXISTING_NODE = Path("/content/cloudtrend-publish-runtime") / NODE_NAME / "bin/node"
LOCK_PATH = Path("/tmp/cloudtrend-kr-screening-compaction.lock")
METADATA_NAME = "runtime-bundle.json"
MAX_BUNDLE_BYTES = 64 * 1024 * 1024
MAX_EXPANDED_BYTES = 256 * 1024 * 1024
MAX_METADATA_BYTES = 8 * 1024 * 1024
EVIDENCE_FILES = (
    "compaction-manifest.json", "cutover-arguments.json", "cutover-receipt.json",
    "before.json", "after.json",
)
DESCRIPTOR_KEYS = frozenset("""
    id user_id source_type original_filename storage_bucket storage_path content_type
    canonical_format file_size_bytes normalized_size_bytes file_hash data_hash schema_hash
    row_count min_date max_date upload_source created_at activated_at storage_object_id storage_object_version
""".split())
VERIFICATION_KEYS = frozenset("""
    algorithm schema_version source_fingerprint candidate_fingerprint dataset_before
    dataset_after analysis_before analysis_after effective_rows_before effective_rows_after
    config_hash code_version timing_before timing_after
""".split())
MANIFEST_KEYS = frozenset("""
    operationId owner validatorFingerprint parents candidates plannedCandidateIds verification
    inputRows effectiveRows effectiveRowsHash symbols duplicateRows preservedEnrichmentCells
    originalBytes candidateBytes before after state stagedCandidateIds
""".split())
RECEIPT_KEYS = frozenset("""
    operation_id user_id source_type parent_ids candidate_ids committed_at verification reused original_source_evidence
""".split())
REPORT_KEYS = frozenset("datasetDigest sectorDatasetDigest analysisDigest configHash asOfDate stats".split())
STATS_KEYS = frozenset("stocks etfs indexes bars firstDate lastDate".split())
TOKEN_PATTERN = re.compile(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|sb_secret_[A-Za-z0-9_-]+")
PHASE_PATTERN = re.compile(
    r"(?:Verify original \d+/\d+|Validated immutable cache reused: [0-9a-f-]{36}|"
    r"Verify (?:baseline|candidate) dataset and analysis in an isolated process)"
)


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def redact(value, secret=""):
    text = str(value)
    if secret:
        text = text.replace(secret, "[REDACTED]")
    text = TOKEN_PATTERN.sub("[TOKEN]", text)
    text = re.sub(r"(?i)(authorization|apikey|api_key|service_role_key|password|token)\s*[:=]\s*[^\s,;]+",
                  r"\1=[REDACTED]", text)
    text = re.sub(r"https?://[^\s\"'<>]+", "[URL]", text)
    return text[:8000]


def assert_safe_metadata(value, secret="", depth=0):
    """Fail closed rather than redact/change an exact idempotent RPC payload."""
    require(depth <= 12, "검증 메타데이터 구조가 너무 깊습니다.")
    if isinstance(value, dict):
        require(len(value) <= 150, "검증 메타데이터 항목 수가 다릅니다.")
        for key, child in value.items():
            require(isinstance(key, str), "메타데이터 키 형식이 다릅니다.")
            require(not re.search(r"(?i)secret|password|authorization|api.?key|^token$|^rows$|^raw$|canonicalcsv|^dataset$|^analysis$|^bars$", key)
                    or (key == "bars" and isinstance(child, int)),
                    "비밀정보 또는 원시 행은 검증 기록에 저장하지 않습니다.")
            assert_safe_metadata(key, secret, depth + 1)
            assert_safe_metadata(child, secret, depth + 1)
    elif isinstance(value, list):
        require(len(value) <= 2000, "검증 메타데이터 배열이 너무 큽니다.")
        for child in value:
            assert_safe_metadata(child, secret, depth + 1)
    elif isinstance(value, str):
        require(len(value) <= 4096 and "\n" not in value and "\r" not in value,
                "원시 텍스트는 검증 기록에 저장하지 않습니다.")
        require(not (secret and secret in value) and not TOKEN_PATTERN.search(value),
                "비밀정보는 검증 기록에 저장하지 않습니다.")
        require(not re.search(r"https?://", value, re.I), "URL은 검증 기록에 저장하지 않습니다.")
    else:
        require(value is None or isinstance(value, (int, float, bool)), "검증 메타데이터 형식이 다릅니다.")


def project(value, allowed):
    require(isinstance(value, dict), "검증 메타데이터 객체가 필요합니다.")
    return {key: child for key, child in value.items() if key in allowed}


def report_metadata(value):
    result = project(value, REPORT_KEYS)
    if "stats" in result:
        result["stats"] = project(result["stats"], STATS_KEYS)
    return result


def evidence_metadata(name, value, secret=""):
    """Only schemas with metadata/hashes/counts can cross onto Drive."""
    if name == "compaction-manifest.json":
        result = project(value, MANIFEST_KEYS)
        require(result.get("owner") == OWNER, "저장된 정리 계획의 소유자가 다릅니다.")
        result["parents"] = [project(row, DESCRIPTOR_KEYS) for row in result.get("parents", [])]
        result["candidates"] = [project(row.get("record", row), DESCRIPTOR_KEYS)
                                for row in result.get("candidates", [])]
        if "verification" in result:
            result["verification"] = project(result["verification"], VERIFICATION_KEYS)
        for key in ("before", "after"):
            if key in result:
                result[key] = report_metadata(result[key])
    elif name == "cutover-arguments.json":
        expected = {"p_user_id", "p_operation_id", "p_expected_sources", "p_candidates", "p_verification"}
        require(isinstance(value, dict) and set(value) == expected,
                "저장된 원자적 전환 인자의 형식이 다릅니다.")
        require(value["p_user_id"] == OWNER, "저장된 전환 인자의 소유자가 다릅니다.")
        for key in ("p_expected_sources", "p_candidates"):
            require(isinstance(value[key], list) and value[key], "저장된 전환 목록이 없습니다.")
            for row in value[key]:
                require(isinstance(row, dict) and set(row) == DESCRIPTOR_KEYS,
                        "저장된 전환 원천 설명이 다릅니다.")
        require(isinstance(value["p_verification"], dict) and
                set(value["p_verification"]) == VERIFICATION_KEYS, "저장된 검증 인자가 다릅니다.")
        result = value  # Preserve every exact value; never regenerate an operation or candidate ID.
    elif name == "cutover-receipt.json":
        result = project(value, RECEIPT_KEYS)
        require(result.get("user_id") == OWNER, "저장된 전환 영수증의 소유자가 다릅니다.")
        if "verification" in result:
            result["verification"] = project(result["verification"], VERIFICATION_KEYS)
        if "original_source_evidence" in result:
            result["original_source_evidence"] = [
                project(row, {"id", "min_date", "max_date", "activated_at", "created_at"})
                for row in result["original_source_evidence"]
            ]
    elif name in ("before.json", "after.json"):
        result = report_metadata(value)
    else:
        raise RuntimeError("허용된 검증 메타데이터 파일이 아닙니다.")
    assert_safe_metadata(result, secret)
    return result


def load_json(path):
    path = Path(path)
    require(path.is_file() and not path.is_symlink() and path.stat().st_size <= MAX_METADATA_BYTES,
            "검증 메타데이터 파일이 없거나 안전하지 않습니다.")
    return json.loads(path.read_text(encoding="utf-8"))


def atomic_json(path, value):
    path = Path(path)
    require(not path.is_symlink(), "검증 기록 경로가 심볼릭 링크입니다.")
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    require(not temporary.is_symlink(), "검증 기록 임시 경로가 안전하지 않습니다.")
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2, allow_nan=False)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def copy_evidence(output, evidence, secret="", strict=False):
    """Never recursively copy the output directory; it contains raw CSVs."""
    copied, failed = [], []
    for name in EVIDENCE_FILES:
        source = Path(output) / name
        if not source.exists():
            continue
        try:
            safe = evidence_metadata(name, load_json(source), secret)
            atomic_json(Path(evidence) / name, safe)
            copied.append(name)
        except Exception:
            # Concurrent writes may be incomplete. Keep prior verified copy and retry later.
            failed.append(name)
    if strict:
        require(not failed, "일부 검증 기록을 Drive에 보존하지 못했습니다. 로컬 기록을 지우지 마세요.")
    return {"copied": copied, "pending": failed}


def provenance():
    return {"purpose": PURPOSE, "sourceBase": SOURCE_BASE, "bundleSha256": BUNDLE_SHA256,
            "owner": OWNER, "localOutput": str(LOCAL_OUTPUT), "expectedSourceHash": EXPECTED_SOURCE_HASH}


def restore_evidence(output, evidence):
    output, evidence = Path(output), Path(evidence)
    for directory in (output, evidence):
        require(not directory.is_symlink(), "검증 기록 폴더가 심볼릭 링크입니다.")
        marker = directory / "launcher-provenance.json"
        if marker.exists():
            require(load_json(marker) == provenance(), "이전 실행의 코드/소유자 정보가 다릅니다.")
        elif any((directory / name).exists() for name in EVIDENCE_FILES):
            raise RuntimeError("출처가 확인되지 않은 기존 정리 기록이 있습니다. 더 실행하지 마세요.")
    output.mkdir(parents=True, exist_ok=True)
    evidence.mkdir(parents=True, exist_ok=True)
    for name in EVIDENCE_FILES:
        local, saved = output / name, evidence / name
        local_value = evidence_metadata(name, load_json(local)) if local.exists() else None
        saved_value = evidence_metadata(name, load_json(saved)) if saved.exists() else None
        if local_value is not None and saved_value is not None:
            if name == "cutover-arguments.json":
                require(local_value == saved_value, "로컬/Drive의 정확한 전환 인자가 다릅니다.")
            if name == "compaction-manifest.json":
                require(local_value.get("operationId") == saved_value.get("operationId"),
                        "로컬/Drive의 정리 작업 ID가 다릅니다.")
        if local_value is None and saved_value is not None:
            atomic_json(local, saved_value)
    if (output / "cutover-arguments.json").exists() and (output / "compaction-manifest.json").exists():
        args = load_json(output / "cutover-arguments.json")
        plan = load_json(output / "compaction-manifest.json")
        require(args["p_operation_id"] == plan.get("operationId"), "정리 계획과 전환 작업 ID가 다릅니다.")
        require([row["id"] for row in args["p_candidates"]] == plan.get("plannedCandidateIds"),
                "정리 계획과 전환 후보 ID가 다릅니다.")
    for directory in (output, evidence):
        atomic_json(directory / "launcher-provenance.json", provenance())


def clean_environment(node=None, home=None):
    # Never inherit NODE_OPTIONS, NPM_CONFIG_*, .env secrets, Python notebook keys, etc.
    env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8",
           "CI": "1", "NPM_CONFIG_REGISTRY": "https://registry.npmjs.org/",
           "NPM_CONFIG_USERCONFIG": "/dev/null", "NPM_CONFIG_GLOBALCONFIG": "/dev/null"}
    if node:
        env["PATH"] = str(Path(node).parent) + ":" + env["PATH"]
    if home:
        env["HOME"] = str(home)
        env["NPM_CONFIG_CACHE"] = str(Path(home) / "npm-cache")
    return env


def archive_path(name):
    require(isinstance(name, str) and name and "\\" not in name and "\x00" not in name,
            "압축 파일 경로가 안전하지 않습니다.")
    path = PurePosixPath(name)
    require(not path.is_absolute() and all(part not in ("", ".", "..") for part in name.rstrip("/").split("/"))
            and ":" not in name, "압축 파일 경로 이동을 거부했습니다.")
    return path


def safe_extract_zip(archive, destination):
    """Validate every entry before writing any, reject links/duplicates/data."""
    destination = Path(destination)
    require(destination.is_dir() and not destination.is_symlink() and not any(destination.iterdir()),
            "압축 해제 경로는 비어 있는 새 로컬 폴더여야 합니다.")
    with zipfile.ZipFile(archive) as bundle:
        seen, entries, total = set(), [], 0
        for info in bundle.infolist():
            path = archive_path(info.filename)
            name = str(path)
            mode = info.external_attr >> 16
            filetype = stat.S_IFMT(mode)
            require(filetype in (0, stat.S_IFREG, stat.S_IFDIR), "압축 파일의 링크/특수 파일을 거부했습니다.")
            require(name not in seen and not info.flag_bits & 1, "압축 파일 중복/암호화 항목을 거부했습니다.")
            seen.add(name)
            require(not any(part.startswith(".") or part in ("node_modules", "__pycache__") for part in path.parts),
                    "압축 파일에는 숨김 설정/의존성을 포함할 수 없습니다.")
            if not info.is_dir():
                require(path.suffix in (".ts", ".tsx", ".js", ".mjs", ".cjs", ".json"),
                        "실행 압축 파일에는 코드/설정만 포함할 수 있습니다.")
            total += info.file_size
            require(total <= MAX_EXPANDED_BYTES and len(seen) <= 5000, "실행 압축 파일 크기 제한을 넘었습니다.")
            entries.append((info, path))
        for info, path in entries:
            target = destination.joinpath(*path.parts)
            if info.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with bundle.open(info) as source, target.open("xb") as output:
                    shutil.copyfileobj(source, output, 1024 * 1024)
                target.chmod(0o600)


def validate_bundle_metadata(runtime):
    runtime = Path(runtime)
    manifest = load_json(runtime / METADATA_NAME)
    require(manifest.get("formatVersion") == 1 and manifest.get("purpose") == PURPOSE and
            manifest.get("sourceBase") == SOURCE_BASE, "실행 코드의 고정 버전 정보가 다릅니다.")
    files = manifest.get("files")
    require(isinstance(files, dict) and files, "실행 코드 파일 해시 목록이 없습니다.")
    actual = {file.relative_to(runtime).as_posix() for file in runtime.rglob("*") if file.is_file()}
    require(actual == set(files) | {METADATA_NAME}, "실행 코드 파일 목록이 다릅니다.")
    required = {"package.json", "package-lock.json", "vitest.compaction.config.ts",
                "scripts/run-screening-compaction.ts", "scripts/verify-screening-compaction.ts"}
    require(required <= set(files), "실행에 필요한 고정 코드가 없습니다.")
    for name, digest in files.items():
        archive_path(name)
        require(isinstance(digest, str) and re.fullmatch(r"[a-f0-9]{64}", digest) and
                sha256_file(runtime / name) == digest, "실행 코드 내부 해시가 다릅니다.")
    lock = load_json(runtime / "package-lock.json")
    require(lock.get("lockfileVersion") in (2, 3) and isinstance(lock.get("packages"), dict),
            "고정 npm 의존성 목록이 없습니다.")
    for name, package in lock["packages"].items():
        if not name:
            continue
        resolved, integrity = package.get("resolved", ""), package.get("integrity", "")
        require(isinstance(resolved, str) and resolved.startswith("https://registry.npmjs.org/") and
                isinstance(integrity, str) and re.match(r"sha(?:256|384|512)-", integrity),
                "공식 npm 레지스트리/무결성 해시 없는 의존성을 거부했습니다.")
    return manifest


def prepare_runtime(bundle, content=Path("/content")):
    require(re.fullmatch(r"[a-f0-9]{64}", BUNDLE_SHA256) is not None,
            "배포용 ZIP 해시가 아직 채워지지 않았습니다. 이 준비본은 실행하지 마세요.")
    bundle = Path(bundle)
    require(bundle.is_file() and not bundle.is_symlink() and bundle.stat().st_size <= MAX_BUNDLE_BYTES,
            "CloudTrend 폴더에 검증된 실행 ZIP이 없습니다.")
    runtime = Path(tempfile.mkdtemp(prefix="cloudtrend-compaction-runtime-", dir=content))
    # Copy into local storage before hashing/extracting, closing the Drive change race.
    local_zip = runtime / "pinned-runtime.zip"
    shutil.copyfile(bundle, local_zip)
    require(sha256_file(local_zip) == BUNDLE_SHA256, "실행 ZIP 해시가 다릅니다. 수정된 코드는 실행하지 않습니다.")
    code = runtime / "code"
    code.mkdir(mode=0o700)
    safe_extract_zip(local_zip, code)
    validate_bundle_metadata(code)
    return code


def download_official(url, destination, limit):
    require(url.startswith(f"https://nodejs.org/dist/v{NODE_VERSION}/"), "공식 Node 배포 주소만 사용합니다.")
    request = urllib.request.Request(url, headers={"User-Agent": "CloudTrend-compaction-launcher/1"})
    with urllib.request.urlopen(request, timeout=60) as response, Path(destination).open("xb") as output:
        require(response.geturl().startswith(f"https://nodejs.org/dist/v{NODE_VERSION}/"),
                "Node 다운로드가 공식 배포 주소를 벗어났습니다.")
        count = 0
        while True:
            block = response.read(1024 * 1024)
            if not block:
                break
            count += len(block)
            require(count <= limit, "Node 다운로드 크기 제한을 넘었습니다.")
            output.write(block)


def ensure_node(runtime):
    require(platform.system() == "Linux" and platform.machine() in ("x86_64", "AMD64"),
            "이 셀은 Linux x64 Colab 런타임용입니다.")
    env = clean_environment()
    if EXISTING_NODE.is_file():
        version = subprocess.check_output([str(EXISTING_NODE), "--version"], env=env, text=True).strip()
        require(version == f"v{NODE_VERSION}", "기존 Node 버전이 다릅니다.")
        node = EXISTING_NODE
    else:
        install = Path(runtime).parent / "official-node"
        install.mkdir(mode=0o700)
        checksums, archive = install / "SHASUMS256.txt", install / f"{NODE_NAME}.tar.xz"
        base = f"https://nodejs.org/dist/v{NODE_VERSION}/"
        download_official(base + checksums.name, checksums, 1024 * 1024)
        matches = [line.split()[0] for line in checksums.read_text().splitlines()
                   if len(line.split()) == 2 and line.split()[1].lstrip("*") == archive.name]
        require(len(matches) == 1 and re.fullmatch(r"[a-f0-9]{64}", matches[0]),
                "공식 Node 체크섬을 확인할 수 없습니다.")
        download_official(base + archive.name, archive, 80 * 1024 * 1024)
        require(sha256_file(archive) == matches[0], "Node 배포 파일 체크섬이 다릅니다.")
        # Ignore npm/corepack convenience links; invoke npm's real .js file directly.
        with tarfile.open(archive, "r:xz") as source:
            total = 0
            for member in source:
                relative = archive_path(member.name)
                require(relative.parts[0] == NODE_NAME, "Node 압축 파일 경로가 다릅니다.")
                if member.issym() or member.islnk():
                    continue
                require(member.isdir() or member.isfile(), "Node 특수 파일을 거부했습니다.")
                total += member.size
                require(total <= 300 * 1024 * 1024, "Node 압축 해제 크기 제한을 넘었습니다.")
                target = install.joinpath(*relative.parts)
                if member.isdir():
                    target.mkdir(parents=True, exist_ok=True)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with source.extractfile(member) as src, target.open("xb") as dest:
                        shutil.copyfileobj(src, dest)
                    target.chmod(0o700 if member.mode & 0o111 else 0o600)
        node = install / NODE_NAME / "bin/node"
        require(subprocess.check_output([str(node), "--version"], env=env, text=True).strip() ==
                f"v{NODE_VERSION}", "설치된 Node 버전이 다릅니다.")
    require((node.parent.parent / "lib/node_modules/npm/bin/npm-cli.js").is_file(),
            "공식 Node의 npm 실행 파일이 없습니다.")
    return node


def active_publishers(proc_root=Path("/proc"), excluded=()):
    found = []
    patterns = ("colab-register-only.ts", "run-screening-compaction.ts", "ingest-source.ts",
                "publish-screening", "register-screening", "colab-screening-compaction.py")
    excluded = set(excluded) | {os.getpid()}
    for entry in Path(proc_root).iterdir():
        if not entry.name.isdigit() or int(entry.name) in excluded:
            continue
        try:
            raw = (entry / "cmdline").read_bytes()
            args = [part.decode(errors="replace") for part in raw.split(b"\0") if part]
            if args and any(Path(arg).name in patterns for arg in args):
                found.append(int(entry.name))
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            pass
    return found


@contextmanager
def exclusive_lock(path=LOCK_PATH):
    require(not Path(path).is_symlink(), "잠금 파일 경로가 안전하지 않습니다.")
    with Path(path).open("a+") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("다른 정리 셀이 실행 중입니다. 중복 실행하지 마세요.") from None
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def select_command(node, runtime, output):
    has_args = (Path(output) / "cutover-arguments.json").is_file()
    require(not (Path(output) / "cutover-receipt.json").exists() or has_args,
            "전환 영수증은 있지만 정확한 재시도 인자가 없습니다. 새 정리를 시작하지 않습니다.")
    mode = "--retry-cutover" if has_args else "--apply"
    command = [str(node), "--max-old-space-size=4096",
            str(Path(runtime) / "node_modules/vite-node/vite-node.mjs"),
            "--config", "vitest.compaction.config.ts", "scripts/run-screening-compaction.ts", "--",
            "--user-id", OWNER, "--output", str(output)]
    command += ["--expected-source-hash", EXPECTED_SOURCE_HASH]
    return command + [mode]


def safe_runtime_line(line, secret=""):
    # Unknown diagnostics may include source rows: omit their content from persisted logs.
    line = str(line).strip()
    if PHASE_PATTERN.fullmatch(line):
        return redact(line, secret)
    try:
        value = json.loads(line)
        if isinstance(value, dict) and value.get("state") in (
                "verified_local_only", "cutover_verified", "cutover_receipt_verified"):
            safe = project(value, {"state", "fromFiles", "toFiles", "originalBytes", "candidateBytes",
                                   "datasetParity", "analysisParity", "operationId", "activeFiles", "originalsRetained"})
            assert_safe_metadata(safe, secret)
            return json.dumps(safe, ensure_ascii=False)
    except (ValueError, RuntimeError):
        pass
    return "[진단 내용 생략: 원시 행/키의 기록 방지]" if line else ""


def terminate_process_group(process):
    # A verifier grandchild can outlive an exited parent; signal the whole group even then.
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait(timeout=10)


def run_logged(command, cwd, env, log_path, *, secret="", runtime_output=False,
               heartbeat=20, checkpoint=None):
    events = queue.Queue()
    started, last_heartbeat = time.monotonic(), time.monotonic()
    process = subprocess.Popen(command, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                               errors="replace", bufsize=1, start_new_session=True)

    def drain():
        try:
            for line in process.stdout:
                events.put(line)
        finally:
            events.put(None)

    threading.Thread(target=drain, daemon=True).start()
    try:
        with Path(log_path).open("a", encoding="utf-8") as log:
            ended = False
            while not ended:
                now = time.monotonic()
                if now - last_heartbeat >= heartbeat:
                    progress = f"[진행 확인] {int(now - started)}초 경과 · 결과 검증 대기 중"
                    print(progress, flush=True)
                    log.write(progress + "\n")
                    log.flush()
                    if checkpoint:
                        checkpoint()
                    last_heartbeat = now
                try:
                    line = events.get(timeout=min(1, heartbeat))
                except queue.Empty:
                    continue
                if line is None:
                    ended = True
                    continue
                safe = safe_runtime_line(line, secret) if runtime_output else redact(line.rstrip(), secret)
                if safe:
                    print(safe, flush=True)
                    log.write(safe + "\n")
                    log.flush()
            code = process.wait(timeout=10)
            require(code == 0, f"실행 도구 종료 코드 {code}. 기록을 보존했습니다. 같은 셀로 안전하게 재시도할 수 있습니다.")
            return code
    except BaseException:
        terminate_process_group(process)
        raise
    finally:
        process.stdout.close()


def install_dependencies(runtime, node, log_path):
    home = Path(runtime).parent / "isolated-home"
    home.mkdir(mode=0o700)
    env = clean_environment(node, home)
    npm = node.parent.parent / "lib/node_modules/npm/bin/npm-cli.js"
    run_logged([str(node), str(npm), "ci", "--ignore-scripts", "--include=dev", "--include=optional",
                "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org/"],
               runtime, env, log_path)
    require((Path(runtime) / "node_modules/vite-node/vite-node.mjs").is_file(),
            "고정 의존성 설치 후 vite-node가 없습니다.")
    return env


def read_colab_secret():
    # This is the only secret read. It is deliberately after all installation and validation.
    from google.colab import userdata
    try:
        value = userdata.get("SUPABASE_SERVICE_ROLE_KEY")
    except Exception:
        raise RuntimeError("기존 Colab Secrets의 SUPABASE_SERVICE_ROLE_KEY 접근을 확인하세요. 키를 채팅에 보내지 마세요.") from None
    require(isinstance(value, str) and value.strip(), "기존 Colab Secret이 없습니다. 키를 채팅에 보내지 마세요.")
    return value.strip()


def main():
    require(Path("/content").is_dir(), "이 준비본은 사용자의 기존 Colab에서 실행하세요.")
    require(DRIVE_FOLDER.is_dir(), "기존 Colab에 CloudTrend Google Drive 폴더를 먼저 연결하세요.")
    require(not LOCAL_OUTPUT.is_symlink() and "/drive/" not in str(LOCAL_OUTPUT.resolve()),
            "원시 파일 출력은 Colab 로컬 디스크만 허용합니다.")
    secret, child_env, log_path = "", None, None
    status = {"purpose": PURPOSE, "startedAt": utc_now(), "state": "preparing",
              "sourceBase": SOURCE_BASE, "bundleSha256": BUNDLE_SHA256, "owner": OWNER,
              "expectedSourceHash": EXPECTED_SOURCE_HASH}
    with exclusive_lock():
        require(not active_publishers(), "기존 수집/등록/정리 프로세스가 실행 중입니다. 먼저 끝날 때까지 기다리세요.")
        require(shutil.disk_usage("/content").free >= 8 * 1024 ** 3, "원본 보존·검증용 로컬 여유 공간 8 GiB가 필요합니다.")
        runtime = prepare_runtime(DRIVE_FOLDER / BUNDLE_NAME)
        restore_evidence(LOCAL_OUTPUT, EVIDENCE_DIR)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        log_path = LOCAL_OUTPUT / f"launcher-{stamp}.log"
        status_path = EVIDENCE_DIR / f"launcher-{stamp}.json"
        try:
            print("[확인] 고정 코드·실행 기록 확인 완료. 공식 Node/npm 의존성 준비 중", flush=True)
            node = ensure_node(runtime)
            public_env = install_dependencies(runtime, node, log_path)
            # npm must not modify reviewed code/lock/config. node_modules alone is new.
            manifest = load_json(runtime / METADATA_NAME)
            for name, digest in manifest["files"].items():
                require(sha256_file(runtime / name) == digest, "설치 중 검증된 코드/설정이 바뀌었습니다.")
            require(not active_publishers(), "설치 중 다른 수집/등록 실행이 시작됐습니다. 중복 실행하지 마세요.")
            command = select_command(node, runtime, LOCAL_OUTPUT)
            status.update(state="retrying_cutover" if command[-1] == "--retry-cutover" else "running")
            atomic_json(status_path, status)
            secret = read_colab_secret()
            child_env = dict(public_env)
            child_env.update(SUPABASE_URL=SUPABASE_URL, SUPABASE_USER_ID=OWNER,
                             SUPABASE_SERVICE_ROLE_KEY=secret,
                             GITHUB_SHA=f"{SOURCE_BASE}+compaction-bundle:{BUNDLE_SHA256}")
            print("[실행] 저장된 전환 인자를 그대로 재확인합니다" if command[-1] == "--retry-cutover" else
                  "[실행] 원본 해시 → 정리 파일 → 실제 데이터/분석 일치 → 원자적 전환 순서로 검증합니다", flush=True)
            run_logged(command, runtime, child_env, log_path, secret=secret, runtime_output=True,
                       checkpoint=lambda: copy_evidence(LOCAL_OUTPUT, EVIDENCE_DIR, secret))
            require((LOCAL_OUTPUT / "cutover-receipt.json").is_file(), "전환 영수증이 없습니다. 성공으로 표시하지 않습니다.")
            evidence_metadata("cutover-receipt.json", load_json(LOCAL_OUTPUT / "cutover-receipt.json"), secret)
            status["state"] = "completed"
        except KeyboardInterrupt:
            status["state"] = "interrupted"
            print("중단했습니다. 원본과 전환 기록은 보존합니다. 같은 셀을 다시 실행하면 저장된 단계에서 검증합니다.", flush=True)
        except Exception as error:
            status.update(state="stopped", error=redact(str(error), secret))
            print("중단: " + status["error"], flush=True)
        finally:
            status["finishedAt"] = utc_now()
            result = copy_evidence(LOCAL_OUTPUT, EVIDENCE_DIR, secret)
            status["evidence"] = result
            if result["pending"]:
                status["state"] = "evidence_save_incomplete"
                print("Drive 검증 기록 일부를 저장하지 못했습니다. Colab 로컬 파일을 지우지 마세요.", flush=True)
            # Logs were sanitized before local persistence; redact again before Drive copy.
            try:
                if log_path and log_path.is_file():
                    # redact() bounds individual messages, not the complete log.
                    clean = "\n".join(redact(line, secret) for line in log_path.read_text(encoding="utf-8").splitlines()) + "\n"
                    (EVIDENCE_DIR / log_path.name).write_text(clean, encoding="utf-8")
                assert_safe_metadata({key: value for key, value in status.items() if key != "error"}, secret)
                atomic_json(status_path, status)
            finally:
                if child_env is not None:
                    child_env.pop("SUPABASE_SERVICE_ROLE_KEY", None)
                secret = ""
        if status["state"] == "completed":
            print("원천 정리·실제 분석 일치·전환 영수증 확인 완료. 원본은 모두 보존했습니다.", flush=True)
            print("검증 기록: CloudTrend/compaction_evidence/kr_screening_compaction_20261006", flush=True)
        return status  # Contains metadata only, never the service key or process environment.


if __name__ == "__main__":
    main()
