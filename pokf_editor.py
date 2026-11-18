#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""도검강호로 저장 편집기 - 의존성 없는 표준 라이브러리 CLI 및 루프백 HTTP 서버."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
import zlib
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlparse

SAVE_KEY_RE = re.compile(r"^KeyPlayerDatammjh2023(\d+)$")
MAX_COMPRESSED = 64 * 1024 * 1024
MAX_DECOMPRESSED = 64 * 1024 * 1024
PRESET_DIR_NAME = "presets"
BACKUP_DIR_NAME = "backups"
BACKUP_KEEP = 20
RESERVED_STEMS = {"CON", "PRN", "AUX", "NUL", *[f"COM{i}" for i in range(1, 10)], *[f"LPT{i}" for i in range(1, 10)]}

# ---------------------------------------------------------------------------
# 메시지 (순수 한국어)
# ---------------------------------------------------------------------------
MSG = {
    "no_root": "저장 폴더를 찾을 수 없습니다.",
    "root_ok": "저장 폴더: {root}",
    "no_files": "저장 파일이 없습니다.",
    "found": "발견: {name}",
    "inspect_ok": "{path} 을(를) 읽었습니다. 키: {key}",
    "inspect_fail": "{path} 읽기 실패: {err}",
    "validate_ok": "스키마 검증 통과.",
    "validate_fail": "스키마 검증 실패: {err}",
    "game_running": "게임이 실행 중입니다. 먼저 종료하십시오.",
    "path_unsafe": "안전하지 않은 경로입니다: {reason}",
    "backup_done": "백업 완료: {path}",
    "backup_fail": "백업 실패: {err}",
    "write_ok": "저장 완료: {path}",
    "write_fail": "저장 실패: {err}",
    "restore_ok": "복원 완료: {path}",
    "preset_ok": "프리셋 적용 완료: {path}",
    "preset_unknown": "알 수 없는 프리셋: {id}",
    "presets_list": "프리셋: {ids}",
    "not_found": "파일을 찾을 수 없습니다: {path}",
    "demo_ok": "예제 생성 완료: {path}",
    "serve_start": "서버 시작: http://{host}:{port}/",
    "server_err": "서버 오류: {err}",
    "invalid": "잘못된 입력입니다.",
    "forbidden": "접근이 거부되었습니다.",
}

def K(msg_key: str, /, **kw: Any) -> str:
    return MSG[msg_key].format(**kw)

# ---------------------------------------------------------------------------
# 경로 확인
# ---------------------------------------------------------------------------
def default_roots() -> list[Path]:
    out: list[Path] = []
    env = os.environ.get("POKF_SAVE_ROOT")
    if env:
        out.append(Path(env))
    home = Path.home()
    out.append(home / "AppData" / "LocalLow" / "HuaLongZ" / "saves")
    out.append(home / "AppData" / "LocalLow" / "HuaLongZ" / "daojianjianghulu")
    return out

def discover_root(explicit: Optional[str] = None) -> Optional[Path]:
    if explicit:
        p = Path(explicit)
        return p if p.is_dir() else None
    for p in default_roots():
        try:
            if p.is_dir():
                return p
        except OSError:
            continue
    return None

_DRIVE_RE = re.compile(r"^[A-Za-z]:")

