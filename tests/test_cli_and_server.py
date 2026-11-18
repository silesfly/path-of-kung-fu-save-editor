import hashlib
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "pokf_editor.py"
BUILD = ROOT / "build.py"


def _load(name, rel):
    path = (ROOT / rel).resolve()
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {name} from {path}")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


def _write_uleb128(value):
    out = bytearray()
    while True:
        b = value & 0x7F
        value >>= 7
        if value:
            out.append(b | 0x80)
        else:
            out.append(b)
            break
    return bytes(out)


def seed_save(path, slot_id="1", data=None):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if data is None:
        data = {
            "firstName": "이름",
            "lastName": "무명",
            "sliver": 500,
            "gold": 100,
            "attribute": 2,
            "gameLv": 0,
            "ArrestNum": 3,
            "HP": 50,
            "baoShi": 50,
            "listMyItemData": [],
        }
    key_bytes = ("KeyPlayerDatammjh2023" + str(slot_id)).encode("utf-8")
    raw = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    comp = zlib.compressobj(level=6, wbits=-15)
    compressed = comp.compress(raw) + comp.flush()
    blob = _write_uleb128(len(key_bytes)) + key_bytes + _write_uleb128(len(compressed)) + compressed
    path.write_bytes(blob)
    return path


def _sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _run_cli(args, cwd=None, env=None):
    e = os.environ.copy()
    e["PYTHONPATH"] = str(ROOT) + os.pathsep + e.get("PYTHONPATH", "")
    if env:
        e.update(env)
    return subprocess.run(
        [sys.executable, "-B", str(CLI), *map(str, args)],
        cwd=str(cwd or ROOT),
        env=e,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )


def _request_json(url, method="GET", data=None, headers=None, timeout=5):
    body = None
    if data is not None:
        body = json.dumps(data).encode("utf-8")
        headers = dict(headers or {})
        headers.setdefault("Content-Type", "application/json")
    req = urllib.request.Request(url, data=body, headers=headers or {}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, dict(resp.headers), resp.read()
    except urllib.error.HTTPError as exc:
        try:
            return exc.code, dict(exc.headers or {}), exc.read()
        finally:
            exc.close()


class TestCLI(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_presets(self):
        r = _run_cli(["presets"])
        self.assertEqual(r.returncode, 0, r.stderr)
        out = (r.stdout or "") + (r.stderr or "")
        for pid in ("wealth", "cultivation", "meridians", "recovery", "clean_record", "starter_supply"):
            self.assertIn(pid, out)

    def test_demo_json(self):
        r = _run_cli(["demo", "--root", str(self.dir), "--json"])
        self.assertEqual(r.returncode, 0, r.stderr)
        obj = json.loads(r.stdout)
        self.assertIsInstance(obj, dict)

    def test_demo_then_discover(self):
        r1 = _run_cli(["demo", "--root", str(self.dir)])
        self.assertEqual(r1.returncode, 0, r1.stderr)
        save = self.dir / "PlayerData_demo.save"
        self.assertTrue(save.exists(), list(self.dir.iterdir()))
        r2 = _run_cli(["discover", "--root", str(self.dir)])
        self.assertEqual(r2.returncode, 0, r2.stderr)
        out = (r2.stdout or "") + (r2.stderr or "")
        self.assertIn("PlayerData_demo.save", out)

    def test_inspect_validate_valid_and_invalid(self):
        good = self.dir / "PlayerData_1.save"
        seed_save(good, "1")
        r = _run_cli(["inspect", str(good)])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("sliver", r.stdout)
        r = _run_cli(["validate", str(good)])
        self.assertEqual(r.returncode, 0, r.stderr)

        bad1 = self.dir / "PlayerData_bad1.save"
        d = {
            "firstName": "이름",
            "lastName": "무명",
            "sliver": -1,
            "gold": 100,
            "attribute": 2,
            "gameLv": 0,
            "ArrestNum": 3,
            "HP": 50,
            "baoShi": 50,
            "listMyItemData": [],
        }
        seed_save(bad1, "bad1", d)
        r = _run_cli(["validate", str(bad1)])
        self.assertNotEqual(r.returncode, 0, r.stdout + r.stderr)

        bad2 = self.dir / "PlayerData_bad2.save"
        d = dict(d, sliver=500, attribute=99)
        seed_save(bad2, "bad2", d)
        r = _run_cli(["validate", str(bad2)])
        self.assertNotEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_apply_preset_backup_and_no_tmp(self):
        f = self.dir / "PlayerData_1.save"
        seed_save(f, "1")
        before = f.read_bytes()
        r = _run_cli(["apply", str(f), "--preset", "wealth"])
        self.assertEqual(r.returncode, 0, r.stderr)
        r = _run_cli(["inspect", str(f)])
        self.assertEqual(r.returncode, 0, r.stderr)
        payload = json.loads(r.stdout[r.stdout.index("{"):])
        self.assertGreaterEqual(int(payload.get("sliver", 0)), 500000)
        self.assertTrue((self.dir / "backups").exists())
        self.assertTrue(list((self.dir / "backups").glob("*.bak")))
        self.assertEqual(list(self.dir.glob("*.tmp")), [])
        self.assertNotEqual(f.read_bytes(), before)

    def test_restore_and_safety_backup(self):
        f = self.dir / "PlayerData_1.save"
        seed_save(f, "1")
        original_hash = _sha256(f)
        r = _run_cli(["apply", str(f), "--preset", "wealth"])
        self.assertEqual(r.returncode, 0, r.stderr)
        backups = sorted((self.dir / "backups").glob("*.bak"))
        self.assertTrue(backups)
        r = _run_cli(["restore", str(backups[0]), str(f)])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(_sha256(f), original_hash)
        self.assertGreaterEqual(len(list((self.dir / "backups").glob("*.bak"))), 2)
        self.assertEqual(list(self.dir.glob("*.tmp")), [])

    def test_game_running_lock_refuses_apply(self):
        f = self.dir / "PlayerData_1.save"
        seed_save(f, "1")
        before = _sha256(f)
        r = _run_cli(["apply", str(f), "--preset", "wealth"], env={"POKF_SIMULATE_GAME_RUNNING": "1"})
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(_sha256(f), before)

    def test_security_path_rejections(self):
        real_dir = self.dir / "real"
        real_dir.mkdir()
        real = real_dir / "PlayerData_1.save"
        seed_save(real, "1")

        symlink_target = self.dir / "link.save"
        try:
            os.symlink(real, symlink_target)
            r = _run_cli(["inspect", str(symlink_target)])
            self.assertNotEqual(r.returncode, 0, r.stdout + r.stderr)
        except (OSError, NotImplementedError):
            pass

        anc_dir = self.dir / "anc"
        anc_dir.mkdir()
        inner = anc_dir / "PlayerData_2.save"
        seed_save(inner, "2")
        ancestor_link = self.dir / "anc_link"
        try:
            os.symlink(anc_dir, ancestor_link)
            r = _run_cli(["inspect", str(ancestor_link / "PlayerData_2.save")])
            self.assertNotEqual(r.returncode, 0, r.stdout + r.stderr)
        except (OSError, NotImplementedError):
            pass

        for bad in (str(self.dir / "foo.save:bar"), str(self.dir / "CON.save"), r"\\server\share\x.save"):
            r = _run_cli(["inspect", bad])
            self.assertNotEqual(r.returncode, 0, bad)


class TestServer(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mod = _load("pokf_editor", "pokf_editor.py")

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.save = self.dir / "PlayerData_1.save"
        seed_save(self.save, "1")
        self.server = self.mod.make_server("127.0.0.1", 0, str(self.dir))
        self.host, self.port = self.server.server_address[:2]
        self.base = f"http://{self.host}:{self.port}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.token = None

    def tearDown(self):
        try:
            self.server.shutdown()
        finally:
            self.server.server_close()
        self.thread.join(timeout=5)
        self.tmp.cleanup()

    def _url(self, path):
        return self.base + path

    def _headers(self, token=None, origin=None, host=None):
        return {
            "X-Pokf-Token": token if token is not None else (self.token or ""),
            "Origin": origin or self.base,
            "Host": host or f"{self.host}:{self.port}",
        }

    def _get_session(self):
        status, _, raw = _request_json(self._url("/api/session"), headers={"Host": f"{self.host}:{self.port}"})
        self.assertEqual(status, 200)
        obj = json.loads(raw.decode("utf-8"))
        self.assertTrue(obj.get("ok"))
        self.token = obj.get("token")
        return obj

    def test_root_security_headers(self):
        self._get_session()
        status, hdrs, raw = _request_json(self._url("/"), headers={"Host": f"{self.host}:{self.port}"})
        self.assertEqual(status, 200)
        lower = {k.lower(): v for k, v in hdrs.items()}
        self.assertEqual(lower.get("cross-origin-resource-policy"), "same-origin")
        csp = lower.get("content-security-policy", "")
        self.assertIn("default-src 'none'", csp)
        self.assertIn("connect-src 'self'", csp)
        self.assertNotIn("connect-src 'none'", raw.decode("utf-8", "replace"))

    def test_session_slots(self):
        obj = self._get_session()
        self.assertTrue(obj.get("token"))
        self.assertEqual(Path(obj["root"]).resolve(), self.dir.resolve())
        status, _, raw = _request_json(self._url("/api/slots"), headers={"Host": f"{self.host}:{self.port}"})
        self.assertEqual(status, 200)
        self.assertIn("PlayerData_1.save", raw.decode("utf-8"))

    def test_api_security_rejections(self):
        self._get_session()
        for hdrs in (
            {"Host": f"{self.host}:{self.port}", "Origin": self.base},
            {"X-Pokf-Token": "wrong", "Host": f"{self.host}:{self.port}", "Origin": self.base},
            {"X-Pokf-Token": self.token, "Host": "evil.example", "Origin": self.base},
            {"X-Pokf-Token": self.token, "Host": f"{self.host}:{self.port}", "Origin": "http://evil.example"},
        ):
            status, _, _ = _request_json(self._url("/api/save"), method="POST", data={"slot": 1, "data": {}}, headers=hdrs)
            self.assertEqual(status, 403)

    def test_roundtrip(self):
        self._get_session()
        headers = self._headers()
        status, _, raw = _request_json(self._url("/api/load"), method="POST", data={"name": "PlayerData_1.save"}, headers=headers)
        self.assertEqual(status, 200)
        loaded = json.loads(raw.decode("utf-8"))
        self.assertTrue(loaded.get("ok"))
        data = loaded["data"]
        original_sliver = data["sliver"]
        self.assertEqual(original_sliver, 500)
        data["sliver"] = 123456
        status, _, raw = _request_json(self._url("/api/save"), method="POST", data={"slot": 1, "data": data}, headers=headers)
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(raw.decode("utf-8")).get("ok"))
        self.assertTrue(list((self.dir / "backups").glob("*.bak")))

        status, _, raw = _request_json(self._url("/api/backups"), headers={"Host": f"{self.host}:{self.port}"})
        self.assertEqual(status, 200)
        backups = json.loads(raw.decode("utf-8")).get("backups", [])
        self.assertGreaterEqual(len(backups), 1)

        status, _, raw = _request_json(self._url("/api/backups"), method="POST", data={}, headers=headers)
        self.assertEqual(status, 200)
        backups2 = json.loads(raw.decode("utf-8")).get("backups", [])
        self.assertGreaterEqual(len(backups2), 1)
        backup_name = backups2[0]["name"]

        status, _, raw = _request_json(self._url("/api/restore"), method="POST", data={"slot": 1, "backup": backup_name}, headers=headers)
        self.assertEqual(status, 200)
        status, _, raw = _request_json(self._url("/api/load"), method="POST", data={"name": "PlayerData_1.save"}, headers=headers)
        self.assertEqual(status, 200)
        restored = json.loads(raw.decode("utf-8"))["data"]
        self.assertEqual(restored["sliver"], original_sliver)


class TestBuild(unittest.TestCase):
    def test_build_check(self):
        r = subprocess.run(
            [sys.executable, "-B", str(BUILD), "--check"],
            cwd=str(ROOT),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)


if __name__ == "__main__":
    unittest.main()
