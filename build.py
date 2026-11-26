#!/usr/bin/env python3
"""Path of Kung Fu (도검강호로) Save Editor — build & verify script."""

from __future__ import annotations

import argparse
import os
import re
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC_DIR = ROOT / "src"
DIST_DIR = ROOT / "dist"
PAGE_PATH = SRC_DIR / "editor-page.html"
OUT_PATH = DIST_DIR / "PathOfKungFuSaveEditor-v1.0.1.html"

MAX_SIZE = 10 * 1024 * 1024

SCRIPT_TAG_RE = re.compile(
    r'<script\b[^>]*\bsrc\s*=\s*["\']([^"\']+)["\'][^>]*>\s*</script\s*>',
    re.IGNORECASE,
)
REMAINING_SRC_RE = re.compile(r"<script\b[^>]*\bsrc\s*=", re.IGNORECASE)
CSP_META_RE = re.compile(
    r"<meta\b[^>]*http-equiv\s*=\s*[\"']Content-Security-Policy[\"'][^>]*>",
    re.IGNORECASE,
)
EXTERNAL_URL_RE = re.compile(
    r"(?:https?://|ftp://|wss?://|//[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)"
)
HANZI_RE = re.compile(r"[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]")
KANA_RE = re.compile(r"[\u3040-\u30FF\uFF66-\uFF9F]")


def _fail(message: str) -> None:
    print(f"❌ {message}", file=sys.stderr)


def _ok(message: str) -> None:
    print(f"✅ {message}")


def _info(message: str) -> None:
    print(f"ℹ️  {message}")


def _read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _inline_scripts(html: str) -> str:
    """Inline <script src="..."> tags with matching file contents."""
    def replacer(match: re.Match[str]) -> str:
        src_attr = match.group(1)
        candidate = src_attr[2:] if src_attr.startswith("./") else src_attr
        path = PAGE_PATH.parent / candidate
        if not path.is_file():
            path = ROOT / candidate
        if not path.is_file():
            raise FileNotFoundError(f"인라인 대상 파일을 찾을 수 없음: {src_attr}")
        code = _read_text(path).replace("</script", "<\\/script")
        return f"<script>\n{code}\n</script>"

    return SCRIPT_TAG_RE.sub(replacer, html)


def build_html() -> str:
    """Build the full single-file HTML from source parts."""
    if not PAGE_PATH.is_file():
        raise FileNotFoundError(f"페이지 파일을 찾을 수 없음: {PAGE_PATH}")
    return _inline_scripts(_read_text(PAGE_PATH))


def _atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        dir=str(path.parent), prefix=".pokf-build-", suffix=".tmp"
    )
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(content)
        os.replace(tmp_path, path)
    except BaseException:
        try:
            tmp_path.unlink()
        except FileNotFoundError:
            pass
        raise


def _extract_csp(html: str) -> list[str]:
    results: list[str] = []
    for match in CSP_META_RE.finditer(html):
        content_match = re.search(
            r'content\s*=\s*(?:"([^"]*)"|\'([^\']*)\')', match.group(0), re.IGNORECASE
        )
        if content_match:
            results.append(content_match.group(1) if content_match.group(1) is not None else content_match.group(2))
    return results


def check_html(html: str) -> list[str]:
    """Return a list of failure messages (empty == pass)."""
    problems: list[str] = []
    size = len(html.encode("utf-8"))
    if size <= 0:
        problems.append("HTML 파일 크기가 0입니다.")
    elif size >= MAX_SIZE:
        problems.append(f"HTML 파일 크기가 10 MiB 이상입니다 ({size} 바이트).")

    remaining = REMAINING_SRC_RE.findall(html)
    if remaining:
        problems.append(f"인라인되지 않은 <script src=...> 태그가 {len(remaining)}개 있습니다.")

    csp_values = _extract_csp(html)
    if not csp_values:
        problems.append("CSP(Content-Security-Policy) meta 태그를 찾을 수 없습니다.")
    else:
        joined = " ".join(csp_values).lower()
        if "default-src 'none'" not in joined:
            problems.append("CSP에 default-src 'none' 지시문이 없습니다.")
        if "connect-src 'none'" not in joined:
            problems.append("CSP에 connect-src 'none' 지시문이 없습니다.")

    urls = EXTERNAL_URL_RE.findall(html)
    if urls:
        sample = ", ".join(sorted(set(urls))[:5])
        problems.append(f"외부 URL이 {len(urls)}개 발견되었습니다: {sample}")

    hanzi = HANZI_RE.findall(html)
    if hanzi:
        sample = "".join(sorted(set(hanzi))[:10])
        problems.append(f"한자(Hanzi) 문자가 {len(hanzi)}개 발견되었습니다: {sample}")
    kana = KANA_RE.findall(html)
    if kana:
        sample = "".join(sorted(set(kana))[:10])
        problems.append(f"가나(Kana) 문자가 {len(kana)}개 발견되었습니다: {sample}")

    return problems


def cmd_build(_args: argparse.Namespace) -> int:
    _info("빌드 시작...")
    try:
        html = build_html()
    except FileNotFoundError as exc:
        _fail(str(exc))
        return 2
    _atomic_write(OUT_PATH, html)
    size = len(html.encode("utf-8"))
    _ok(f"빌드 완료: {OUT_PATH.relative_to(ROOT)} ({size:,} 바이트)")
    return 0


def cmd_check(_args: argparse.Namespace) -> int:
    _info("검사 시작...")
    try:
        html = build_html()
        _info("build_html() 결과를 검사합니다.")
    except FileNotFoundError as exc:
        _info(f"build_html()를 사용할 수 없음 ({exc}); 기존 dist 파일을 검사합니다.")
        if not OUT_PATH.is_file():
            _fail(f"검사할 파일이 없습니다: {OUT_PATH.relative_to(ROOT)}")
            return 2
        html = OUT_PATH.read_text(encoding="utf-8")

    problems = check_html(html)
    if problems:
        for msg in problems:
            _fail(msg)
        return 1
    size = len(html.encode("utf-8"))
    _ok(f"검사 통과 ({size:,} 바이트)")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Path of Kung Fu (도검강호로) 세이브 에디터 빌더")
    parser.add_argument("--check", action="store_true", help="빌드 결과(또는 기존 dist 파일)를 검증만 수행")
    args = parser.parse_args(argv)
    return cmd_check(args) if args.check else cmd_build(args)


if __name__ == "__main__":
    sys.exit(main())