def validate_safe_save_path(path: Path, allow_new: bool = False) -> None:
    s = str(path)
    if not s:
        raise ValueError(K("path_unsafe", reason="빈 경로"))
    if s.startswith("\\\\") or s.startswith("//") or "\\\\" in s:
        raise ValueError(K("path_unsafe", reason="UNC 경로"))
    # NTFS ADS 검사: 첫 번째 콜론만 허용 (드라이브 문자)
    without_drive = _DRIVE_RE.sub("", s, count=1) if _DRIVE_RE.match(s) else s
    if ":" in without_drive:
        raise ValueError(K("path_unsafe", reason="콜론 포함"))
    for part in path.parts:
        stem = part.split(".", 1)[0].upper()
        if stem in RESERVED_STEMS:
            raise ValueError(K("path_unsafe", reason="예약된 장치 이름"))

    abs_str = os.path.abspath(s)
    abs_p = Path(abs_str)
    cur = Path(abs_p.anchor) if abs_p.anchor else Path(".")
    parts = abs_p.parts[1:] if abs_p.anchor else abs_p.parts
    reparse_attr = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    is_junc = getattr(os.path, "isjunction", lambda _p: False)

    for i, part in enumerate(parts):
        cur = cur / part
        cur_s = str(cur)
        is_leaf = (i == len(parts) - 1)
        if not os.path.lexists(cur_s):
            if is_leaf and allow_new:
                return
            raise FileNotFoundError(K("not_found", path=cur_s))
        try:
            lst = os.lstat(cur_s)
        except OSError as exc:
            raise ValueError(K("path_unsafe", reason="경로 상태 확인 실패")) from exc
        if os.path.islink(cur_s) or stat.S_ISLNK(lst.st_mode):
            raise ValueError(K("path_unsafe", reason="심볼릭 링크"))
        if is_junc(cur_s):
            raise ValueError(K("path_unsafe", reason="NTFS 정션"))
        if getattr(lst, "st_file_attributes", 0) & reparse_attr:
            raise ValueError(K("path_unsafe", reason="리파스 포인트"))
        if os.path.normcase(os.path.realpath(cur_s)) != os.path.normcase(os.path.abspath(cur_s)):
            raise ValueError(K("path_unsafe", reason="경로 리다이렉션"))
        if not is_leaf and not stat.S_ISDIR(lst.st_mode):
            raise ValueError(K("path_unsafe", reason="상위 경로가 디렉터리가 아님"))
        if is_leaf and not allow_new and not stat.S_ISREG(lst.st_mode):
            raise ValueError(K("path_unsafe", reason="일반 파일이 아님"))
        if is_leaf and stat.S_ISREG(lst.st_mode) and getattr(lst, "st_nlink", 1) > 1:
            raise ValueError(K("path_unsafe", reason="하드 링크"))

# ---------------------------------------------------------------------------
# 게임 실행 감지
# ---------------------------------------------------------------------------
def game_running() -> bool:
    if os.environ.get("POKF_SIMULATE_GAME_RUNNING") == "1":
        return True
    name = "daojianjianghulu"
    if os.name == "nt":
        try:
            out = subprocess.run(["tasklist", "/FI", f"IMAGENAME eq {name}.exe"],
                                 capture_output=True, text=True, timeout=5).stdout.lower()
            return name in out
        except (OSError, subprocess.SubprocessError):
            return False
    proc = Path("/proc")
    if proc.is_dir():
        for ent in proc.iterdir():
            if not ent.name.isdigit():
                continue
            try:
                cmd = (ent / "cmdline").read_bytes().lower()
                if name.encode() in cmd:
                    return True
            except OSError:
                continue
    return False

# ---------------------------------------------------------------------------
# LEB128
# ---------------------------------------------------------------------------
def read_leb128(buf: bytes, off: int) -> tuple[int, int]:
    shift = 0
    val = 0
    while True:
        if off >= len(buf):
            raise ValueError("길이 정보가 잘렸습니다.")
        b = buf[off]
        off += 1
        val |= (b & 0x7F) << shift
        if not (b & 0x80):
            return val, off
        shift += 7
        if shift > 35:
            raise ValueError("길이 정보가 너무 큽니다.")

def enc_leb128(n: int) -> bytes:
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)

# ---------------------------------------------------------------------------
# 코덱
# ---------------------------------------------------------------------------
@dataclass
class SaveDoc:
    key: str
    data: dict
    was_json: bool = False

def _decode_json(raw: bytes) -> dict:
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        try:
            return json.loads(raw.decode("utf-16-le"))
        except (UnicodeDecodeError, json.JSONDecodeError) as e:
            raise ValueError(f"JSON 해석 실패: {e}") from e

