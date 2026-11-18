#!/usr/bin/env python3
"""Build the Path of Kung Fu save-editor catalog data.

Usage:
    python tools/extract_catalog.py
    python tools/extract_catalog.py --check-only
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
from pathlib import Path
from typing import Any, Iterable

ROOT = Path(__file__).resolve().parents[1]
PARSED = Path("/home/jiyoung/workspace/무협위키/.local/graph/path-of-kung-fu-data/parsed")
CORPUS = Path("/home/jiyoung/workspace/무협위키/games/path-of-kung-fu/corpus/codex-atlas.json")
OUTPUT = ROOT / "src" / "catalog-data.js"

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

HANZI_RE = re.compile(r"[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]")
KANA_RE = re.compile(r"[\u3040-\u30FF\uFF66-\uFF9F]")
UNITY_RE = re.compile(
    r"</?(?:color|b|i|size|align|material)\b[^>]*>|\[[0-9A-Fa-f]{6}\]|\[-\]"
)
TAG_STRIP_RE = re.compile(r"<[^>]*>|\[[0-9A-Fa-f]{6}\]|\[-\]")
WS_RE = re.compile(r"\s+")
NORM_RE = re.compile(r"[\s_\-·:：/\\|()\[\]{}.,，。]+")

EXTRA_KO = {
    # martial terms / sects / stats / equipment
    "青山剑意": "청산검의",
    "不动如山": "부동여산",
    "逍遥游": "소요유",
    "剑": "검", "刀": "도", "拳": "권", "掌": "장", "指": "지", "腿": "퇴",
    "内功": "내공", "外功": "외공", "轻功": "경공", "心法": "심법",
    "武学": "무학", "秘籍": "비급", "秘卷": "비권", "绝学": "절학",
    "少林": "소림", "武当": "무당", "峨眉": "아미", "华山": "화산",
    "丐帮": "개방", "明教": "명교", "唐门": "당문", "昆仑": "곤륜",
    "崆峒": "공동", "青城": "청성", "天山": "천산", "五毒": "오독",
    "力量": "힘", "身法": "신법", "根骨": "근골", "悟性": "오성",
    "福缘": "복연", "定力": "정력", "臂力": "완력", "资质": "자질",
    "气血": "기혈", "内力": "내력", "攻击": "공격", "防御": "방어",
    "暴击": "치명", "命中": "명중", "闪避": "회피", "速度": "속도",
    "剑法": "검법", "刀法": "도법", "拳法": "권법", "掌法": "장법",
    "指法": "지법", "腿法": "퇴법", "棍法": "곤법", "枪法": "창법",
    "暗器": "암기", "乐器": "악기", "奇门": "기문", "毒术": "독술",
    "医术": "의술", "音律": "음률", "棋艺": "기예", "书画": "서화",
    "Celestial:": "천권·", "Earthly:": "지권·", "Mortal:": "인권·",
    "Celestial": "천권", "Earthly": "지권", "Mortal": "인권",
}

# 59 common acupoint romanizations used by the data corpus.
_ACUPOINT_PAIRS = """
Yunmen 운문
Zhongfu 중부
Tianfu 천부
Xiabai 협백
Chize 척택
Kongzui 공최
Lieque 열결
Jingqu 경거
Taiyuan 태연
Yuji 어제
Shaoshang 소상
Shangyang 상양
Erjian 이간
Sanjian 삼간
Hegu 합곡
Yangxi 양계
Pianli 편력
Wenliu 온류
Xialian 하렴
Shanglian 상렴
Shousanli 수삼리
Quchi 곡지
Jianyu 견우
Yingxiang 영향
Sibai 사백
Juliao 거료
Dicang 지창
Jiache 협거
Xiaguan 하관
Touwei 두유
Yangbai 양백
Fengchi 풍지
Jianjing 견정
Fengmen 풍문
Feishu 폐수
Xinshu 심수
Geshu 격수
Ganshu 간수
Pishu 비수
Shenshu 신수
Mingmen 명문
Changqiang 장강
Yaoyangguan 요양관
Huantiao 환도
Weizhong 위중
Chengshan 승산
Kunlun 곤륜
Taixi 태계
Yongquan 용천
Zusanli 족삼리
Yinlingquan 음릉천
Sanyinjiao 삼음교
Taichong 태충
Qihai 기해
Guanyuan 관원
Zhongwan 중완
Danzhong 단중
Baihui 백회
Yintang 인당
"""
for _line in _ACUPOINT_PAIRS.strip().splitlines():
    _en, _ko = _line.split()
    EXTRA_KO[_en] = _ko

REPLACEMENTS: dict[str, str] = {}
CROSSREF: dict[str, dict[str, str]] = {}
_REP_PATTERN: re.Pattern[str] | None = None


def read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def norm_name(value: Any) -> str:
    text = str(value or "").lower()
    text = NORM_RE.sub("", text)
    return text


def first(obj: dict[str, Any], *keys: str, default: Any = "") -> Any:
    for key in keys:
        if key in obj and obj[key] not in (None, ""):
            return obj[key]
    return default


def as_list(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    if isinstance(value, dict):
        return list(value.values())
    return [value]


def iter_dicts(value: Any) -> Iterable[dict[str, Any]]:
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from iter_dicts(child)
    elif isinstance(value, list):
        for child in value:
            yield from iter_dicts(child)


def collect_pairs(value: Any) -> Iterable[tuple[str, str]]:
    """Yield source->Korean pairs from loose dictionary/codex shapes."""
    if isinstance(value, dict):
        for key, val in value.items():
            if isinstance(val, str) and isinstance(key, str):
                if key not in {"id", "ID", "name", "type", "key"}:
                    yield key, val
            elif isinstance(val, (dict, list)):
                yield from collect_pairs(val)
    elif isinstance(value, list):
        for item in value:
            if isinstance(item, dict):
                ko = first(item, "ko", "kr", "korean", "name_ko", "text_ko")
                for skey in ("en", "cn", "zh", "source", "key", "name", "term"):
                    src = item.get(skey)
                    if isinstance(src, str) and isinstance(ko, str) and ko:
                        yield src, ko
                        break
                yield from collect_pairs(item)


def merge_replacements(value: Any) -> None:
    for src, dst in collect_pairs(value):
        src, dst = str(src).strip(), str(dst).strip()
        if src and dst and src != dst:
            REPLACEMENTS[src] = dst


def record_crossref(obj: dict[str, Any]) -> None:
    names = [
        first(obj, "name_ko", "道具名_ko", "name", "道具名", "skillName", default=""),
        first(obj, "text_ko", "des_ko", "tip_ko", "zzTip_ko", "作用描述_ko", default=""),
    ]
    names = [str(x) for x in names if isinstance(x, str) and x.strip()]
    ko_name = str(first(obj, "name_ko", "道具名_ko", "name", "道具名", default="")).strip()
    ko_desc = str(first(obj, "des_ko", "text_ko", "道具说明_ko", "作用描述_ko",
                         "tip_ko", "zzTip_ko", "textEffect", default="")).strip()
    ident = first(obj, "id", "Id", "ID", default=None)
    rec = {"name": ko_name, "desc": ko_desc}
    if ident not in (None, ""):
        CROSSREF[f"id:{ident}"] = rec
    for name in names:
        if name:
            CROSSREF[f"name:{norm_name(name)}"] = rec


def build_crossref(*roots: Any) -> None:
    for root in roots:
        for obj in iter_dicts(root):
            if any(k in obj for k in ("id", "Id", "ID", "name_ko", "name", "道具名_ko", "道具名")):
                try:
                    record_crossref(obj)
                except Exception:
                    pass


def clean_base(value: Any) -> str:
    global _REP_PATTERN
    text = "" if value is None else str(value)
    text = TAG_STRIP_RE.sub("", text)
    if REPLACEMENTS:
        if _REP_PATTERN is None:
            keys = sorted(REPLACEMENTS, key=len, reverse=True)
            _REP_PATTERN = re.compile("|".join(re.escape(k) for k in keys))
        text = _REP_PATTERN.sub(lambda m: REPLACEMENTS.get(m.group(0), m.group(0)), text)
    text = HANZI_RE.sub("", text)
    text = KANA_RE.sub("", text)
    text = WS_RE.sub(" ", text).strip()
    return text


def to_ko(text: Any, fallback: str = "") -> str:
    raw = "" if text is None else str(text)
    # Recover a manually/codex-provided Korean name when the source is an id/name.
    key = f"name:{norm_name(raw)}"
    rec = CROSSREF.get(key) or CROSSREF.get(f"id:{raw.strip()}")
    if rec and rec.get("name"):
        cleaned_rec = clean_base(rec["name"])
        if cleaned_rec:
            return cleaned_rec
    cleaned = clean_base(raw)
    if cleaned:
        return cleaned
    if rec and rec.get("desc"):
        return clean_base(rec["desc"])
    return fallback


def ko_or(value: Any, fallback: str = "") -> str:
    return to_ko(value, fallback)


def int_or(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def load_sources() -> dict[str, Any]:
    files = {
        "items": "items_and_gear.json",
        "skills": "skills_and_sorceries.json",
        "npcs": "npcs_sects_systems.json",
        "maps": "maps_chests_shops.json",
        "dicts": "dictionaries.json",
        "quests": "quests_and_touches.json",
    }
    loaded = {key: read_json(PARSED / name) for key, name in files.items()}
    loaded["corpus"] = read_json(CORPUS)
    return loaded


def build_catalog(src: dict[str, Any]) -> dict[str, Any]:
    items_src = src["items"]
    skills = src["skills"]
    npcs = src["npcs"]
    maps_src = src["maps"]
    quests = src["quests"]

    # Dictionaries first, then cross-references, then sanitize.
    for part in ("translations", "word_cn", "word_en", "language_en"):
        merge_replacements(src["dicts"].get(part, {}))
    merge_replacements(EXTRA_KO)
    build_crossref(src["items"], src["skills"], src["npcs"], src["maps"], src["quests"], src["corpus"])

    items: list[dict[str, Any]] = []
    for bucket in ("equip", "medicine", "food", "arts", "manual", "material", "quest", "other"):
        for obj in as_list(items_src.get(bucket, [])):
            if not isinstance(obj, dict):
                continue
            ident = first(obj, "id", "ID", default="")
            name_raw = first(obj, "道具名_ko", "道具名", "name", default="")
            desc_raw = first(obj, "text_ko", "text", "道具说明_ko", "作用描述_ko", "des", default="")
            item = {
                "id": ident,
                "bucket": bucket,
                "name": ko_or(name_raw, f"아이템 {ident}"),
                "desc": ko_or(desc_raw),
                "quality": ko_or(first(obj, "品质", "quality", default="")),
                "maxStack": int_or(first(obj, "最大叠加", "maxStack", default=1), 1),
                "subtype": ko_or(first(obj, "子类", "subtype", default="")),
                "weaponType": ko_or(first(obj, "武器类型", "weaponType", default="")),
            }
            items.append(item)

    martial_groups: list[dict[str, Any]] = []
    for obj in as_list(skills.get("martial_groups", [])):
        if not isinstance(obj, dict):
            continue
        ident = first(obj, "Id", "id", "ID", default="")
        martial_groups.append({
            "id": ident,
            "name": ko_or(first(obj, "name_ko", "name", default=""), f"무학 {ident}"),
            "tipType": ko_or(first(obj, "tipType_ko", "tipType", default="")),
            "tipSect": ko_or(first(obj, "tipSect_ko", "tipSect", default="")),
            "desc": ko_or(first(obj, "des_ko", "des", default="")),
            "skills": [ko_or(x) for x in as_list(obj.get("Skill", []))],
        })

    def simple_skill(key: str, id_keys: tuple[str, ...], name_keys: tuple[str, ...],
                     desc_keys: tuple[str, ...], extra: tuple[tuple[str, tuple[str, ...]], ...] = ()) -> list[dict[str, Any]]:
        out = []
        for obj in as_list(skills.get(key, [])):
            if not isinstance(obj, dict):
                continue
            ident = first(obj, *id_keys, default="")
            row = {"id": ident, "name": ko_or(first(obj, *name_keys, default=""), f"{key} {ident}")}
            row["desc"] = ko_or(first(obj, *desc_keys, default=""))
            for label, keys in extra:
                row[label] = ko_or(first(obj, *keys, default=""))
            out.append(row)
        return out

    wuxue = simple_skill(
        "wuxue", ("id", "ID", "Id"), ("name_ko", "name"), ("des_ko", "des", "textEffect"),
        (("type", ("type_ko", "type")), ("sect", ("sect_ko", "sect"))),
    )
    xinjue = simple_skill(
        "xinjue", ("ID", "id", "Id"), ("name_ko", "name"), ("des_ko", "des"),
        (("belong", ("belong_ko", "belong")),),
    )
    sorceries = simple_skill(
        "sorceries", ("id", "ID", "Id"), ("name_ko", "name"), ("textEffect_ko", "textEffect", "des"),
        (("cost", ("cost",)),),
    )
    mijuan = simple_skill(
        "mijuan", ("id", "ID", "Id"), ("name_ko", "name"), ("des_ko", "des"),
        (("wxz", ("wxz_ko", "wxz")), ("rewardTip", ("rewardTip_ko", "rewardTip"))),
    )
    secret_scrolls = simple_skill(
        "secret_scrolls", ("id", "ID", "Id"), ("name_ko", "name"),
        ("textEffect_ko", "textEffect", "effect_ko", "effect", "des"),
        (("effect", ("effect_ko", "effect")), ("cost", ("cost",))),
    )

    inborn = []
    for obj in as_list(npcs.get("inborn", [])):
        if not isinstance(obj, dict):
            continue
        ident = first(obj, "id", "ID", default="")
        inborn.append({
            "id": ident,
            "name": ko_or(first(obj, "name_ko", "name", default=""), f"선천 {ident}"),
            "desc": ko_or(first(obj, "tip_ko", "tip", "des_ko", "des", default="")),
            "cons": ko_or(first(obj, "cons", default="")),
        })

    aptitudes = []
    for obj in as_list(npcs.get("aptitude", [])):
        if not isinstance(obj, dict):
            continue
        ident = first(obj, "id", "ID", default="")
        aptitudes.append({
            "id": ident,
            "name": ko_or(first(obj, "name_ko", "name", default=""), f"자질 {ident}"),
            "desc": ko_or(first(obj, "zzTip_ko", "zzTip", "des_ko", "des", default="")),
        })

    collaterals = []
    for obj in as_list(npcs.get("collaterals", [])):
        if not isinstance(obj, dict):
            continue
        ident = first(obj, "id", "ID", default="")
        collaterals.append({
            "id": ident,
            "name": ko_or(first(obj, "name_ko", "name", default=""), f"경락 {ident}"),
            "acupointId": first(obj, "acupointId", "acupointID", default=""),
            "desc": ko_or(first(obj, "text_ko", "text", "des_ko", "des", default="")),
        })

    acupoints = []
    for obj in as_list(npcs.get("acupoint", [])):
        if not isinstance(obj, dict):
            continue
        ident = first(obj, "id", "ID", default="")
        acupoints.append({
            "id": ident,
            "name": ko_or(first(obj, "name_ko", "name", default=""), f"혈위 {ident}"),
            "col16": ko_or(first(obj, "col_16", "col16", default="")),
            "tip1": ko_or(first(obj, "tip1_ko", "tip1", default="")),
            "desc": ko_or(first(obj, "des_ko", "des", "tip_ko", "tip", default="")),
        })

    parties = []
    for obj in as_list(npcs.get("party", [])):
        if not isinstance(obj, dict):
            continue
        ident = first(obj, "id", "ID", default="")
        parties.append({
            "id": ident,
            "name": ko_or(first(obj, "name_ko", "name", default=""), f"세력 {ident}"),
            "sectStyle": ko_or(first(obj, "sectStyle_ko", "sectStyle", default="")),
        })

    maps = []
    for obj in as_list(maps_src.get("maps", [])):
        if not isinstance(obj, dict):
            continue
        ident = first(obj, "地图ID", "id", "ID", default="")
        maps.append({
            "id": ident,
            "name": ko_or(first(obj, "地图名称_ko", "地图名称", "name", default=""), f"지도 {ident}"),
        })

    npc_ko = quests.get("npc_ko", {}) if isinstance(quests, dict) else {}
    if not isinstance(npc_ko, dict):
        npc_ko = {}
    npc_named = {}
    for obj in as_list(npcs.get("npc_named", [])):
        if isinstance(obj, dict) and first(obj, "id", "ID", default=None) is not None:
            npc_named[str(first(obj, "id", "ID"))] = obj
    npcs_out = []
    for ident, raw_name in npc_ko.items():
        named = npc_named.get(str(ident), {})
        fallback = first(named, "name_ko", "name", default="") if named else ""
        npcs_out.append({
            "id": ident,
            "name": ko_or(raw_name, ko_or(fallback, f"NPC {ident}")),
        })
    if not npcs_out:
        for ident, obj in npc_named.items():
            npcs_out.append({
                "id": ident,
                "name": ko_or(first(obj, "name_ko", "name", default=""), f"NPC {ident}"),
            })

    return {
        "meta": {
            "name": "Path of Kung Fu Catalog",
            "source": "path-of-kung-fu-data",
            "generatedBy": "tools/extract_catalog.py",
        },
        "realms": [
            "조통피모", "단근축골", "내외겸수", "기혈관통", "삼화취정",
            "오기관통", "임독이맥", "일대종사", "등봉조극", "반박귀진",
        ],
        "difficulties": [
            {"id": 0, "name": "보통"},
            {"id": 1, "name": "어려움"},
            {"id": 2, "name": "극난"},
        ],
        "equipSlots": [
            {"id": 0, "name": "무기"},
            {"id": 1, "name": "머리"},
            {"id": 2, "name": "의복"},
            {"id": 3, "name": "장갑"},
            {"id": 4, "name": "신발"},
            {"id": 5, "name": "장신구"},
            {"id": 6, "name": "패식"},
        ],
        "items": items,
        "martialGroups": martial_groups,
        "wuxue": wuxue,
        "xinjue": xinjue,
        "sorceries": sorceries,
        "mijuan": mijuan,
        "secretScrolls": secret_scrolls,
        "inborn": inborn,
        "aptitudes": aptitudes,
        "collaterals": collaterals,
        "acupoints": acupoints,
        "parties": parties,
        "maps": maps,
        "npcs": npcs_out,
    }


def wrap_umd(data: dict[str, Any]) -> str:
    payload = json.dumps(data, ensure_ascii=True, separators=(",", ":"))
    return (
        "(function(root, factory) {\n"
        "  if (typeof module === 'object' && module.exports) module.exports = factory();\n"
        "  else root.PokfCatalogData = factory();\n"
        "})(typeof globalThis !== 'undefined' ? globalThis : this, function() {\n"
        f"var CATALOG_DATA = {payload};\n"
        "return CATALOG_DATA;\n"
        "});\n"
    )


def atomic_write(text: str) -> None:
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{OUTPUT.name}.", suffix=".tmp", dir=str(OUTPUT.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp_name, OUTPUT)
    finally:
        if os.path.exists(tmp_name):
            os.unlink(tmp_name)


def extract_json(text: str) -> Any:
    match = re.search(r"var\s+CATALOG_DATA\s*=\s*(\{.*\})\s*;", text, re.S)
    if not match:
        raise ValueError("CATALOG_DATA JSON block not found")
    return json.loads(match.group(1))


def check_output() -> int:
    if not OUTPUT.exists():
        print(f"missing output: {OUTPUT}", file=sys.stderr)
        return 1
    try:
        data = extract_json(OUTPUT.read_text(encoding="utf-8"))
    except Exception as exc:
        print(f"failed to parse {OUTPUT}: {exc}", file=sys.stderr)
        return 1
    text = json.dumps(data, ensure_ascii=False)
    checks = {
        "hanzi": HANZI_RE,
        "kana": KANA_RE,
        "unity_tags": UNITY_RE,
    }
    failed = False
    for label, regex in checks.items():
        matches = regex.findall(text)
        if matches:
            failed = True
            sample = ", ".join(sorted({str(x) for x in matches})[:12])
            print(f"{label}: {len(matches)} violation(s): {sample}", file=sys.stderr)
        else:
            print(f"{label}: 0")
    if failed:
        return 1
    print(f"catalog clean: {OUTPUT}")
    return 0


def summarize(data: dict[str, Any]) -> str:
    keys = ("items", "martialGroups", "wuxue", "xinjue", "sorceries",
            "mijuan", "secretScrolls", "inborn", "aptitudes", "collaterals",
            "acupoints", "parties", "maps", "npcs")
    parts = [f"{key}={len(data.get(key, []))}" for key in keys]
    return "wrote " + str(OUTPUT) + " (" + ", ".join(parts) + ")"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check-only", "--check", action="store_true", dest="check_only")
    args = parser.parse_args(argv)
    if args.check_only:
        return check_output()
    sources = load_sources()
    data = build_catalog(sources)
    atomic_write(wrap_umd(data))
    print(summarize(data))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
