"""Offline/stub-only tests. Never install packages, use Colab keys, or call a service."""
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from unittest import mock
import copy
import importlib.util
import json
import os
import signal
import stat
import subprocess
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("colab_compaction", ROOT / "scripts/colab-screening-compaction.py")
launcher = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(launcher)


class TemporaryTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="compaction-launcher-test-")
        self.root = Path(self.temporary.name)
        self.addCleanup(self.temporary.cleanup)
        # Every test fails if it unexpectedly tries installation/network/secret access.
        self.no_network = mock.patch.object(launcher.urllib.request, "urlopen", side_effect=AssertionError("network forbidden in test"))
        self.no_secret = mock.patch.object(launcher, "read_colab_secret", side_effect=AssertionError("Colab secret forbidden in test"))
        self.no_subprocess = mock.patch.object(launcher.subprocess, "Popen", side_effect=AssertionError("real process forbidden in test"))
        self.no_check_output = mock.patch.object(launcher.subprocess, "check_output", side_effect=AssertionError("real process forbidden in test"))
        for patcher in (self.no_network, self.no_secret, self.no_subprocess, self.no_check_output):
            patcher.start()
            self.addCleanup(patcher.stop)

    def archive(self, entries):
        archive = self.root / "test.zip"
        with zipfile.ZipFile(archive, "w") as output:
            for name, content in entries:
                output.writestr(name, content)
        dest = self.root / "extracted"
        dest.mkdir()
        return archive, dest


def descriptor(label="id"):
    return {key: (123 if key in {"file_size_bytes", "normalized_size_bytes", "row_count"}
                  else None if key == "activated_at" else launcher.OWNER if key == "user_id"
                  else label if key == "id" else "metadata") for key in launcher.DESCRIPTOR_KEYS}


def verification():
    return {key: (103 if key == "schema_version" else 10 if key.startswith("effective_rows")
                  else "sha256:" + "a" * 64) for key in launcher.VERIFICATION_KEYS}


def arguments():
    return {"p_user_id": launcher.OWNER, "p_operation_id": "operation-one",
            "p_expected_sources": [descriptor("parent")], "p_candidates": [descriptor("candidate")],
            "p_verification": verification()}


def receipt():
    return {"user_id": launcher.OWNER, "operation_id": "operation-one", "source_type": "screening",
            "parent_ids": ["parent"], "candidate_ids": ["candidate"], "committed_at": "2026-10-06T16:00:00Z",
            "verification": verification(), "reused": False, "original_source_evidence": [
                {"id": "parent", "min_date": "2025-01-01", "max_date": "2026-10-06",
                 "created_at": "2026-10-06T12:00:00Z", "activated_at": "2026-10-06T12:01:00Z"}]}


def manifest():
    return {"operationId": "operation-one", "owner": launcher.OWNER, "validatorFingerprint": "fingerprint",
            "parents": [descriptor("parent")], "candidates": [{"file": "/content/local.csv", "record": descriptor("candidate")}],
            "plannedCandidateIds": ["candidate"], "state": "staged_inactive", "verification": verification(),
            "before": {"datasetDigest": "digest", "stats": {"stocks": 1, "bars": 10}},
            "after": {"datasetDigest": "digest", "stats": {"stocks": 1, "bars": 10}}}