def read_save(path: Path) -> SaveDoc:
    validate_safe_save_path(path)
    raw = path.read_bytes()
    if path.suffix.lower() == ".json":
        return SaveDoc(key="", data=_decode_json(raw), was_json=True)
    key_len, off = read_leb128(raw, 0)
    if off + key_len > len(raw):
        raise ValueError("키 길이 초과.")
    key = raw[off:off + key_len].decode("utf-8")
    off += key_len
    if not SAVE_KEY_RE.match(key):
        raise ValueError("키 형식이 올바르지 않습니다.")
    comp_len, off = read_leb128(raw, off)
    if comp_len > MAX_COMPRESSED:
        raise ValueError("압축 크기가 너무 큽니다.")
    if off + comp_len > len(raw):
        raise ValueError("본문이 잘렸습니다.")
    payload = raw[off:off + comp_len]
    off += comp_len
    if off != len(raw):
        raise ValueError("꼬리 바이트가 남아 있습니다.")
    d = zlib.decompressobj(-15)
    try:
        data = d.decompress(payload, MAX_DECOMPRESSED)
        if d.unconsumed_tail:
            raise ValueError("압축 해제 크기가 너무 큽니다.")
        if not d.eof:
            raise ValueError("압축 스트림이 완결되지 않았습니다.")
    except zlib.error as e:
        raise ValueError(f"압축 해제 실패: {e}") from e
    return SaveDoc(key=key, data=_decode_json(data), was_json=False)

def encode_save(doc: SaveDoc) -> bytes:
    text = json.dumps(doc.data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if doc.was_json or not doc.key:
        return text
    if not SAVE_KEY_RE.match(doc.key):
        raise ValueError("키 형식 오류.")
    co = zlib.compressobj(level=6, wbits=-15)
    comp = co.compress(text) + co.flush()
    if len(comp) > MAX_COMPRESSED:
        raise ValueError("압축 크기가 너무 큽니다.")
    kb = doc.key.encode("utf-8")
    return enc_leb128(len(kb)) + kb + enc_leb128(len(comp)) + comp

# ---------------------------------------------------------------------------
# 스키마
# ---------------------------------------------------------------------------
def validate_schema(d: Any) -> None:
    if not isinstance(d, dict):
        raise ValueError("최상위가 객체가 아닙니다.")
    for k in ("firstName", "lastName"):
        if k in d and not isinstance(d[k], str):
            raise ValueError(f"{k} 항목이 문자열이 아닙니다.")
    non_negative_fields = (
        "sliver", "gold", "sectcoin", "gangCoin",
        "xiuWei", "YueLi", "JingYan", "SP",
        "HP", "baoShi", "ArrestNum", "surplusAttributeNum",
    )
    for k in non_negative_fields:
        if k in d:
            v = d[k]
            if isinstance(v, bool) or not isinstance(v, (int, float)):
                raise ValueError(f"{k} 항목이 숫자가 아닙니다.")
            if v < 0:
                raise ValueError(f"{k} 항목은 0 이상이어야 합니다.")
    if "attribute" in d:
        attr = d["attribute"]
        if isinstance(attr, bool) or not isinstance(attr, int) or not 1 <= attr <= 10:
            raise ValueError("attribute 항목이 1~10 범위가 아닙니다.")
    if "gameLv" in d:
        lv = d["gameLv"]
        if isinstance(lv, bool) or not isinstance(lv, int) or not 0 <= lv <= 2:
            raise ValueError("gameLv 항목이 0~2 범위가 아닙니다.")

# ---------------------------------------------------------------------------
# 백업
# ---------------------------------------------------------------------------
def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

def backup_file(src: Path, root: Path) -> Path:
    bdir = root / BACKUP_DIR_NAME
    bdir.mkdir(parents=True, exist_ok=True)
    ts = time.strftime("%Y%m%d-%H%M%S")
    uniq = os.urandom(3).hex()
    dst = bdir / f"{src.name}.backup-{ts}-{uniq}.bak"
    before = _sha256(src.read_bytes())
    shutil.copy2(src, dst)
    after = _sha256(dst.read_bytes())
    if before != after:
        dst.unlink(missing_ok=True)
        raise RuntimeError("백업 무결성 검증 실패.")
    prune_backups(bdir)
    return dst

def prune_backups(bdir: Path) -> None:
    items = sorted(bdir.glob("*.bak"), key=lambda p: p.stat().st_mtime, reverse=True)
    for old in items[BACKUP_KEEP:]:
        try:
            old.unlink()
        except OSError:
            pass

def atomic_write(target: Path, data: bytes) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=target.name + ".", suffix=".tmp", dir=str(target.parent))
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, target)
        tmp = ""
    finally:
        if tmp and os.path.exists(tmp):
            try:
                os.unlink(tmp)
            except OSError:
                pass

