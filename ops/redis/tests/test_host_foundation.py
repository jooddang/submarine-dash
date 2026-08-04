from __future__ import annotations

import hashlib
import importlib.util
import importlib.machinery
import json
import os
import plistlib
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock

OPS = Path(__file__).resolve().parents[1]
REPO = OPS.parents[1]
TORRENCE_REGISTRY = Path("/Users/jooddang/dev/torrence/ops/redis/route_registry.py")
spec = importlib.util.spec_from_file_location("submarine_redis_host", OPS / "submarine_redis_host.py")
host = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(host)


class HostFoundationTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        helper = self.root / "usr/local/libexec/torrence-route-registry"
        helper.parent.mkdir(parents=True)
        shutil.copyfile(TORRENCE_REGISTRY, helper)
        helper.chmod(0o755)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def install(self, fail_at: str | None = None) -> None:
        host.install_test(self.root, fail_at)

    def test_static_config_is_loopback_persistent_and_noeviction(self) -> None:
        config = (OPS / "redis-submarine.conf").read_text()
        self.assertIn("bind 127.0.0.1", config)
        self.assertIn("port 6691", config)
        self.assertIn("appendonly yes", config)
        self.assertIn("appendfsync always", config)
        self.assertIn("save 3600 1", config)
        self.assertIn("maxmemory-policy noeviction", config)

    def test_install_creates_isolated_identity_paths_and_least_privilege_acl(self) -> None:
        self.install()
        redis_root = self.root / "Library/Application Support/SubmarineDashRedis"
        app_root = self.root / "Library/Application Support/SubmarineDash"
        self.assertEqual((redis_root / "data").stat().st_mode & 0o777, 0o750)
        self.assertEqual((app_root / "credentials.env").stat().st_mode & 0o777, 0o600)
        acl = (redis_root / "users.acl").read_text()
        self.assertIn("user default off", acl)
        self.assertIn("user submarine_srh on #", acl)
        self.assertIn("+eval +time", acl)
        self.assertNotIn("+@scripting", acl)
        self.assertNotIn("+@fast", acl)
        self.assertIn("-flushall -flushdb -config -acl -shutdown", acl)
        self.assertNotIn("~*", acl)
        self.assertNotIn("nopass", acl)
        self.assertNotIn("127.0.0.1:6379", (redis_root / "redis.conf").read_text())

    def test_srh_acl_runs_phase0_lua_but_rejects_other_keys_and_flush(self) -> None:
        passwords = {"APP": "a" * 64, "BACKUP": "b" * 64, "SRH": "c" * 64}
        acl, _ = host.create_acl(passwords)
        acl_path = self.root / "users.acl"
        acl_path.write_bytes(acl)
        acl_path.chmod(0o600)
        data = self.root / "acl-data"
        data.mkdir()
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        config = self.root / "acl-test.conf"
        config.write_text(
            f'bind 127.0.0.1\nport {port}\ndir "{data}"\naclfile "{acl_path}"\n'
            "appendonly no\nsave \"\"\ndaemonize no\n"
        )
        process = subprocess.Popen(
            ["/opt/homebrew/bin/redis-server", str(config)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        command = [
            "/opt/homebrew/bin/redis-cli", "--no-auth-warning", "-p", str(port),
            "--user", "submarine_srh",
        ]
        environment = {**os.environ, "REDISCLI_AUTH": passwords["SRH"]}
        try:
            host.wait_for_port(port)
            script = "local t=redis.call('TIME'); redis.call('SET',KEYS[1],t[1]); return t[1]"
            allowed = subprocess.run(
                command + ["EVAL", script, "1", "sd:migration:phase0"],
                env=environment, text=True, capture_output=True,
            )
            self.assertEqual(allowed.returncode, 0, allowed.stderr)
            self.assertRegex(allowed.stdout.strip(), r"^\d+$")
            forbidden_key = subprocess.run(
                command + ["SET", "roadcrosser:outside", "no"],
                env=environment, text=True, capture_output=True,
            )
            self.assertIn("NOPERM", forbidden_key.stdout + forbidden_key.stderr)
            forbidden_flush = subprocess.run(
                command + ["FLUSHALL"], env=environment, text=True, capture_output=True,
            )
            self.assertIn("NOPERM", forbidden_flush.stdout + forbidden_flush.stderr)
        finally:
            process.terminate()
            process.wait(timeout=5)

    def test_reinstall_preserves_credentials_instead_of_rotating(self) -> None:
        self.install()
        credentials = self.root / "Library/Application Support/SubmarineDash/credentials.env"
        before = credentials.read_bytes()
        self.install()
        self.assertEqual(credentials.read_bytes(), before)

    def test_host_lock_rejects_existing_insecure_metadata(self) -> None:
        lock = self.root / "host-mutation.lock"
        lock.write_bytes(b"")
        lock.chmod(0o644)
        with self.assertRaises(host.HostError):
            with host.host_lock(lock):
                pass

    def test_atomic_writes_survive_short_os_writes_in_worker_and_bootstrap(self) -> None:
        target = self.root / "short-write"
        payload = b"durable-payload-" * 8192
        real_write = os.write
        def short_write(descriptor, remaining):
            return real_write(descriptor, remaining[:max(1, min(31, len(remaining)))])
        with mock.patch.object(host.os, "write", side_effect=short_write):
            host.atomic_write(target, payload, 0o600)
        self.assertEqual(target.read_bytes(), payload)
        namespace = {}
        bootstrap = (OPS / "secure-install-bootstrap.py").read_text()
        exec(compile(bootstrap.split('if __name__ == "__main__":')[0], "bootstrap", "exec"), namespace)
        descriptor = os.open(self.root / "bootstrap-short-write", os.O_WRONLY | os.O_CREAT, 0o600)
        try:
            with mock.patch.object(namespace["os"], "write", side_effect=short_write):
                namespace["write_all"](descriptor, payload)
        finally:
            os.close(descriptor)
        self.assertEqual((self.root / "bootstrap-short-write").read_bytes(), payload)

    def test_launchdaemons_only_target_submarine_services(self) -> None:
        for plist_path in OPS.glob("com.roadcrosser.*.plist"):
            payload = plistlib.loads(plist_path.read_bytes())
            self.assertTrue(payload["Label"].startswith("com.roadcrosser.submarine-redis"))
            arguments = " ".join(payload["ProgramArguments"])
            self.assertIn("submarine", arguments)
            self.assertNotIn("torrence", arguments)
            self.assertNotIn("x-to-notion", arguments)
        worker = (OPS / "submarine_redis_host.py").read_text()
        self.assertEqual(host.PRESERVED_PORTS, (6379, 6688, 6690, 8079))
        self.assertNotIn("kickstart", worker)
        self.assertNotIn("com.torrence", worker)
        self.assertNotIn("com.x-to-notion", worker)

    def test_registry_compatibility_extends_reviewed_helper_without_editing_base(self) -> None:
        original = (self.root / "usr/local/libexec/torrence-route-registry").read_bytes()
        self.install()
        base = self.root / "usr/local/libexec/torrence-route-registry.pre-submarine"
        self.assertEqual(base.read_bytes(), original)
        installed = self.root / "usr/local/libexec/torrence-route-registry"
        loader = importlib.machinery.SourceFileLoader("installed_registry", str(installed))
        module_spec = importlib.util.spec_from_loader(loader.name, loader)
        module = importlib.util.module_from_spec(module_spec)
        sys.modules[loader.name] = module
        loader.exec_module(module)
        self.assertEqual(module.DEFAULT_ALLOWED_PORTS, frozenset({6688, 6690, 6691}))
        fragment = {"token": "a" * 64, "srh_id": "submarine-dash", "connection_string": "redis://submarine_srh:secret@127.0.0.1:6691/0", "max_connections": 10}
        self.assertEqual(module.validate_fragment(fragment, allowed_ports=module.DEFAULT_ALLOWED_PORTS), fragment)

    def test_three_route_concurrent_publication_and_regeneration_preserves_all_routes(self) -> None:
        self.install()
        helper = self.root / "usr/local/libexec/torrence-route-registry"
        registry = self.root / "registry"
        common = [str(helper), "--registry-root", str(registry), "--owner-uid", str(os.getuid()), "--owner-gid", str(os.getgid()), "--active-gid", str(os.getgid())]
        subprocess.run(common + ["prepare"], check=True, capture_output=True)
        fragments = (
            ("torrence", 6688, "torrence"),
            ("x-to-notion", 6690, "x_to_notion_srh"),
            ("submarine-dash", 6691, "submarine_srh"),
        )
        def publish(item):
            name, port, user = item
            fragment = json.dumps({"token": hashlib.sha256(name.encode()).hexdigest(), "srh_id": name, "connection_string": f"redis://{user}:secret@127.0.0.1:{port}/0", "max_connections": 10})
            return subprocess.run(common + ["publish", "--fragment-name", name + ".json"], input=fragment, text=True, capture_output=True)
        with ThreadPoolExecutor(max_workers=3) as executor:
            results = list(executor.map(publish, fragments))
        self.assertTrue(all(result.returncode == 0 for result in results), [result.stderr for result in results])
        # This is the exact surface imported by future X and Torrence regeneration.
        subprocess.run(common + ["generate"], check=True, capture_output=True)
        candidate = json.loads((registry / "tokens.candidate.json").read_text())
        routes = candidate.values() if isinstance(candidate, dict) else candidate
        self.assertEqual({route["srh_id"] for route in routes}, {item[0] for item in fragments})

        # A future install may refresh the canonical helper with the reviewed
        # upstream bytes. Reinstalling the shim must restore three-route behavior.
        shutil.copyfile(TORRENCE_REGISTRY, helper)
        helper.chmod(0o755)
        self.install()
        subprocess.run(common + ["generate"], check=True, capture_output=True)
        candidate = json.loads((registry / "tokens.candidate.json").read_text())
        self.assertEqual({route["srh_id"] for route in candidate.values()}, {item[0] for item in fragments})

    def test_authenticated_route_health_requires_exact_set_and_every_ping(self) -> None:
        active = self.root / "tokens.active.json"
        routes = {
            hashlib.sha256(name.encode()).hexdigest(): {
                "srh_id": name, "connection_string": f"redis://user:secret@127.0.0.1:{port}/0"
            }
            for name, port in (("torrence", 6688), ("x-to-notion", 6690), ("submarine-dash", 6691))
        }
        active.write_text(json.dumps(routes))
        active.chmod(0o640)
        backend_seen = []
        token_seen = []
        host.verify_active_routes(
            host.EXPECTED_ROUTES, active, backend_seen.append, token_seen.append,
        )
        self.assertEqual(len(backend_seen), 3)
        self.assertEqual(set(token_seen), set(routes))
        routes.pop(next(iter(routes)))
        active.write_text(json.dumps(routes))
        with self.assertRaises(host.HostError):
            host.verify_active_routes(
                host.EXPECTED_ROUTES, active, backend_seen.append, token_seen.append,
            )

    def test_registry_recovery_cas_refuses_later_publisher_state(self) -> None:
        shared = self.root / "tokens.active.json"
        shared.write_text("before")
        before = hashlib.sha256(shared.read_bytes()).hexdigest()
        transaction = {"registryAllowedDigests": {str(shared): [before]}}
        shared.write_text("legitimate later publication")
        with mock.patch.object(host, "REGISTRY_MANAGED_FILES", (shared,)):
            with self.assertRaises(host.HostError):
                host.verify_registry_recovery_cas(transaction)

    def test_registry_write_ahead_authorizes_each_installer_after_image(self) -> None:
        paths = tuple(self.root / name for name in ("helper", "fragment", "candidate", "active"))
        transaction = {"registryAllowedDigests": {str(path): [None] for path in paths}}
        with mock.patch.object(host, "REGISTRY_MANAGED_FILES", paths):
            for index, path in enumerate(paths):
                payload = f"installer-after-image-{index}".encode()
                host.authorize_registry_payload(transaction, path, payload)
                path.write_bytes(payload)
                host.verify_registry_recovery_cas(transaction)
            allowed_before = json.loads(json.dumps(transaction["registryAllowedDigests"]))
            paths[0].write_text("unexpected helper after-image")
            with self.assertRaises(host.HostError):
                host.verify_registry_recovery_cas(transaction)
            self.assertEqual(transaction["registryAllowedDigests"], allowed_before)

    def test_managed_directory_metadata_restores_and_symlinks_are_rejected(self) -> None:
        managed = self.root / "managed"
        managed.mkdir(mode=0o711)
        snapshot = host.directory_snapshot(managed)
        managed.chmod(0o700)
        host.restore_directory(managed, snapshot)
        self.assertEqual(managed.stat().st_mode & 0o777, 0o711)
        target = self.root / "target"
        target.mkdir()
        symlink = self.root / "managed-link"
        symlink.symlink_to(target, target_is_directory=True)
        with self.assertRaises(host.HostError):
            host.ensure_directory(symlink, 0o700)

    def test_existing_service_identity_requires_exact_unique_attributes(self) -> None:
        user = {
            "dsAttrTypeStandard:RecordName": ["_submarine"],
            "dsAttrTypeStandard:UniqueID": ["491"],
            "dsAttrTypeStandard:PrimaryGroupID": ["491"],
            "dsAttrTypeStandard:UserShell": ["/usr/bin/false"],
            "dsAttrTypeStandard:NFSHomeDirectory": ["/var/empty"],
        }
        group = {
            "dsAttrTypeStandard:RecordName": ["_submarine"],
            "dsAttrTypeStandard:PrimaryGroupID": ["491"],
        }
        host.validate_identity_records(user, group, "_submarine 491\n", "_submarine 491\n")
        user["dsAttrTypeStandard:UserShell"] = ["/bin/zsh"]
        with self.assertRaises(host.HostError):
            host.validate_identity_records(user, group, "_submarine 491\n", "_submarine 491\n")

    def test_maintenance_preflight_waits_for_idle_and_capture_rejects_race(self) -> None:
        busy = {"loaded": True, "running": True}
        idle = {"loaded": True, "running": False}
        with mock.patch.object(host, "launchd_state", side_effect=[busy, idle, idle, idle]), \
                mock.patch.object(host.time, "sleep"):
            host.wait_for_maintenance_idle(attempts=2)
        with mock.patch.object(host, "launchd_state", return_value=busy):
            with self.assertRaises(host.HostError):
                host.capture_install_transaction()

    def test_failed_bootout_and_lingering_listener_fail_closed(self) -> None:
        failed = subprocess.CompletedProcess([], 1)
        with mock.patch.object(host.subprocess, "run", return_value=failed), \
                mock.patch.object(host, "launchd_state", return_value={"loaded": True, "running": True}):
            with self.assertRaises(host.HostError):
                host.quiesce_submarine_services()
        with mock.patch.object(host, "listener_identity", return_value="p123"), \
                mock.patch.object(host.time, "sleep"):
            with self.assertRaises(host.HostError):
                host.wait_for_port_closed(host.PORT, attempts=2)

    def test_recovery_retains_transaction_until_quiesce_and_port_close_succeed(self) -> None:
        transaction_path = self.root / "transaction.json"
        payload = {"schemaVersion": 3, "files": {}, "directories": {},
                   "runtimeEntries": [], "runtimeTarget": None,
                   "registryAllowedDigests": {},
                   "identity": {"user": None, "group": None},
                   "launchd": {label: {"loaded": False, "running": False} for label in host.SERVICE_LABELS}}
        transaction_path.write_text(json.dumps(payload))
        transaction_path.chmod(0o600)
        with mock.patch.object(host, "INSTALL_TRANSACTION", transaction_path), \
                mock.patch.object(host, "PRODUCTION_MANAGED_FILES", ()), \
                mock.patch.object(host, "PRODUCTION_MANAGED_DIRECTORIES", ()), \
                mock.patch.object(host, "REGISTRY_MANAGED_FILES", ()), \
                mock.patch.object(host, "quiesce_submarine_services", side_effect=host.HostError("bootout failed")):
            with self.assertRaises(host.HostError):
                host.recover_install_transaction()
        self.assertTrue(transaction_path.exists())

    def test_disposable_termination_escalates_to_kill(self) -> None:
        process = mock.Mock()
        process.poll.return_value = None
        process.wait.side_effect = [subprocess.TimeoutExpired("redis", 5), 0]
        host.terminate_process(process)
        process.terminate.assert_called_once()
        process.kill.assert_called_once()
        replaced = self.root / "redis.sock"
        replaced.write_text("attacker replacement")
        running = mock.Mock()
        running.poll.return_value = None
        with self.assertRaises(host.HostError):
            host.wait_for_unix_socket(replaced, running, attempts=1)

    def test_identity_snapshots_preserve_separate_user_and_group_attributes(self) -> None:
        user = {"dsAttrTypeStandard:UniqueID": ["491"], "dsAttrTypeStandard:RealName": ["Existing User"]}
        group = {"dsAttrTypeStandard:PrimaryGroupID": ["492"], "dsAttrTypeStandard:RealName": ["Existing Group"]}
        results = [
            subprocess.CompletedProcess([], 0, stdout=plistlib.dumps(user)),
            subprocess.CompletedProcess([], 0, stdout=plistlib.dumps(group)),
        ]
        with mock.patch.object(host.subprocess, "run", side_effect=results):
            self.assertEqual(host.capture_dscl_record("/Users/_submarine"), user)
            self.assertEqual(host.capture_dscl_record("/Groups/_submarine"), group)

    def test_install_failure_restores_registry_and_removes_secret_files(self) -> None:
        helper = self.root / "usr/local/libexec/torrence-route-registry"
        before = helper.read_bytes()
        with self.assertRaises(host.HostError):
            self.install("after-layout")
        self.assertEqual(helper.read_bytes(), before)
        self.assertFalse((self.root / "usr/local/libexec/torrence-route-registry.pre-submarine").exists())
        self.assertFalse((self.root / "Library/Application Support/SubmarineDash/credentials.env").exists())
        self.assertFalse((self.root / "var/run/submarine-install-transaction").exists())

    def _create_rdb(self, data: Path) -> None:
        data.mkdir(exist_ok=True)
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        with tempfile.NamedTemporaryFile("w", delete=False) as config:
            config.write(f'bind 127.0.0.1\nport {port}\ndir "{data}"\ndbfilename dump.rdb\nappendonly no\ndaemonize no\n')
            config_path = config.name
        process = subprocess.Popen(["/opt/homebrew/bin/redis-server", config_path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            host.wait_for_port(port)
            subprocess.run(["/opt/homebrew/bin/redis-cli", "-p", str(port), "SET", "protected:jooddang", "preserved"], check=True, capture_output=True)
            subprocess.run(["/opt/homebrew/bin/redis-cli", "-p", str(port), "SAVE"], check=True, capture_output=True)
        finally:
            process.terminate()
            process.wait(timeout=5)
            Path(config_path).unlink()

    def test_backup_interruption_is_uncommitted_and_disposable_restore_is_real_redis(self) -> None:
        self.install()
        data = self.root / "Library/Application Support/SubmarineDashRedis/data"
        self._create_rdb(data)
        with self.assertRaises(host.HostError):
            host.backup(self.root, fail_before_commit=True)
        interrupted = next((self.root / "Library/Application Support/SubmarineDash/backups/generations").iterdir())
        with self.assertRaises((host.HostError, FileNotFoundError)):
            host.verify_generation(interrupted)
        committed = host.backup(self.root)
        manifest = host.verify_generation(committed)
        destination = self.root / "disposable-restore"
        host.restore_disposable(committed, destination)
        self.assertEqual((destination / "VERIFIED").read_text().strip(), manifest["sha256"])
        with mock.patch.object(host, "IMMUTABLE_REDIS_SERVER", self.root / "missing-immutable"), \
                mock.patch.object(host, "HOMEBREW_REDIS_SERVER", self.root / "missing-homebrew"), \
                mock.patch.object(host, "REDIS_CLI", self.root / "missing-cli"):
            with self.assertRaises(host.HostError):
                host.restore_disposable(committed, self.root / "missing-runtime-restore")

    def test_public_endpoint_must_be_json_auth_error_not_ngrok_page(self) -> None:
        host.validate_public_auth_response(401, "application/json", b'{"error":"unauthorized"}')
        with self.assertRaises(host.HostError):
            host.validate_public_auth_response(200, "text/html", b"<html>ngrok</html>")
        with self.assertRaises(host.HostError):
            host.validate_public_auth_response(401, "application/json", b"not-json")
        ingress = self.root / "public-ingress.json"
        ingress.write_text(json.dumps({"origin": "http://127.0.0.1:9123", "path": "/srh"}))
        ingress.chmod(0o600)
        self.assertEqual(host.configured_public_url(ingress, allow_local=True), "http://127.0.0.1:9123/srh")
        with self.assertRaises(host.HostError):
            host.verify_public_auth("http://127.0.0.1:9123/srh?escape=1", allow_local=True, config_path=ingress)
        response = mock.Mock(status=401, headers={"Content-Type": "application/json"})
        response.geturl.return_value = "http://attacker.invalid/srh"
        opener = mock.Mock()
        opener.open.return_value = response
        with mock.patch.object(host.urllib.request, "build_opener", return_value=opener):
            with self.assertRaises(host.HostError):
                host.verify_public_auth("http://127.0.0.1:9123/srh", allow_local=True, config_path=ingress)

    def test_secure_bootstrap_fails_closed_on_stale_or_placeholder_hashes(self) -> None:
        bootstrap = (OPS / "secure-install-bootstrap.py").read_text()
        self.assertNotIn('"HASHES_PENDING"', bootstrap)
        namespace = {}
        exec(compile(bootstrap.split('if __name__ == "__main__":')[0], "bootstrap", "exec"), namespace)
        hashes = namespace["TOOL_HASHES"]
        sources = namespace["TOOL_SOURCES"]
        self.assertGreater(len(hashes), 5)
        for name, expected in hashes.items():
            source = sources.get(name, OPS / name)
            self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(), expected, name)
        self.assertIn("stale bootstrap digest", bootstrap)

    def test_secret_umask_does_not_leak_into_runtime_tree(self) -> None:
        worker = (OPS / "submarine_redis_host.py").read_text()
        guard = (OPS / "start-redis-guarded.sh").read_text()
        self.assertNotIn("umask(0o077)", worker)
        self.assertIn("umask 0027", guard)
        self.assertIn("0o750", worker)
        runtime = (OPS / "prepare-pinned-runtime.py").read_text()
        base = Path("/Users/jooddang/dev/x-to-notion-mobile/ops/redis/prepare-pinned-redis-runtime.py").read_text()
        self.assertIn('/usr/local/lib/submarine-redis', runtime)
        self.assertIn('"@loader_path/../lib/libssl.3.dylib"', base)
        self.assertIn("os.chmod(directory, 0o555)", base)


if __name__ == "__main__":
    unittest.main()
