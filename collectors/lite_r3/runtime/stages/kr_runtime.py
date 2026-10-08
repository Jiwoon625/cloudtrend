#@title KR-2. 한국 v3.3 runtime 로드
if RUN_KR_MARKET:
    import hashlib as _kr_bundle_hashlib
    import io as _kr_bundle_io
    import zipfile as _kr_zipfile

    KR_REFERENCE_DIR = Path(globals()["KR_REFERENCE_DIR"])
    _kr_bundle_path = KR_REFERENCE_DIR / "cloudtrend_kr_v3_3_3_runtime.zip"
    _kr_bundle_bytes = _kr_bundle_path.read_bytes()
    _KR_RUNTIME_SHA256 = "91d4992be9a2d06916ee2e425cb43d210350eed5e73a83429dbb4d041c8b7aba"
    if _kr_bundle_hashlib.sha256(_kr_bundle_bytes).hexdigest() != _KR_RUNTIME_SHA256:
        raise RuntimeError("v3.3 수집 코드 파일이 변경되었거나 손상되었습니다. 올바른 파일을 복원하세요.")

    with _kr_zipfile.ZipFile(_kr_bundle_io.BytesIO(_kr_bundle_bytes)) as _kr_archive:
        _kr_steps = {name: _kr_archive.read(name).decode("utf-8") for name in _kr_archive.namelist()}

    def _kr_run_step(name, namespace):
        exec(compile(_kr_steps[name], str(_kr_bundle_path) + "/" + name, "exec"), namespace, namespace)

    print("한국 v3.3 runtime 준비 완료")
else:
    print("한국시장 SKIP")