# ---------------------------------------------------------------------------
# 프리셋
# ---------------------------------------------------------------------------
def _apply_wealth(d: dict) -> None:
    d["sliver"] = max(int(d.get("sliver", 0) or 0), 500000)
    d["gold"] = max(int(d.get("gold", 0) or 0), 5000)
    d["sectcoin"] = max(int(d.get("sectcoin", 0) or 0), 50000)
    d["gangCoin"] = max(int(d.get("gangCoin", 0) or 0), 50000)

def _apply_cultivation(d: dict) -> None:
    d["xiuWei"] = max(int(d.get("xiuWei", 0) or 0), 999999)
    d["YueLi"] = max(int(d.get("YueLi", 0) or 0), 50000)
    d["JingYan"] = max(int(d.get("JingYan", 0) or 0), 50000)
    d["surplusAttributeNum"] = max(int(d.get("surplusAttributeNum", 0) or 0), 50)
    d["SP"] = max(int(d.get("SP", 0) or 0), 100)

def _apply_meridians(d: dict) -> None:
    acupoints = list(d.get("acupointDataList") or [])
    for aid in (10101, 10201, 10202):
        if aid not in acupoints:
            acupoints.append(aid)
    d["acupointDataList"] = acupoints
    jl = list(d.get("acupointJlDataList") or [])
    for jid in (101, 102):
        if jid not in jl:
            jl.append(jid)
    d["acupointJlDataList"] = jl

def _apply_recovery(d: dict) -> None:
    d["HP"] = max(int(d.get("HP", 0) or 0), 9999)
    d["baoShi"] = max(int(d.get("baoShi", 0) or 0), 100)
    d["BigWorldStrength"] = max(float(d.get("BigWorldStrength", 0) or 0), 100.0)
    ra = d.get("roleAttribute")
    if not isinstance(ra, dict):
        ra = {}
    ra["blood"] = max(int(ra.get("blood", 0) or 0), 9999)
    ra["zhenQ"] = max(int(ra.get("zhenQ", 0) or 0), 9999)
    d["roleAttribute"] = ra

def _apply_clean_record(d: dict) -> None:
    d["ArrestNum"] = 0

def _apply_starter_supply(d: dict) -> None:
    items = d.get("listMyItemData")
    if not isinstance(items, list):
        items = []
    existing = {it["itemId"]: it for it in items if isinstance(it, dict) and "itemId" in it}
    for iid in (901000, 901001):
        if iid in existing:
            existing[iid]["count"] = int(existing[iid].get("count", 0) or 0) + 5
        else:
            items.append({"_guid": f"item_{iid}", "itemId": iid, "count": 5})
    d["listMyItemData"] = items

PRESETS: dict[str, dict[str, Any]] = {
    "wealth": {"name": "부유한 시작", "desc": "은자, 금자, 문파 공헌, 무맹 공헌을 지급합니다.", "apply": _apply_wealth},
    "cultivation": {"name": "수련 지원", "desc": "수위, 열력, 경험치, 잔여 속성점을 올립니다.", "apply": _apply_cultivation},
    "meridians": {"name": "경맥 개방", "desc": "대표 경혈과 경락을 열어 줍니다.", "apply": _apply_meridians},
    "recovery": {"name": "상태 완전 회복", "desc": "체력, 기혈, 진기를 회복합니다.", "apply": _apply_recovery},
    "clean_record": {"name": "체포 기록 초기화", "desc": "체포 기록을 초기화합니다.", "apply": _apply_clean_record},
    "starter_supply": {"name": "초반 보급품", "desc": "기본 소모품 아이템을 지급합니다.", "apply": _apply_starter_supply},
}

def apply_preset(doc: SaveDoc, preset_id: str) -> SaveDoc:
    if preset_id not in PRESETS:
        raise KeyError(preset_id)
    nd = dict(doc.data)
    PRESETS[preset_id]["apply"](nd)
    return SaveDoc(key=doc.key, data=nd, was_json=doc.was_json)