class ArchiveTests(TemporaryTest):
    def test_extracts_regular_code_only(self):
        archive, dest = self.archive([("scripts/main.ts", "export {}"), ("package.json", "{}")])
        launcher.safe_extract_zip(archive, dest)
        self.assertEqual((dest / "scripts/main.ts").read_text(), "export {}")

    def test_traversal_absolute_backslash_windows_and_empty_components_rejected(self):
        for name in ("../escape.ts", "/escape.ts", "src/../../escape.ts", "src\\escape.ts", "C:/escape.ts", "src//escape.ts", "./escape.ts"):
            with self.subTest(name=name), tempfile.TemporaryDirectory(dir=self.root) as temp:
                archive, dest = Path(temp) / "a.zip", Path(temp) / "out"
                dest.mkdir()
                with zipfile.ZipFile(archive, "w") as output:
                    output.writestr("safe.ts", "safe")
                    output.writestr(name, "bad")
                with self.assertRaises(RuntimeError):
                    launcher.safe_extract_zip(archive, dest)
                self.assertEqual(list(dest.iterdir()), [])  # Full validation precedes any extraction.

    def test_symlink_and_special_file_rejected(self):
        for mode in (stat.S_IFLNK | 0o777, stat.S_IFIFO | 0o600):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory(dir=self.root) as temp:
                archive, dest = Path(temp) / "a.zip", Path(temp) / "out"
                dest.mkdir()
                entry = zipfile.ZipInfo("link.ts")
                entry.create_system = 3
                entry.external_attr = mode << 16
                with zipfile.ZipFile(archive, "w") as output:
                    output.writestr(entry, "../../escape")
                with self.assertRaises(RuntimeError):
                    launcher.safe_extract_zip(archive, dest)

    def test_rejects_existing_destination_symlink_and_csv_or_dotenv(self):
        for name in ("source.csv", ".env", "src/.npmrc", "node_modules/module.js"):
            with self.subTest(name=name), tempfile.TemporaryDirectory(dir=self.root) as temp:
                archive, dest = Path(temp) / "a.zip", Path(temp) / "out"
                dest.mkdir()
                with zipfile.ZipFile(archive, "w") as output:
                    output.writestr(name, "unsafe")
                with self.assertRaises(RuntimeError):
                    launcher.safe_extract_zip(archive, dest)
        archive, dest = self.archive([("safe.ts", "safe")])
        (dest / "existing.ts").write_text("preserve")
        with self.assertRaises(RuntimeError):
            launcher.safe_extract_zip(archive, dest)
        self.assertEqual((dest / "existing.ts").read_text(), "preserve")

    def test_placeholder_and_modified_bundle_fail_closed(self):
        bundle = self.root / "bundle.zip"
        bundle.write_bytes(b"modified bytes")
        with mock.patch.object(launcher, "BUNDLE_SHA256", "__FINAL_RUNTIME_ZIP_SHA256__"):
            with self.assertRaisesRegex(RuntimeError, "해시가 아직"):
                launcher.prepare_runtime(bundle, self.root)
        with mock.patch.object(launcher, "BUNDLE_SHA256", "a" * 64):
            with self.assertRaisesRegex(RuntimeError, "ZIP 해시가 다릅니다"):
                launcher.prepare_runtime(bundle, self.root)

    def test_manifest_hashes_source_base_and_official_lock_are_checked(self):
        runtime = self.root / "code"
        (runtime / "scripts").mkdir(parents=True)
        files = {"package.json": "{}", "vitest.compaction.config.ts": "export default {}",
                 "scripts/run-screening-compaction.ts": "export {}", "scripts/verify-screening-compaction.ts": "export {}",
                 "package-lock.json": json.dumps({"lockfileVersion": 3, "packages": {"": {}, "node_modules/a": {
                     "resolved": "https://registry.npmjs.org/a/-/a-1.tgz", "integrity": "sha512-test"}}})}
        for name, value in files.items():
            (runtime / name).write_text(value)
        metadata = {"formatVersion": 1, "sourceBase": launcher.SOURCE_BASE, "purpose": launcher.PURPOSE,
                    "files": {name: launcher.sha256_file(runtime / name) for name in files}}
        launcher.atomic_json(runtime / launcher.METADATA_NAME, metadata)
        self.assertEqual(launcher.validate_bundle_metadata(runtime), metadata)
        (runtime / "scripts/run-screening-compaction.ts").write_text("modified")
        with self.assertRaises(RuntimeError):
            launcher.validate_bundle_metadata(runtime)
        (runtime / "scripts/run-screening-compaction.ts").write_text(files["scripts/run-screening-compaction.ts"])
        lock = json.loads(files["package-lock.json"])
        lock["packages"]["node_modules/a"]["resolved"] = "https://untrusted.invalid/package.tgz"
        launcher.atomic_json(runtime / "package-lock.json", lock)
        metadata["files"]["package-lock.json"] = launcher.sha256_file(runtime / "package-lock.json")
        launcher.atomic_json(runtime / launcher.METADATA_NAME, metadata)
        with self.assertRaisesRegex(RuntimeError, "공식 npm"):
            launcher.validate_bundle_metadata(runtime)