# ---------------------------------------------------------------------------
# 파일 저장 흐름
# ---------------------------------------------------------------------------
def save_document(target: Path, doc: SaveDoc, root: Path) -> None:
    if game_running():
        raise RuntimeError(K("game_running"))
    validate_safe_save_path(target, allow_new=True)
    validate_schema(doc.data)
    if target.exists():
        backup_file(target, root)
    atomic_write(target, encode_save(doc))

def restore_backup(backup: Path, target: Path, root: Path) -> None:
    if game_running():
        raise RuntimeError(K("game_running"))
    validate_safe_save_path(backup)
    validate_safe_save_path(target, allow_new=True)
    data = backup.read_bytes()
    if target.exists():
        backup_file(target, root)
    atomic_write(target, data)

# ---------------------------------------------------------------------------
# 슬롯 정리
# ---------------------------------------------------------------------------
def list_slots(root: Path) -> list[Path]:
    out: list[Path] = []
    if not root.is_dir():
        return out
    for p in sorted(root.glob("PlayerData_*.save")):
        n = p.name
        if n.endswith(".bak") or n.startswith("Setting"):
            continue
        if p.is_file():
            out.append(p)
    return out

def list_backups(root: Path) -> list[dict[str, Any]]:
    bdir = root / BACKUP_DIR_NAME
    if not bdir.is_dir():
        return []
    out: list[dict[str, Any]] = []
    for p in bdir.glob("*.bak"):
        try:
            st = p.stat()
            out.append({"name": p.name, "size": st.st_size, "mtime": st.st_mtime})
        except OSError:
            continue
    out.sort(key=lambda x: x["mtime"], reverse=True)
    return out

# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def _print(msg: str) -> None:
    print(msg, flush=True)

def cmd_demo(args: argparse.Namespace) -> int:
    root = discover_root(args.root)
    if root is None:
        _print(K("no_root"))
        return 1
    sample = {
        "firstName": "홍", "lastName": "길동",
        "sliver": 100, "gold": 50, "attribute": 3, "gameLv": 1,
    }
    if args.json:
        _print(json.dumps(sample, ensure_ascii=False, indent=2))
        return 0
    target = root / "PlayerData_demo.save"
    key = "KeyPlayerDatammjh20230001"
    doc = SaveDoc(key=key, data=sample)
    try:
        save_document(target, doc, root)
        _print(K("demo_ok", path=str(target)))
        return 0
    except Exception as e:  # noqa: BLE001
        _print(K("write_fail", err=str(e)))
        return 1

def cmd_discover(args: argparse.Namespace) -> int:
    root = discover_root(args.root)
    if root is None:
        _print(K("no_root"))
        return 1
    _print(K("root_ok", root=str(root)))
    slots = list_slots(root)
    if not slots:
        _print(K("no_files"))
        return 0
    for s in slots:
        _print(K("found", name=s.name))
    return 0

def cmd_inspect(args: argparse.Namespace) -> int:
    p = Path(args.file)
    try:
        doc = read_save(p)
    except Exception as e:  # noqa: BLE001
        _print(K("inspect_fail", path=str(p), err=str(e)))
        return 1
    _print(K("inspect_ok", path=str(p), key=doc.key or "(json)"))
    _print(json.dumps(doc.data, ensure_ascii=False, indent=2))
    return 0

def cmd_validate(args: argparse.Namespace) -> int:
    p = Path(args.file)
    try:
        doc = read_save(p)
        validate_schema(doc.data)
    except Exception as e:  # noqa: BLE001
        _print(K("validate_fail", err=str(e)))
        return 1
    _print(K("validate_ok"))
    return 0

def cmd_presets(_: argparse.Namespace) -> int:
    _print(K("presets_list", ids=", ".join(PRESETS)))
    return 0