class EvidenceTests(TemporaryTest):
    def test_redaction_covers_exact_secret_tokens_urls_and_assignments(self):
        secret = "nonstandard-local-secret"
        value = "prefix " + secret + " eyJabc.def.ghi sb_secret_123xyz https://example.test/?key=token apikey=abc"
        clean = launcher.redact(value, secret)
        for unsafe in (secret, "eyJabc.def.ghi", "sb_secret_123xyz", "example.test", "apikey=abc"):
            self.assertNotIn(unsafe, clean)

    def test_manifest_projection_drops_raw_payloads_paths_and_validation_details(self):
        value = manifest()
        value["rows"] = [{"close": 123}]
        value["candidates"][0]["record"]["validation_result"] = {"canonicalCsv": "raw rows", "secret": "do not persist"}
        value["before"]["dataset"] = {"bars": [1, 2, 3]}
        value["before"]["stats"]["rawRows"] = [1, 2, 3]
        clean = launcher.evidence_metadata("compaction-manifest.json", value)
        encoded = json.dumps(clean)
        for forbidden in ("raw rows", "rawRows", "canonicalCsv", "do not persist", "/content/local.csv", '"dataset"'):
            self.assertNotIn(forbidden, encoded)
        self.assertEqual(clean["plannedCandidateIds"], ["candidate"])
        self.assertEqual(clean["parents"], value["parents"])

    def test_exact_cutover_arguments_are_not_modified(self):
        value = arguments()
        original = copy.deepcopy(value)
        clean = launcher.evidence_metadata("cutover-arguments.json", value)
        self.assertEqual(clean, original)
        self.assertIs(clean, value)
        value["p_candidates"][0]["raw"] = "source row"
        with self.assertRaises(RuntimeError):
            launcher.evidence_metadata("cutover-arguments.json", value)

    def test_receipt_preserves_original_collection_timestamps_and_timing_proof(self):
        value = receipt()
        clean = launcher.evidence_metadata("cutover-receipt.json", value)
        self.assertEqual(clean["original_source_evidence"], value["original_source_evidence"])
        self.assertEqual(clean["verification"]["timing_before"], value["verification"]["timing_before"])
        self.assertEqual(clean["verification"]["timing_after"], value["verification"]["timing_after"])
        self.assertEqual(launcher.evidence_metadata("cutover-arguments.json", arguments()), arguments())

    def test_secret_in_allowlisted_field_rejected_not_persisted(self):
        output, evidence = self.root / "local", self.root / "drive"
        output.mkdir()
        evidence.mkdir()
        prior = manifest()
        launcher.atomic_json(evidence / "compaction-manifest.json", prior)
        value = manifest()
        value["validatorFingerprint"] = "test-service-key"
        launcher.atomic_json(output / "compaction-manifest.json", value)
        result = launcher.copy_evidence(output, evidence, "test-service-key")
        self.assertEqual(result["pending"], ["compaction-manifest.json"])
        self.assertEqual(launcher.load_json(evidence / "compaction-manifest.json"), prior)
        self.assertNotIn("test-service-key", (evidence / "compaction-manifest.json").read_text())

    def test_copy_never_moves_raw_csv_arbitrary_json_or_env_to_drive(self):
        output, evidence = self.root / "local", self.root / "drive"
        (output / "sources").mkdir(parents=True)
        evidence.mkdir()
        (output / "sources/source.raw").write_text("unapproved raw bytes")
        (output / "candidate.csv").write_text("unapproved CSV bytes")
        (output / "unknown.json").write_text('{"secret":"unapproved"}')
        (output / ".env").write_text("KEY=unapproved")
        launcher.atomic_json(output / "compaction-manifest.json", manifest())
        launcher.atomic_json(output / "cutover-arguments.json", arguments())
        launcher.atomic_json(output / "cutover-receipt.json", receipt())
        result = launcher.copy_evidence(output, evidence)
        self.assertFalse(result["pending"])
        self.assertEqual({p.name for p in evidence.iterdir()}, {
            "compaction-manifest.json", "cutover-arguments.json", "cutover-receipt.json"})
        self.assertNotIn("unapproved", "".join(p.read_text() for p in evidence.iterdir()))

    def test_restore_manifest_and_exact_arguments_after_local_runtime_loss(self):
        output, evidence = self.root / "local", self.root / "drive"
        evidence.mkdir()
        launcher.atomic_json(evidence / "launcher-provenance.json", launcher.provenance())
        launcher.atomic_json(evidence / "compaction-manifest.json", manifest())
        launcher.atomic_json(evidence / "cutover-arguments.json", arguments())
        launcher.restore_evidence(output, evidence)
        self.assertEqual(launcher.load_json(output / "cutover-arguments.json"), arguments())
        self.assertEqual(launcher.load_json(output / "compaction-manifest.json")["plannedCandidateIds"], ["candidate"])
        command = launcher.select_command(Path("/node"), Path("/runtime"), output)
        self.assertEqual(command[-1], "--retry-cutover")
        self.assertNotIn("--apply", command)

    def test_restore_conflicting_or_unknown_provenance_fails(self):
        output, evidence = self.root / "local", self.root / "drive"
        output.mkdir()
        evidence.mkdir()
        launcher.atomic_json(evidence / "compaction-manifest.json", manifest())
        with self.assertRaises(RuntimeError):
            launcher.restore_evidence(output, evidence)
        launcher.atomic_json(evidence / "launcher-provenance.json", launcher.provenance())
        launcher.restore_evidence(output, evidence)
        launcher.atomic_json(output / "cutover-arguments.json", arguments())
        other = arguments()
        other["p_operation_id"] = "different"
        launcher.atomic_json(evidence / "cutover-arguments.json", other)
        with self.assertRaises(RuntimeError):
            launcher.restore_evidence(output, evidence)

    def test_runtime_log_unknown_rows_and_secrets_are_omitted(self):
        secret = "unit-test-service-key"
        self.assertNotIn(secret, launcher.safe_runtime_line("Error: " + secret, secret))
        self.assertNotIn("005930", launcher.safe_runtime_line("005930,2026-10-06,10,20,30"))
        self.assertEqual(launcher.safe_runtime_line("Verify original 1/23"), "Verify original 1/23")
        line = json.dumps({"state": "cutover_verified", "activeFiles": 4, "receipt": {"secret": secret}, "rows": [123]})
        clean = launcher.safe_runtime_line(line, secret)
        self.assertNotIn(secret, clean)
        self.assertNotIn("rows", clean)
        self.assertEqual(json.loads(clean)["activeFiles"], 4)


class CommandTests(TemporaryTest):
    def test_command_keeps_config_without_broken_script_mode(self):
        command = launcher.select_command(Path("/node"), Path("/runtime"), self.root)
        self.assertEqual(command, ["/node", "--max-old-space-size=4096", "/runtime/node_modules/vite-node/vite-node.mjs",
                                   "--config", "vitest.compaction.config.ts", "scripts/run-screening-compaction.ts", "--",
                                   "--user-id", launcher.OWNER, "--output", str(self.root),
                                   "--expected-source-hash", launcher.EXPECTED_SOURCE_HASH, "--apply"])
        self.assertNotIn("--script", command)

    def test_receipt_without_retry_arguments_never_starts_new_compaction(self):
        launcher.atomic_json(self.root / "cutover-receipt.json", receipt())
        with self.assertRaisesRegex(RuntimeError, "새 정리를 시작하지"):
            launcher.select_command(Path("/node"), Path("/runtime"), self.root)

    def test_clean_environment_excludes_all_existing_keys_and_node_injection(self):
        with mock.patch.dict(os.environ, {"SUPABASE_SERVICE_ROLE_KEY": "unit-test-key", "OPENAI_API_KEY": "other-key",
                                          "NODE_OPTIONS": "--require=evil.js", "NPM_CONFIG_USERCONFIG": "/secret"}):
            env = launcher.clean_environment(Path("/official/bin/node"), self.root)
        self.assertNotIn("SUPABASE_SERVICE_ROLE_KEY", env)
        self.assertNotIn("OPENAI_API_KEY", env)
        self.assertNotIn("NODE_OPTIONS", env)
        self.assertEqual(env["NPM_CONFIG_USERCONFIG"], "/dev/null")
        self.assertTrue(env["PATH"].startswith("/official/bin:"))

    def test_existing_node_requires_exact_version_and_npm_without_network(self):
        node = self.root / "official/bin/node"
        npm = node.parent.parent / "lib/node_modules/npm/bin/npm-cli.js"
        node.parent.mkdir(parents=True)
        npm.parent.mkdir(parents=True)
        node.write_text("stub node executable")
        npm.write_text("stub npm executable")
        with mock.patch.object(launcher, "EXISTING_NODE", node), \
                mock.patch.object(launcher.platform, "system", return_value="Linux"), \
                mock.patch.object(launcher.platform, "machine", return_value="x86_64"), \
                mock.patch.object(launcher.subprocess, "check_output", return_value="v22.16.0\n"):
            self.assertEqual(launcher.ensure_node(self.root), node)
        with mock.patch.object(launcher, "EXISTING_NODE", node), \
                mock.patch.object(launcher.platform, "system", return_value="Linux"), \
                mock.patch.object(launcher.platform, "machine", return_value="x86_64"), \
                mock.patch.object(launcher.subprocess, "check_output", return_value="v24.0.0\n"):
            with self.assertRaisesRegex(RuntimeError, "기존 Node 버전"):
                launcher.ensure_node(self.root)

    def test_npm_ci_exact_ignore_scripts_and_official_registry(self):
        runtime, node = self.root / "code", self.root / "official/bin/node"
        (runtime / "node_modules/vite-node").mkdir(parents=True)
        (runtime / "node_modules/vite-node/vite-node.mjs").write_text("fixture")
        with mock.patch.object(launcher, "run_logged") as run:
            env = launcher.install_dependencies(runtime, node, self.root / "install.log")
        argv = run.call_args.args[0]
        self.assertEqual(argv[:3], [str(node), str(node.parent.parent / "lib/node_modules/npm/bin/npm-cli.js"), "ci"])
        self.assertIn("--ignore-scripts", argv)
        self.assertIn("--registry=https://registry.npmjs.org/", argv)
        self.assertIn("--include=dev", argv)
        self.assertNotIn("SUPABASE_SERVICE_ROLE_KEY", env)

    def test_proc_check_targets_argument_basenames_not_incidental_text(self):
        for pid, args in {
            90001: ["node", "/code/scripts/colab-register-only.ts"],
            90002: ["node", "/code/scripts/run-screening-compaction.ts"],
            90003: ["python", "-c", "text says colab-register-only.ts but is not an argument"],
            90004: ["node", "/code/scripts/ingest-source.ts"],
        }.items():
            (self.root / str(pid)).mkdir()
            (self.root / str(pid) / "cmdline").write_bytes(b"\0".join(arg.encode() for arg in args))
        self.assertEqual(sorted(launcher.active_publishers(self.root)), [90001, 90002, 90004])
        self.assertEqual(sorted(launcher.active_publishers(self.root, excluded=[90001])), [90002, 90004])

    def test_same_lock_cannot_be_acquired_twice(self):
        lock = self.root / "one.lock"
        with launcher.exclusive_lock(lock):
            with self.assertRaises(RuntimeError):
                with launcher.exclusive_lock(lock):
                    pass
        with launcher.exclusive_lock(lock):
            pass

    def test_interrupt_terminates_entire_process_group_and_escalates(self):
        process = mock.Mock(pid=900000, stdout=StringIO(""))
        process.poll.return_value = None
        process.wait.side_effect = [subprocess.TimeoutExpired("node", 10), 0]
        with mock.patch.object(launcher.os, "killpg") as kill:
            launcher.terminate_process_group(process)
        self.assertEqual(kill.call_args_list, [mock.call(900000, signal.SIGTERM), mock.call(900000, signal.SIGKILL)])

    def test_interrupt_signals_surviving_group_when_parent_already_exited(self):
        process = mock.Mock(pid=900000)
        process.poll.return_value = 0
        process.wait.return_value = 0
        with mock.patch.object(launcher.os, "killpg") as kill:
            launcher.terminate_process_group(process)
        kill.assert_called_once_with(900000, signal.SIGTERM)

    def test_run_logged_has_new_process_group_and_sanitized_output(self):
        process = mock.Mock(pid=900000, stdout=StringIO("Verify original 1/23\nError: key-unit-test\n"))
        process.wait.return_value = 0
        with mock.patch.object(launcher.subprocess, "Popen", return_value=process) as popen, redirect_stdout(StringIO()):
            launcher.run_logged(["node"], self.root, {}, self.root / "run.log", secret="key-unit-test", runtime_output=True)
        self.assertTrue(popen.call_args.kwargs["start_new_session"])
        self.assertEqual(popen.call_args.kwargs["stdin"], subprocess.DEVNULL)
        self.assertNotIn("key-unit-test", (self.root / "run.log").read_text())

    def test_run_logged_keyboard_interrupt_calls_group_termination(self):
        process = mock.Mock(pid=900000, stdout=StringIO(""))
        events = mock.Mock()
        events.get.side_effect = KeyboardInterrupt
        with mock.patch.object(launcher.subprocess, "Popen", return_value=process), \
                mock.patch.object(launcher.queue, "Queue", return_value=events), \
                mock.patch.object(launcher, "terminate_process_group") as terminate, redirect_stdout(StringIO()):
            with self.assertRaises(KeyboardInterrupt):
                launcher.run_logged(["node"], self.root, {}, self.root / "run.log")
        terminate.assert_called_once_with(process)