def cmd_apply(args: argparse.Namespace) -> int:
    p = Path(args.file)
    root = p.parent
    try:
        doc = read_save(p)
        doc = apply_preset(doc, args.preset)
        save_document(p, doc, root)
        _print(K("preset_ok", path=str(p)))
        return 0
    except KeyError:
        _print(K("preset_unknown", id=args.preset))
        return 1
    except Exception as e:  # noqa: BLE001
        _print(K("write_fail", err=str(e)))
        return 1

def cmd_restore(args: argparse.Namespace) -> int:
    backup = Path(args.backup_file)
    target = Path(args.target_file)
    root = discover_root(None) or target.parent
    try:
        restore_backup(backup, target, root)
        _print(K("restore_ok", path=str(target)))
        return 0
    except Exception as e:  # noqa: BLE001
        _print(K("write_fail", err=str(e)))
        return 1

# ---------------------------------------------------------------------------
# HTTP 서버
# ---------------------------------------------------------------------------
SECURITY_HEADERS = {
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
}

def _session_token() -> str:
    return hashlib.sha256(os.urandom(32)).hexdigest()[:48]

class PokfHandler(BaseHTTPRequestHandler):
    server_version = "PokfEditor/1.0"
    token: str = ""
    root: Path = Path(".")

    def log_message(self, fmt: str, *a: Any) -> None:  # 조용히
        return

    # -- 공통 --
    def _headers(self, status: int, ctype: str = "application/json; charset=utf-8",
                 length: int = 0, extra: Optional[dict[str, str]] = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(length))
        for k, v in SECURITY_HEADERS.items():
            self.send_header(k, v)
        if extra:
            for k, v in extra.items():
                self.send_header(k, v)
        self.end_headers()

    def _send_json(self, status: int, obj: Any) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self._headers(status, length=len(body))
        self.wfile.write(body)

    def _send_bytes(self, status: int, body: bytes, ctype: str,
                    extra: Optional[dict[str, str]] = None) -> None:
        self._headers(status, ctype=ctype, length=len(body), extra=extra)
        self.wfile.write(body)

    def _host_ok(self) -> bool:
        host = self.headers.get("Host", "")
        port = self.server.server_address[1]
        return host in (f"127.0.0.1:{port}", f"localhost:{port}")

    def _origin_ok(self) -> bool:
        origin = self.headers.get("Origin")
        if origin is None:
            return True
        port = self.server.server_address[1]
        return origin in (f"http://127.0.0.1:{port}", f"http://localhost:{port}")

    def _fetch_site_ok(self) -> bool:
        sfs = self.headers.get("Sec-Fetch-Site")
        return sfs in (None, "same-origin", "none")

    def _token_ok(self) -> bool:
        return self.headers.get("X-Pokf-Token", "") == self.token

    def _guard(self, need_token: bool) -> bool:
        if not self._host_ok() or not self._origin_ok() or not self._fetch_site_ok():
            self._send_json(HTTPStatus.FORBIDDEN, {"ok": False, "msg": K("forbidden")})
            return False
        if need_token and not self._token_ok():
            self._send_json(HTTPStatus.FORBIDDEN, {"ok": False, "msg": K("forbidden")})
            return False
        return True

    def _read_json_body(self) -> Optional[dict]:
        try:
            n = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return None
        if n <= 0 or n > 4 * 1024 * 1024:
            return None
        raw = self.rfile.read(n)
        try:
            obj = json.loads(raw.decode("utf-8"))
            return obj if isinstance(obj, dict) else None
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None

    # -- GET --
    def do_GET(self) -> None:  # noqa: N802
        if not self._guard(False):
            return
        path = urlparse(self.path).path
        if path in ("/", "/index.html"):
            return self._serve_index()
        if path == "/api/session":
            return self._send_json(HTTPStatus.OK, {"ok": True, "token": self.token, "root": str(self.root)})
        if path == "/api/slots":
            return self._api_slots()
        if path == "/api/backups":
            return self._send_json(HTTPStatus.OK, {"ok": True, "backups": list_backups(self.root)})
        self._send_json(HTTPStatus.NOT_FOUND, {"ok": False, "msg": "없음."})

    def _serve_index(self) -> None:
        csp = ("default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
               "img-src data: blob:; connect-src 'self'; base-uri 'none'; form-action 'none'")
        dist = Path(__file__).with_name("dist") / "PathOfKungFuSaveEditor-v1.0.html"
        raw: Optional[bytes] = None
        if dist.is_file():
            raw = dist.read_bytes()
        else:
            try:
                import build  # type: ignore
                raw = build.build_html().encode("utf-8")
            except Exception:  # noqa: BLE001
                raw = "<html><body><p>도구 로드 실패</p></body></html>".encode("utf-8")
        served = raw.replace(b"connect-src 'none'", b"connect-src 'self'")
        return self._send_bytes(HTTPStatus.OK, served, "text/html; charset=utf-8",
                                extra={"Content-Security-Policy": csp})

    def _api_slots(self) -> None:
        out = []
        for p in list_slots(self.root):
            ent = {"name": p.name, "size": p.stat().st_size}
            try:
                doc = read_save(p)
                ent["key"] = doc.key
                ent["preview"] = {k: doc.data.get(k) for k in ("firstName", "lastName", "gameLv", "gold")}
            except Exception as e:  # noqa: BLE001
                ent["error"] = str(e)
            out.append(ent)
        self._send_json(HTTPStatus.OK, {"ok": True, "slots": out})

    # -- POST --
    def do_POST(self) -> None:  # noqa: N802
        if not self._guard(True):
            return
        path = urlparse(self.path).path
        if not path.startswith("/api/"):
            return self._send_json(HTTPStatus.NOT_FOUND, {"ok": False, "msg": "없음."})
        body = self._read_json_body()
        if body is None:
            return self._send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "msg": K("invalid")})
        handlers = {
            "/api/load": self._api_load,
            "/api/save": self._api_save,
            "/api/backups": self._api_backups,
            "/api/restore": self._api_restore,
        }
        fn = handlers.get(path)
        if fn is None:
            return self._send_json(HTTPStatus.NOT_FOUND, {"ok": False, "msg": "없음."})
        try:
            fn(body)
        except Exception as e:  # noqa: BLE001
            self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "msg": str(e)})

    def _resolve_slot(self, name: str, allow_new: bool = False) -> Path:
        if not name or "/" in name or "\\" in name or ".." in name:
            raise ValueError(K("invalid"))
        p = (self.root / name).resolve()
        if p.parent != self.root.resolve():
            raise ValueError(K("invalid"))
        validate_safe_save_path(p, allow_new=allow_new)
        return p

    def _resolve_target_name(self, body: dict) -> str:
        name = body.get("name")
        if isinstance(name, str) and name.strip():
            return name.strip()
        slot = body.get("slot")
        if slot is not None:
            s = str(slot).strip()
            return s if s.endswith(".save") else f"PlayerData_{s}.save"
        return ""

    def _slot_id_from_name(self, name: str) -> str:
        stem = name[:-5] if name.endswith(".save") else name
        return stem.split("_")[-1] if "_" in stem else stem

    def _api_load(self, body: dict) -> None:
        name = self._resolve_target_name(body)
        p = self._resolve_slot(name, allow_new=False)
        doc = read_save(p)
        self._send_json(HTTPStatus.OK, {
            "ok": True, "name": name, "slotId": self._slot_id_from_name(name),
            "key": doc.key, "data": doc.data,
        })

    def _api_save(self, body: dict) -> None:
        name = self._resolve_target_name(body)
        p = self._resolve_slot(name, allow_new=True)
        data = body.get("data")
        if not isinstance(data, dict):
            raise ValueError(K("invalid"))
        if game_running():
            raise RuntimeError(K("game_running"))
        if p.is_file():
            doc = read_save(p)
            doc.data = data
        else:
            key = str(body.get("key") or f"KeyPlayerDatammjh2023{self._slot_id_from_name(name)}")
            doc = SaveDoc(key=key, data=data, was_json=(p.suffix.lower() == ".json"))
        save_document(p, doc, self.root)
        self._send_json(HTTPStatus.OK, {"ok": True, "name": name, "msg": K("write_ok", path=str(p))})

    def _api_backups(self, body: dict) -> None:
        self._send_json(HTTPStatus.OK, {"ok": True, "backups": list_backups(self.root)})

    def _api_restore(self, body: dict) -> None:
        name = self._resolve_target_name(body)
        target = self._resolve_slot(name, allow_new=True)
        bdir = (self.root / BACKUP_DIR_NAME).resolve()
        bname = str(body.get("backup", "") or "")
        if bname:
            if "/" in bname or "\\" in bname or ".." in bname:
                raise ValueError(K("invalid"))
            backup = (bdir / bname).resolve()
        else:
            candidates = sorted(
                (q for q in bdir.glob("*.bak") if q.name.startswith(name + ".")),
                key=lambda q: q.stat().st_mtime, reverse=True,
            ) if bdir.is_dir() else []
            if not candidates:
                raise ValueError(K("not_found", path=str(bdir)))
            backup = candidates[0].resolve()
        if backup.parent != bdir or not backup.is_file():
            raise ValueError(K("not_found", path=str(backup)))
        restore_backup(backup, target, self.root)
        self._send_json(HTTPStatus.OK, {"ok": True, "name": name, "msg": K("restore_ok", path=str(target))})

def make_server(host: str, port: int, root: Optional[str]) -> ThreadingHTTPServer:
    if host != "127.0.0.1":
        raise ValueError(K("forbidden"))
    r = discover_root(root) or Path(root).resolve() if root else Path.cwd()
    token = _session_token()
    handler = type("BoundHandler", (PokfHandler,), {"token": token, "root": r})
    return ThreadingHTTPServer((host, port), handler)

def run_server(root: Optional[str], host: str, port: int, open_browser: bool) -> int:
    if host != "127.0.0.1":
        _print(K("forbidden"))
        return 2
    try:
        httpd = make_server(host, port, root)
    except OSError as e:
        _print(K("server_err", err=str(e)))
        return 1
    token = httpd.RequestHandlerClass.token
    actual_port = httpd.server_address[1]
    _print(K("serve_start", host=host, port=actual_port))
    _print(f"세션 토큰: {token}")
    if open_browser:
        try:
            import webbrowser
            webbrowser.open(f"http://{host}:{actual_port}/")
        except Exception:  # noqa: BLE001
            pass
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        _print("종료 중...")
    finally:
        httpd.server_close()
    return 0

# ---------------------------------------------------------------------------
# 인자
# ---------------------------------------------------------------------------
def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="pokf_editor.py", description="도검강호로 저장 편집기")
    sub = ap.add_subparsers(dest="cmd", required=True)

    d = sub.add_parser("demo", help="예제 저장 파일 생성 또는 JSON 출력")
    d.add_argument("--root")
    d.add_argument("--json", action="store_true")
    d.set_defaults(func=cmd_demo)

    dc = sub.add_parser("discover", help="저장 폴더 탐색")
    dc.add_argument("--root")
    dc.set_defaults(func=cmd_discover)

    i = sub.add_parser("inspect", help="저장 파일 검사")
    i.add_argument("file")
    i.set_defaults(func=cmd_inspect)

    v = sub.add_parser("validate", help="스키마 검증")
    v.add_argument("file")
    v.set_defaults(func=cmd_validate)

    p = sub.add_parser("presets", help="프리셋 목록")
    p.set_defaults(func=cmd_presets)

    a = sub.add_parser("apply", help="프리셋 적용")
    a.add_argument("file")
    a.add_argument("--preset", required=True)
    a.set_defaults(func=cmd_apply)

    r = sub.add_parser("restore", help="백업 복원")
    r.add_argument("backup_file")
    r.add_argument("target_file")
    r.set_defaults(func=cmd_restore)

    s = sub.add_parser("serve", help="루프백 HTTP 서버")
    s.add_argument("--root")
    s.add_argument("--host", default="127.0.0.1")
    s.add_argument("--port", type=int, default=0)
    s.add_argument("--open-browser", action="store_true")
    s.set_defaults(func=lambda x: run_server(x.root, x.host, x.port, x.open_browser))
    return ap

def main(argv: Optional[list[str]] = None) -> int:
    ap = build_parser()
    args = ap.parse_args(argv)
    try:
        return int(args.func(args))
    except KeyboardInterrupt:
        return 130

if __name__ == "__main__":
    sys.exit(main())