class StubbedMainTests(TemporaryTest):
    def setup_main(self, interrupt=False):
        output, drive, runtime = self.root / "output", self.root / "drive", self.root / "runtime"
        drive.mkdir()
        runtime.mkdir()
        evidence = drive / "evidence"
        launcher.atomic_json(runtime / launcher.METADATA_NAME, {"files": {}})
        timeline, seen_env = [], {}
        secret = "not-a-real-key-stub-only"

        def install(*unused):
            timeline.append("install")
            return launcher.clean_environment()

        def read_secret():
            timeline.append("secret")
            return secret

        def run(command, cwd, env, log_path, **kwargs):
            timeline.append("execute")
            seen_env.update(env)
            launcher.atomic_json(output / "compaction-manifest.json", manifest())
            launcher.atomic_json(output / "cutover-arguments.json", arguments())
            (output / "source.csv").write_text("raw price row with " + secret)
            (output / "raw-secret.txt").write_text(secret)
            Path(log_path).write_text("Verify original 1/23\n")
            if interrupt:
                raise KeyboardInterrupt
            launcher.atomic_json(output / "cutover-receipt.json", receipt())

        patches = []
        patches.extend([
            mock.patch.object(launcher, "DRIVE_FOLDER", drive), mock.patch.object(launcher, "EVIDENCE_DIR", evidence),
            mock.patch.object(launcher, "LOCAL_OUTPUT", output), mock.patch.object(launcher, "BUNDLE_SHA256", "a" * 64),
            mock.patch.object(launcher, "active_publishers", return_value=[]),
            mock.patch.object(launcher, "prepare_runtime", return_value=runtime),
            mock.patch.object(launcher, "ensure_node", return_value=self.root / "official/bin/node"),
            mock.patch.object(launcher, "install_dependencies", side_effect=install),
            mock.patch.object(launcher, "read_colab_secret", side_effect=read_secret),
            mock.patch.object(launcher, "run_logged", side_effect=run),
            mock.patch.object(launcher.shutil, "disk_usage", return_value=mock.Mock(free=20 * 1024 ** 3)),
            mock.patch.object(Path, "is_dir", return_value=True),
        ])
        for patcher in patches:
            patcher.start()
            self.addCleanup(patcher.stop)
        return output, evidence, timeline, seen_env, secret

    def test_install_precedes_secret_and_secret_never_persisted(self):
        output, evidence, timeline, env, secret = self.setup_main()
        with redirect_stdout(StringIO()):
            result = launcher.main()
        self.assertEqual(timeline, ["install", "secret", "execute"])
        self.assertEqual(result["state"], "completed")
        self.assertEqual(env["SUPABASE_SERVICE_ROLE_KEY"], secret)
        self.assertIn(launcher.SOURCE_BASE, env["GITHUB_SHA"])
        self.assertFalse((evidence / "source.csv").exists())
        self.assertNotIn(secret, "".join(path.read_text() for path in evidence.iterdir()))
        self.assertNotIn(secret, json.dumps(result))
        self.assertTrue((output / "source.csv").exists())  # Local/raw is retained.

    def test_install_failure_does_not_read_secret_or_start_compaction(self):
        output, evidence, timeline, env, secret = self.setup_main()
        with mock.patch.object(launcher, "install_dependencies", side_effect=RuntimeError("offline installation stub")), \
                mock.patch.object(launcher, "read_colab_secret") as read_secret, redirect_stdout(StringIO()):
            result = launcher.main()
        self.assertEqual(result["state"], "stopped")
        read_secret.assert_not_called()
        self.assertEqual(timeline, [])
        self.assertFalse((output / "cutover-arguments.json").exists())

    def test_interrupt_still_copies_exact_retry_arguments_in_finally(self):
        output, evidence, timeline, env, secret = self.setup_main(interrupt=True)
        with redirect_stdout(StringIO()):
            result = launcher.main()
        self.assertEqual(result["state"], "interrupted")
        self.assertEqual(launcher.load_json(evidence / "cutover-arguments.json"), arguments())
        self.assertEqual(launcher.select_command(Path("/node"), Path("/runtime"), output)[-1], "--retry-cutover")
        self.assertNotIn(secret, "".join(path.read_text() for path in evidence.iterdir()))


if __name__ == "__main__":
    unittest.main(verbosity=2)
