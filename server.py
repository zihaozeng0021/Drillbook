#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Drillbook · 本地服务（只用 Python 标准库，无需安装任何依赖）

用法：
  python server.py               启动服务并自动打开浏览器
  python server.py --port 9000   指定端口（默认 8765，被占用时自动顺延）
  python server.py --no-browser  不自动打开浏览器
  python server.py --check       只检查题库格式并输出问题，不启动服务
  python server.py --outline     列出所有专题 → 页面 → 知识点（及每个知识点的题数），不启动服务

目录约定（数据格式详见 AGENTS.md）：
  web/                     前端页面
  data/topics/<专题>/      题库：topic.json、source.md、pages/<NN-页面>/{knowledge.md, questions.json}
                           （仍兼容旧名 data/positions/、position.json、jd.md）
  data/records/<专题>.jsonl 作答记录（每行一次作答，程序自动追加）
  data/notes/<专题>/<页面>.md 页面笔记（网页里编辑并自动保存，也可以直接用编辑器打开）
  data/topics/<专题>/pages/<页面>/_history/  网页里编辑 knowledge.md 时自动保留的旧版本（加载时忽略）
  .local/                  本机配置（不进 git）：手机连接的开关和已配对的手机、安卓 App 的签名密钥
  android/                 安卓 App（手机版）：python android/build.py 打包，输出 android/build/drillbook.apk
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import hmac
import ipaddress
import json
import os
import re
import secrets
import shutil
import socket
import sys
import threading
import time
import traceback
import webbrowser
from datetime import datetime
from http.server import BaseHTTPRequestHandler, SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

if sys.version_info < (3, 8):
    sys.exit("需要 Python 3.8 或更高版本")

try:  # Windows 控制台输出中文时避免编码报错
    sys.stdout.reconfigure(errors="replace")
    sys.stderr.reconfigure(errors="replace")
except Exception:
    pass

ROOT = Path(__file__).resolve().parent
WEB_DIR = ROOT / "web"
DATA_DIR = ROOT / "data"
TOPICS_DIR = DATA_DIR / "topics"
if not TOPICS_DIR.is_dir() and (DATA_DIR / "positions").is_dir():
    TOPICS_DIR = DATA_DIR / "positions"  # 旧版目录名，继续支持
TOPICS_REL = TOPICS_DIR.relative_to(ROOT).as_posix()
META_FILES = ("topic.json", "position.json")  # 专题元数据；后者是旧名
SOURCE_FILES = ("source.md", "jd.md")         # 来源原文（JD、目录、大纲）；后者是旧名
KIND_LABEL = {"job": "岗位", "book": "书", "course": "课程", "exam": "考试"}
RECORDS_DIR = DATA_DIR / "records"
ARCHIVE_DIR = RECORDS_DIR / "archive"
NOTES_DIR = DATA_DIR / "notes"
NOTE_HISTORY_KEEP = 30     # 每个页面的笔记 / 知识点文件保留的旧版本数
NOTE_SNAPSHOT_GAP = 600    # 连续编辑时，至少间隔这么多秒才留一份旧版本
LOCAL_DIR = ROOT / ".local"             # 本机配置，不进 git
PHONE_FILE = LOCAL_DIR / "phone.json"   # 手机连接：开关、端口、已配对的手机
APK_FILE = ROOT / "android" / "build" / "drillbook.apk"
PHONE_PORT = 8766          # 手机连接用的局域网端口（被占用时顺延）
PAIR_TTL = 600             # 配对码有效期（秒）
PAIR_MAX_TRIES = 5         # 配对码输错这么多次就作废
PAIR_FAIL_LIMIT = 20       # 10 分钟内配对码总共输错这么多次，暂停配对（换配对码不会清零）
PAIR_FAIL_WINDOW = 600
NONCE_TTL = 120            # 手机签名请求用的一次性随机数，有效期（秒）
NONCE_MAX = 64             # 同时有效的随机数上限
LAN_NETS = tuple(ipaddress.ip_network(n) for n in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))

ID_RE = re.compile(r"^[\w-]+$")                      # 专题 / 页面 / 知识点 / 题目 id
TITLE_RE = re.compile(r"^#\s+(.+?)\s*$")              # knowledge.md 第一行：# 页面标题
POINT_RE = re.compile(r"^##\s+(.+?)\s*(?:\{#([\w-]+)\})?\s*$")  # ## 知识点标题 {#id}
FENCE_RE = re.compile(r"^\s*(```|~~~)")
PAGE_DIR_RE = re.compile(r"^(\d+)[-_ ]+(.+)$")         # 01-rag -> (1, "rag")
LETTERS = "ABCDEFGH"

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".ttf": "font/ttf",
}

records_lock = threading.Lock()
notes_lock = threading.Lock()
knowledge_lock = threading.Lock()


# ───────────────────────────── 题库读取与校验 ─────────────────────────────

class Issues:
    def __init__(self) -> None:
        self.items: list[dict] = []

    def error(self, where: str, msg: str) -> None:
        self.items.append({"level": "error", "where": where, "msg": msg})

    def warn(self, where: str, msg: str) -> None:
        self.items.append({"level": "warn", "where": where, "msg": msg})


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8-sig")  # 兼容带 BOM 的 UTF-8（记事本保存）


def read_json(path: Path):
    return json.loads(read_text(path))


def visible_dirs(parent: Path) -> list[Path]:
    """子文件夹；以 . 或 _ 开头的视为隐藏/草稿，不加载。"""
    if not parent.is_dir():
        return []
    return [d for d in parent.iterdir() if d.is_dir() and not d.name.startswith((".", "_"))]


def parse_knowledge(text: str, where: str, issues: Issues) -> tuple[str | None, str, list[dict]]:
    """把 knowledge.md 拆成：页面标题、导语、知识点列表（每个 ## 标题是一个知识点）。"""
    title = None
    intro: list[str] = []
    points: list[dict] = []
    current: dict | None = None
    in_fence = False
    fence_mark = ""

    for line in text.splitlines():
        fence = FENCE_RE.match(line)
        if fence:
            mark = fence.group(1)
            if not in_fence:
                in_fence, fence_mark = True, mark
            elif mark == fence_mark:
                in_fence = False
        elif not in_fence:
            if title is None and current is None:
                m = TITLE_RE.match(line)
                if m:
                    title = m.group(1)
                    continue
            m = POINT_RE.match(line)
            if m:
                current = {"id": m.group(2), "title": m.group(1).strip(), "lines": []}
                points.append(current)
                continue
        (current["lines"] if current else intro).append(line)

    seen: set[str] = set()
    out = []
    for i, p in enumerate(points, 1):
        pid = p["id"]
        if not pid:
            pid = f"p{i}"
            issues.warn(where, f"知识点「{p['title']}」缺少 id，请在标题后写 {{#英文id}}，否则题目无法稳定关联")
        if pid in seen:
            issues.error(where, f"知识点 id 重复：{pid}")
            continue
        seen.add(pid)
        out.append({"id": pid, "title": p["title"], "content": "\n".join(p["lines"]).strip()})

    if title is None:
        issues.error(where, "第一行需要是页面标题：# 标题")
    if not out:
        issues.warn(where, "没有知识点（用 ## 标题 {#id} 开始一个知识点）")
    return title, "\n".join(intro).strip(), out


def normalize_answer(answer) -> str:
    if isinstance(answer, list):
        answer = "".join(str(a) for a in answer)
    if not isinstance(answer, str):
        return ""
    return "".join(sorted(set(re.sub(r"[\s,，、/]", "", answer.upper()))))


def load_questions(path: Path, page_id: str, dir_name: str, points: list[dict], issues: Issues) -> list[dict]:
    where = f"{dir_name}/questions.json"
    if not path.exists():
        issues.warn(where, "缺少 questions.json")
        return []
    try:
        data = read_json(path)
    except json.JSONDecodeError as e:
        issues.error(where, f"JSON 格式错误：第 {e.lineno} 行第 {e.colno} 列，{e.msg}")
        return []
    if isinstance(data, dict) and isinstance(data.get("questions"), list):
        data = data["questions"]
    if not isinstance(data, list):
        issues.error(where, "内容应为题目数组 [ {...}, {...} ]")
        return []

    point_ids = {p["id"] for p in points}
    seen: set[str] = set()
    out = []
    for i, q in enumerate(data, 1):
        qw = f"{where} 第 {i} 题"
        if not isinstance(q, dict):
            issues.error(qw, "题目应为对象 {...}")
            continue
        qid = str(q.get("id") or "").strip()
        if not qid:
            issues.error(qw, "缺少 id")
            continue
        qw = f"{where}#{qid}"
        if not ID_RE.match(qid):
            issues.error(qw, "id 只能包含字母、数字、下划线、连字符")
            continue
        if qid in seen:
            issues.error(qw, "id 重复")
            continue
        seen.add(qid)

        stem = q.get("stem")
        options = q.get("options")
        if not isinstance(stem, str) or not stem.strip():
            issues.error(qw, "缺少题干 stem")
            continue
        if not isinstance(options, list) or len(options) < 2 or not all(isinstance(o, str) and o.strip() for o in options):
            issues.error(qw, "options 至少需要 2 个非空字符串选项")
            continue
        if len(options) > len(LETTERS):
            issues.error(qw, f"选项最多 {len(LETTERS)} 个")
            continue
        if len({o.strip() for o in options}) != len(options):
            issues.warn(qw, "存在重复选项")

        answer = normalize_answer(q.get("answer"))
        valid = LETTERS[: len(options)]
        if not answer or any(c not in valid for c in answer):
            issues.error(qw, f"答案 {q.get('answer')!r} 不在选项范围 A-{valid[-1]} 内")
            continue
        qtype = q.get("type") or ("multi" if len(answer) > 1 else "single")
        if qtype not in ("single", "multi"):
            issues.error(qw, "type 只能是 single 或 multi")
            continue
        if qtype == "single" and len(answer) > 1:
            issues.error(qw, "单选题只能有一个答案")
            continue

        refs = q.get("points") or []
        if isinstance(refs, str):
            refs = [refs]
        refs = [str(r) for r in refs]
        missing = [r for r in refs if r not in point_ids]
        if missing:
            issues.warn(qw, f"关联的知识点不存在：{', '.join(missing)}")
        refs = [r for r in refs if r in point_ids]
        if not refs:
            issues.warn(qw, "没有关联任何知识点（points）")

        explanation = str(q.get("explanation") or "").strip()
        if not explanation:
            issues.warn(qw, "缺少解析 explanation")

        out.append({
            "id": qid,
            "gid": f"{page_id}/{qid}",
            "type": qtype,
            "points": refs,
            "stem": stem.strip(),
            "options": [o.strip() for o in options],
            "answer": answer,
            "explanation": explanation,
            "shuffle": q.get("shuffle", True) is not False,
        })

    covered = {r for q in out for r in q["points"]}
    for p in points:
        if p["id"] not in covered:
            issues.warn(where, f"知识点「{p['title']}」还没有对应的题目")
    return out


def page_sort_key(d: Path):
    m = PAGE_DIR_RE.match(d.name)
    return (int(m.group(1)) if m else 10**9, d.name)


def load_page(page_dir: Path, issues: Issues) -> dict:
    m = PAGE_DIR_RE.match(page_dir.name)
    index, page_id = (int(m.group(1)), m.group(2)) if m else (None, page_dir.name)
    where = page_dir.name
    if not ID_RE.match(page_id):
        issues.error(where, "页面文件夹名只能包含字母、数字、下划线、连字符，例如 01-rag")

    kfile = page_dir / "knowledge.md"
    if kfile.exists():
        title, intro, points = parse_knowledge(read_text(kfile), f"{where}/knowledge.md", issues)
    else:
        issues.warn(where, "缺少 knowledge.md")
        title, intro, points = None, "", []

    questions = load_questions(page_dir / "questions.json", page_id, page_dir.name, points, issues)
    return {
        "id": page_id,
        "dir": page_dir.name,
        "index": index,
        "title": title or page_id,
        "intro": intro,
        "points": points,
        "questions": questions,
    }


def topic_dir(tid: str) -> Path | None:
    if not tid or not ID_RE.match(tid) or tid.startswith(("_", ".")):
        return None
    d = TOPICS_DIR / tid
    return d if d.is_dir() else None


def first_existing(parent: Path, names: tuple) -> Path | None:
    """按顺序找第一个存在的文件：新文件名在前，旧名兜底。"""
    for name in names:
        f = parent / name
        if f.is_file():
            return f
    return None


def load_topic(tdir: Path) -> dict:
    issues = Issues()
    meta: dict = {}
    mfile = first_existing(tdir, META_FILES)
    if mfile:
        try:
            meta = read_json(mfile)
        except json.JSONDecodeError as e:
            issues.error(mfile.name, f"JSON 格式错误：第 {e.lineno} 行第 {e.colno} 列，{e.msg}")
        if not isinstance(meta, dict):
            issues.error(mfile.name, "内容应为对象 {...}")
            meta = {}
    else:
        issues.warn("topic.json", "缺少 topic.json，暂用文件夹名作为专题名")

    sfile = first_existing(tdir, SOURCE_FILES)
    source = read_text(sfile).strip() if sfile else None

    pages = []
    seen: set[str] = set()
    for d in sorted(visible_dirs(tdir / "pages"), key=page_sort_key):
        page = load_page(d, issues)
        if page["id"] in seen:
            issues.error(d.name, f"页面 id 重复：{page['id']}")
            continue
        seen.add(page["id"])
        pages.append(page)
    if not pages:
        issues.warn("pages", "还没有页面（在 pages/ 下新建 01-xxx 文件夹）")

    for page in pages:
        nf = note_file(tdir.name, page["id"])
        page["noteSize"] = nf.stat().st_size if nf.is_file() else 0
    note_dir = NOTES_DIR / tdir.name
    if note_dir.is_dir():
        ids = {p["id"] for p in pages}
        for f in sorted(note_dir.glob("*.md")):
            if f.stem not in ids:
                issues.warn(f"data/notes/{tdir.name}/{f.name}", "这份笔记没有对应的页面（页面 id 改过的话，把文件名改成新的页面 id）")

    return {
        "id": tdir.name,
        "name": str(meta.get("name") or tdir.name),
        "kind": str(meta.get("kind") or "").strip(),
        "origin": str(meta.get("origin") or meta.get("company") or ""),  # company 是旧字段名
        "description": str(meta.get("description") or ""),
        "order": meta.get("order") if isinstance(meta.get("order"), (int, float)) else 0,
        "source": source,
        "sourceFile": sfile.name if sfile else None,
        "path": f"{TOPICS_REL}/{tdir.name}",
        "pages": pages,
        "issues": issues.items,
    }


def topic_summary(p: dict) -> dict:
    return {
        "id": p["id"],
        "name": p["name"],
        "kind": p["kind"],
        "origin": p["origin"],
        "description": p["description"],
        "order": p["order"],
        "pageCount": len(p["pages"]),
        "questionCount": sum(len(pg["questions"]) for pg in p["pages"]),
        "issueCount": len(p["issues"]),
    }


def all_topics() -> list[dict]:
    return [load_topic(d) for d in visible_dirs(TOPICS_DIR) if ID_RE.match(d.name)]


def list_topics() -> list[dict]:
    out = [topic_summary(p) for p in all_topics()]
    out.sort(key=lambda p: (p["order"], p["name"]))
    return out


# ───────────────────────────── 作答记录 ─────────────────────────────

def records_file(tid: str) -> Path:
    return RECORDS_DIR / f"{tid}.jsonl"


def read_records(tid: str) -> tuple[list[dict], int]:
    path = records_file(tid)
    out: list[dict] = []
    skipped = 0
    if not path.exists():
        return out, skipped
    with records_lock, path.open("r", encoding="utf-8-sig") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                skipped += 1
                continue
            if isinstance(r, dict) and isinstance(r.get("q"), str) and isinstance(r.get("ok"), bool) and isinstance(r.get("t"), (int, float)):
                out.append(r)
            else:
                skipped += 1
    out.sort(key=lambda r: r["t"])
    return out, skipped


def append_records(tid: str, items: list) -> int:
    now = int(time.time() * 1000)
    clean = []
    for r in items:
        if not isinstance(r, dict) or not isinstance(r.get("q"), str) or not isinstance(r.get("ok"), bool):
            continue
        t = r.get("t")
        unknown = r.get("unknown") is True
        rec = {
            "t": int(t) if isinstance(t, (int, float)) and 0 < t <= now + 86_400_000 else now,
            "q": r["q"][:200],
            "ok": False if unknown else r["ok"],
        }
        if unknown:
            rec["unknown"] = True
            rec["pick"] = ""
        elif isinstance(r.get("pick"), str):
            rec["pick"] = r["pick"][:16]
        if isinstance(r.get("src"), str):
            rec["src"] = r["src"][:16]
        if isinstance(r.get("dur"), (int, float)) and r["dur"] >= 0:
            rec["dur"] = int(r["dur"])
        clean.append(rec)
    if not clean:
        return 0
    RECORDS_DIR.mkdir(parents=True, exist_ok=True)
    with records_lock, records_file(tid).open("a", encoding="utf-8", newline="\n") as f:
        for rec in clean:
            f.write(json.dumps(rec, ensure_ascii=False, separators=(",", ":")) + "\n")
        f.flush()
        os.fsync(f.fileno())
    return len(clean)


def resets_file() -> Path:
    return RECORDS_DIR / "resets.json"


def read_resets() -> dict:
    """每个专题最近一次重置的时间（毫秒）。早于它的作答记录不再算数；手机同步时两边都按它清理。"""
    try:
        data = json.loads(resets_file().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    return {k: int(v) for k, v in data.items() if isinstance(k, str) and isinstance(v, (int, float))}


def write_resets(resets: dict) -> None:
    RECORDS_DIR.mkdir(parents=True, exist_ok=True)
    tmp = resets_file().with_name("resets.json.tmp")
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        json.dump(dict(sorted(resets.items())), f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, resets_file())


def archive_target(tid: str) -> Path:
    ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
    stamp = f"{tid}-{datetime.now():%Y%m%d-%H%M%S}"
    target, n = ARCHIVE_DIR / f"{stamp}.jsonl", 1
    while target.exists():
        target, n = ARCHIVE_DIR / f"{stamp}_{n}.jsonl", n + 1
    return target


def archive_records(tid: str) -> str | None:
    """重置 = 把记录文件移动到 data/records/archive/，不直接删除；并记下重置时间（手机同步时按它清理）。"""
    src = records_file(tid)
    with records_lock:
        resets = read_resets()
        resets[tid] = int(time.time() * 1000)
        write_resets(resets)
        if not src.exists():
            return None
        target = archive_target(tid)
        shutil.move(str(src), str(target))
    return f"data/records/archive/{target.name}"


def archive_before_locked(tid: str, cutoff: int) -> int:
    """手机上重置过：把早于重置时间的记录移到 archive/，之后的留下。返回移走的条数；调用方须持有 records_lock。"""
    src = records_file(tid)
    if not src.exists():
        return 0
    old, keep = [], []
    for line in src.read_text(encoding="utf-8-sig").splitlines():
        if not line.strip():
            continue
        try:
            t = json.loads(line).get("t")
        except (ValueError, AttributeError):
            t = None
        (old if isinstance(t, (int, float)) and t < cutoff else keep).append(line)
    if not old:
        return 0
    with open(archive_target(tid), "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(old) + "\n")
    if keep:
        tmp = src.with_name(src.name + ".tmp")
        with open(tmp, "w", encoding="utf-8", newline="\n") as f:
            f.write("\n".join(keep) + "\n")
        os.replace(tmp, src)
    else:
        src.unlink()
    return len(old)


# ───────────────────────────── 页面笔记 ─────────────────────────────

def page_ids(tdir: Path) -> set[str]:
    ids = set()
    for d in visible_dirs(tdir / "pages"):
        m = PAGE_DIR_RE.match(d.name)
        ids.add(m.group(2) if m else d.name)
    return ids


def note_file(tid: str, page_id: str) -> Path:
    return NOTES_DIR / tid / f"{page_id}.md"


def digest(raw: bytes) -> str:
    """文件内容指纹：网页保存时带上它，用来发现文件是否在别处被改过。"""
    return hashlib.sha256(raw).hexdigest()[:16] if raw else ""


def decode_note(raw: bytes) -> str:
    return raw.decode("utf-8-sig", errors="replace").replace("\r\n", "\n")


def read_note(tid: str, page_id: str) -> dict:
    path = note_file(tid, page_id)
    with notes_lock:
        raw = path.read_bytes() if path.is_file() else b""
    return {"content": decode_note(raw), "hash": digest(raw), "size": len(raw), "path": f"data/notes/{tid}/{page_id}.md"}


def snapshot(hdir: Path, old_raw: bytes, new_size: int) -> None:
    """覆盖前把旧内容存到 hdir：连续编辑时每 10 分钟最多一份；内容一下少了一半以上（比如误删）时总会存。"""
    snaps = sorted(hdir.glob("*.md")) if hdir.is_dir() else []
    recent = bool(snaps) and time.time() - snaps[-1].stat().st_mtime < NOTE_SNAPSHOT_GAP
    if recent and new_size >= len(old_raw) * 0.5:
        return
    hdir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    target, n = hdir / f"{stamp}.md", 1
    while target.exists():
        target, n = hdir / f"{stamp}_{n}.md", n + 1
    target.write_bytes(old_raw)
    snaps.append(target)
    for old in snaps[:-NOTE_HISTORY_KEEP]:
        try:
            old.unlink()
        except OSError:
            pass


def write_note(tid: str, page_id: str, content: str, base: str | None) -> tuple[int, dict]:
    path = note_file(tid, page_id)
    new_raw = content.replace("\r\n", "\n").encode("utf-8")
    with notes_lock:
        old_raw = path.read_bytes() if path.is_file() else b""
        current = digest(old_raw)
        if base is not None and base != current:
            return 409, {"error": "笔记文件已在别处修改", "content": decode_note(old_raw), "hash": current}
        if old_raw and old_raw != new_raw:
            snapshot(NOTES_DIR / tid / "_history" / page_id, old_raw, len(new_raw))
        if not content.strip():
            if path.exists():
                path.unlink()
            return 200, {"hash": "", "size": 0}
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp")
        with open(tmp, "wb") as f:
            f.write(new_raw)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)  # 原子替换：保存过程中断电也不会留下半个文件
        return 200, {"hash": digest(new_raw), "size": len(new_raw)}


# ───────────────────────────── 知识点文件编辑 ─────────────────────────────

def page_dir_of(tdir: Path, page_id: str) -> Path | None:
    for d in visible_dirs(tdir / "pages"):
        m = PAGE_DIR_RE.match(d.name)
        if (m.group(2) if m else d.name) == page_id:
            return d
    return None


def read_knowledge(tid: str, page_dir: Path) -> dict:
    path = page_dir / "knowledge.md"
    with knowledge_lock:
        raw = path.read_bytes() if path.is_file() else b""
    return {"content": decode_note(raw), "hash": digest(raw), "size": len(raw), "path": f"{TOPICS_REL}/{tid}/pages/{page_dir.name}/knowledge.md"}


def check_knowledge(page_dir: Path, old_text: str, new_text: str) -> list[dict]:
    """保存后立即解析一遍：格式问题，以及被删掉或改名、却仍有题目关联的知识点 id。"""
    issues = Issues()
    where = f"{page_dir.name}/knowledge.md"
    new_points = parse_knowledge(new_text, where, issues)[2]
    old_points = parse_knowledge(old_text, where, Issues())[2] if old_text.strip() else []
    removed = {p["id"] for p in old_points} - {p["id"] for p in new_points}
    if removed:
        refs: dict[str, int] = {}
        qfile = page_dir / "questions.json"
        try:
            data = read_json(qfile) if qfile.exists() else []
            if isinstance(data, dict):
                data = data.get("questions") or []
            for q in data if isinstance(data, list) else []:
                pts = q.get("points") if isinstance(q, dict) else None
                for r in ([pts] if isinstance(pts, str) else pts or []):
                    refs[str(r)] = refs.get(str(r), 0) + 1
        except Exception:
            pass
        for pid in sorted(removed):
            if refs.get(pid):
                issues.error(where, f"知识点 id「{pid}」被删除或改名，但本页仍有 {refs[pid]} 道题关联它")
            else:
                issues.warn(where, f"知识点 id「{pid}」被删除或改名，指向它的站内链接会失效")
    return issues.items


def write_knowledge(page_dir: Path, content: str, base: str | None) -> tuple[int, dict]:
    path = page_dir / "knowledge.md"
    new_raw = content.replace("\r\n", "\n").encode("utf-8")
    with knowledge_lock:
        old_raw = path.read_bytes() if path.is_file() else b""
        current = digest(old_raw)
        if base is not None and base != current:
            return 409, {"error": "knowledge.md 已在别处修改", "content": decode_note(old_raw), "hash": current}
        if old_raw and old_raw != new_raw:
            snapshot(page_dir / "_history", old_raw, len(new_raw))
        tmp = path.with_name(path.name + ".tmp")
        with open(tmp, "wb") as f:
            f.write(new_raw)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    issues = check_knowledge(page_dir, decode_note(old_raw), decode_note(new_raw))
    return 200, {"hash": digest(new_raw), "size": len(new_raw), "issues": issues}


# ───────────────────────────── 手机连接 ─────────────────────────────
#
# 安卓 App（android/）把网站代码打包在自己里面离线运行，和这台电脑通过局域网双向同步。
# · 默认关闭。在电脑网页的「连接手机」里打开后，额外监听一个局域网端口（默认 8766）；
#   这个端口只提供下面几个手机用的接口和 App 安装包，不提供网页和其他接口
# · 第一次连接要输入电脑网页上显示的 6 位配对码（10 分钟内有效，输错 5 次作废），手机拿到一个长期令牌。
#   之后令牌不再在网络上传输：同步请求用它签名（见 PhoneLink.verify）。电脑上只保存令牌的 sha256
# · 同步规则见 apply_phone_sync / merge_phone_note；各专题的重置时间记在 data/records/resets.json
# · 开关、端口和已配对的手机保存在 .local/phone.json（不进 git）

def lan_addresses() -> list[str]:
    """这台电脑在局域网里的 IPv4 地址，默认出口网卡的排在最前。"""
    found: list[str] = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("192.0.2.1", 9))  # UDP 的 connect 不发包，只用来查出口网卡
            found.append(s.getsockname()[0])
        finally:
            s.close()
    except OSError:
        pass
    try:
        found += socket.gethostbyname_ex(socket.gethostname())[2]
    except OSError:
        pass
    out: list[str] = []
    for ip in found:
        try:
            addr = ipaddress.ip_address(ip)
        except ValueError:
            continue
        # 只要家庭 / 局域网地址段（与 App 允许连接的范围一致）；代理软件的虚拟网卡（如 198.18.x）不算
        if any(addr in net for net in LAN_NETS) and ip not in out:
            out.append(ip)
    return out


def topic_fingerprint(p: dict) -> str:
    """题库内容的指纹（不含随笔记变化的 noteSize）：手机上已有同一份时不再重复下发。"""
    pages = [{k: v for k, v in pg.items() if k != "noteSize"} for pg in p["pages"]]
    return digest(json.dumps(dict(p, pages=pages), ensure_ascii=False, sort_keys=True).encode("utf-8"))


def phone_bundle(server_id: str, known=None) -> dict:
    """手机拿到的电脑上的全部数据：题库（解析好的）、作答记录、笔记、重置时间。
    known 是手机上已有的题库指纹 {专题: 指纹}，指纹没变的专题只发记录和笔记。"""
    known = known if isinstance(known, dict) else {}
    topics, data = [], {}
    for p in all_topics():
        tid = p["id"]
        notes = {}
        for pg in p["pages"]:
            nf = note_file(tid, pg["id"])
            with notes_lock:
                raw = nf.read_bytes() if nf.is_file() else b""
                mtime = int(nf.stat().st_mtime * 1000) if raw else 0
            if raw:
                notes[pg["id"]] = {"content": decode_note(raw), "hash": digest(raw), "mtime": mtime}
        fp = topic_fingerprint(p)
        topics.append(topic_summary(p))
        data[tid] = {"topic": None if known.get(tid) == fp else p, "hash": fp, "records": read_records(tid)[0], "notes": notes}
    topics.sort(key=lambda p: (p["order"], p["name"]))
    return {
        "app": "drillbook",
        "serverId": server_id,
        "time": int(time.time() * 1000),
        "topics": topics,
        "data": data,
        "resets": read_resets(),
    }


def save_note_copy(tid: str, page_id: str, raw: bytes, who: str) -> str | None:
    """两边都改过的笔记：没被采用的那份存进 _history/<页面>/，文件名带 -phone（手机的）或 -pc（电脑的）。"""
    if not raw:
        return None
    hdir = NOTES_DIR / tid / "_history" / page_id
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    with notes_lock:
        hdir.mkdir(parents=True, exist_ok=True)
        target, n = hdir / f"{stamp}-{who}.md", 1
        while target.exists():
            target, n = hdir / f"{stamp}-{who}_{n}.md", n + 1
        target.write_bytes(raw)
    return f"data/notes/{tid}/_history/{page_id}/{target.name}"


def merge_phone_note(tid: str, page_id: str, content: str, base, updated_at, page_exists: bool) -> dict | None:
    """合并手机上改过的一份笔记。base 是手机上次同步时电脑那份的指纹：
    · 等于电脑当前的指纹 → 电脑没改过，用手机的
    · 不等 → 两边都改过：用改得晚的那份，另一份另存，不丢"""
    content = content.replace("\r\n", "\n")
    mine = content.encode("utf-8") if content.strip() else b""
    path = note_file(tid, page_id)
    with notes_lock:
        raw = path.read_bytes() if path.is_file() else b""
        mtime = int(path.stat().st_mtime * 1000) if raw else 0
    current = digest(raw)
    if digest(mine) == current:
        return None  # 两边已经一样
    info = {"tid": tid, "pageId": page_id}
    if not page_exists:  # 电脑上已经没有这个页面：手机这份另存
        return dict(info, conflict=True, kept="pc", saved=save_note_copy(tid, page_id, mine, "phone"))
    pc_changed = base != current
    if pc_changed and not (isinstance(updated_at, (int, float)) and updated_at > mtime):
        return dict(info, conflict=True, kept="pc", saved=save_note_copy(tid, page_id, mine, "phone"))
    saved = save_note_copy(tid, page_id, raw, "pc") if pc_changed else None
    status, _ = write_note(tid, page_id, content, current)
    if status != 200:  # 就在这一刻电脑上又改了：这次不动，下次同步再合并
        return dict(info, retry=True)
    return dict(info, conflict=True, kept="phone", saved=saved) if pc_changed else dict(info, kept="phone")


def apply_phone_sync(body: dict) -> dict:
    """把手机上的改动合并进电脑：重置、作答记录、笔记。返回合并结果。
    · 重置取两边较晚的那次；手机的更晚时，电脑上更早的记录移到 data/records/archive/
    · 作答记录两边合并，同一时间、同一道题算同一条；早于重置时间的不要"""
    report: dict = {"records": 0, "notes": [], "conflicts": [], "resets": []}
    topics = {d.name: d for d in visible_dirs(TOPICS_DIR) if ID_RE.match(d.name)}
    now = int(time.time() * 1000)

    phone_resets = body.get("resets") if isinstance(body.get("resets"), dict) else {}
    with records_lock:
        resets = read_resets()
        changed = False
        for tid, t in phone_resets.items():
            if tid in topics and isinstance(t, (int, float)) and resets.get(tid, 0) < t <= now + 86_400_000:
                moved = archive_before_locked(tid, int(t))
                resets[tid] = int(t)
                changed = True
                report["resets"].append({"tid": tid, "archived": moved})
        if changed:
            write_resets(resets)

    uploads = body.get("records") if isinstance(body.get("records"), dict) else {}
    for tid, items in uploads.items():
        if tid not in topics or not isinstance(items, list):
            continue
        cutoff = resets.get(tid, 0)
        seen = {(int(r["t"]), r["q"]) for r in read_records(tid)[0]}
        fresh = []
        for r in items:
            if not isinstance(r, dict) or not isinstance(r.get("q"), str) or not isinstance(r.get("t"), (int, float)):
                continue
            key = (int(r["t"]), r["q"][:200])
            if key[0] < cutoff or key[0] > now + 86_400_000 or key in seen:
                continue
            seen.add(key)
            fresh.append(r)
        report["records"] += append_records(tid, fresh)

    for n in body.get("notes") if isinstance(body.get("notes"), list) else []:
        if not isinstance(n, dict):
            continue
        tid, page_id, content = n.get("tid"), n.get("pageId"), n.get("content")
        if tid not in topics or not isinstance(page_id, str) or not ID_RE.match(page_id) or not isinstance(content, str):
            continue
        result = merge_phone_note(tid, page_id, content, n.get("base"), n.get("updatedAt"), page_id in page_ids(topics[tid]))
        if result:
            report["conflicts" if result.get("conflict") else "notes"].append(result)
    return report


def log_sync(device: dict, report: dict) -> None:
    parts = []
    if report["records"]:
        parts.append(f"{report['records']} 条作答记录")
    if report["notes"]:
        parts.append(f"{len(report['notes'])} 份笔记")
    if report["resets"]:
        parts.append("重置 " + "、".join(r["tid"] for r in report["resets"]))
    if parts:
        print(f"手机同步（{device.get('name')}）：收到 " + "，".join(parts), flush=True)
    for c in report["conflicts"]:
        kept = "手机" if c.get("kept") == "phone" else "电脑"
        where = f"，另一份存在 {c['saved']}" if c.get("saved") else ""
        print(f"  笔记 {c['tid']}/{c['pageId']} 两边都改过：保留{kept}上的版本{where}", flush=True)


class PhoneLink:
    """手机连接的状态：配对码、已配对的手机、局域网端口的开关。"""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.httpd: ThreadingHTTPServer | None = None
        self.port: int | None = None
        self.error = ""
        self.pairing: dict | None = None  # {"code", "expires", "tries"}
        self.failures: list[float] = []   # 最近输错配对码的时间
        self.nonces: dict[str, float] = {}  # 签名请求用的一次性随机数 → 过期时间
        self.config = self._load()

    @staticmethod
    def _load() -> dict:
        cfg: dict = {}
        try:
            data = json.loads(PHONE_FILE.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                cfg = data
        except (OSError, ValueError):
            pass
        sid = cfg.get("serverId")
        cfg["serverId"] = sid if isinstance(sid, str) and ID_RE.match(sid) else secrets.token_hex(8)
        cfg["enabled"] = cfg.get("enabled") is True
        port = cfg.get("port")
        cfg["port"] = port if isinstance(port, int) and 1024 <= port <= 65535 else PHONE_PORT
        devices = cfg.get("devices")
        cfg["devices"] = [d for d in devices if isinstance(d, dict) and isinstance(d.get("tokenHash"), str)] if isinstance(devices, list) else []
        return cfg

    def _save(self) -> None:
        LOCAL_DIR.mkdir(parents=True, exist_ok=True)
        tmp = PHONE_FILE.with_name(PHONE_FILE.name + ".tmp")
        with open(tmp, "w", encoding="utf-8", newline="\n") as f:
            json.dump(self.config, f, ensure_ascii=False, indent=2)
            f.write("\n")
        os.replace(tmp, PHONE_FILE)

    def status(self) -> dict:
        addresses = lan_addresses()
        apk = APK_FILE.stat() if APK_FILE.is_file() else None
        with self.lock:
            p = self.pairing
            if p and p["expires"] < time.time():
                p = self.pairing = None
            return {
                "enabled": self.config["enabled"],
                "running": self.httpd is not None,
                "port": self.port or self.config["port"],
                "error": self.error,
                "addresses": addresses,
                "code": {"value": p["code"], "expires": int(p["expires"] * 1000)} if p else None,
                "devices": [{k: d.get(k) for k in ("id", "name", "pairedAt", "lastSeen")} for d in self.config["devices"]],
                "apk": {"size": apk.st_size, "mtime": int(apk.st_mtime * 1000)} if apk else None,
            }

    def set_enabled(self, on: bool) -> None:
        with self.lock:
            self.config["enabled"] = on
            self._save()
        if on:
            self.start()
        else:
            self.stop()

    def start(self) -> bool:
        with self.lock:
            if self.httpd:
                return True
            base = self.config["port"]
            for p in range(base, base + 10):
                try:
                    httpd = PhoneServer(("0.0.0.0", p), PhoneHandler)
                    break
                except OSError:
                    continue
            else:
                self.error = f"端口 {base}-{base + 9} 都被占用了"
                return False
            self.httpd, self.port, self.error = httpd, p, ""
        threading.Thread(target=httpd.serve_forever, name="phone", daemon=True).start()
        return True

    def stop(self) -> None:
        with self.lock:
            httpd, self.httpd, self.port, self.pairing = self.httpd, None, None, None
        if httpd:
            httpd.shutdown()
            httpd.server_close()

    def new_code(self) -> None:
        with self.lock:
            self.pairing = {"code": f"{secrets.randbelow(10**6):06d}", "expires": time.time() + PAIR_TTL, "tries": 0}

    def pair(self, code, name) -> tuple[int, dict]:
        with self.lock:
            now = time.time()
            self.failures = [t for t in self.failures if now - t < PAIR_FAIL_WINDOW]
            if len(self.failures) >= PAIR_FAIL_LIMIT:
                return 429, {"error": "配对码输错的次数太多，请 10 分钟后再试"}
            p = self.pairing
            if not p or p["expires"] < now:
                self.pairing = None
                return 403, {"error": "配对码已失效：在电脑上的「连接手机」里换一个"}
            if not isinstance(code, str) or not hmac.compare_digest(re.sub(r"\s", "", code).encode(), p["code"].encode()):
                self.failures.append(now)
                p["tries"] += 1
                if p["tries"] >= PAIR_MAX_TRIES:
                    self.pairing = None
                    return 403, {"error": "配对码输错次数太多，已作废：在电脑上换一个"}
                return 403, {"error": "配对码不对"}
            token = secrets.token_hex(32)
            now = int(time.time() * 1000)
            device = {
                "id": secrets.token_hex(4),
                "name": name.strip()[:40] if isinstance(name, str) and name.strip() else "手机",
                "tokenHash": hashlib.sha256(token.encode()).hexdigest(),
                "pairedAt": now,
                "lastSeen": now,
            }
            self.config["devices"].append(device)
            self.pairing = None
            self._save()
            return 200, {"token": token, "deviceId": device["id"], "serverId": self.config["serverId"]}

    def new_nonce(self) -> str:
        with self.lock:
            now = time.time()
            self.nonces = {k: v for k, v in self.nonces.items() if v > now}
            while len(self.nonces) >= NONCE_MAX:
                self.nonces.pop(next(iter(self.nonces)))
            nonce = secrets.token_hex(16)
            self.nonces[nonce] = now + NONCE_TTL
            return nonce

    def verify(self, headers, method: str, path: str, raw: bytes) -> dict | None:
        """校验手机的签名请求，返回对应的手机。配对之后令牌不再在网络上传输：手机用 sha256(令牌) 作密钥，
        对「方法、路径、一次性随机数、请求体指纹」做 HMAC；随机数用一次就作废，截获的请求不能重放。"""
        did = headers.get("X-Drillbook-Device") or ""
        nonce = headers.get("X-Drillbook-Nonce") or ""
        sig = headers.get("X-Drillbook-Signature") or ""
        with self.lock:
            if self.nonces.pop(nonce, 0) < time.time():
                return None
            device = next((d for d in self.config["devices"] if d.get("id") == did), None)
            if not device:
                return None
            msg = f"{method}\n{path}\n{nonce}\n{hashlib.sha256(raw).hexdigest()}".encode("utf-8")
            expected = hmac.new(bytes.fromhex(device["tokenHash"]), msg, hashlib.sha256).hexdigest()
            if not hmac.compare_digest(expected, sig):
                return None
            device["lastSeen"] = int(time.time() * 1000)
            self._save()
            return device

    def remove_device(self, did: str) -> None:
        with self.lock:
            kept = [d for d in self.config["devices"] if d.get("id") != did]
            if len(kept) != len(self.config["devices"]):
                self.config["devices"] = kept
                self._save()


link = PhoneLink()


# ───────────────────────────── HTTP 服务 ─────────────────────────────

class ApiMixin:
    """电脑网页用的服务和手机连接用的局域网端口共用：JSON 收发、手机接口、App 安装包。"""

    def send_json(self, obj, status: int = 200, compress: bool = False):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        gz = compress and len(body) > 2048 and "gzip" in (self.headers.get("Accept-Encoding") or "")
        if gz:
            body = gzip.compress(body, 6)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        if gz:
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_raw(self) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        if length < 0 or length > 5_000_000:  # 负数会让 read() 一直读到连接关闭
            raise ValueError("请求体长度无效")
        return self.rfile.read(length) if length else b""

    def read_body(self):
        return json.loads(self.read_raw().decode("utf-8") or "null")

    def is_json(self) -> bool:
        """写操作要求 JSON 请求头：别的网站只能发「简单请求」（text/plain、表单），带不上这个头。"""
        return (self.headers.get("Content-Type") or "").lower().startswith("application/json")

    def send_apk(self):
        if not APK_FILE.is_file():
            return self.send_json({"error": "还没有打包 App：在项目文件夹里运行 python android/build.py"}, 404)
        data = APK_FILE.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "application/vnd.android.package-archive")
        self.send_header("Content-Disposition", 'attachment; filename="drillbook.apk"')
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def handle_phone(self, method: str, parts: list[str]) -> bool:
        """手机用的接口（两个服务都提供）。不是这几个接口时返回 False。"""
        if method == "GET" and parts == ["phone", "hello"]:
            self.send_json({"app": "drillbook", "serverId": link.config["serverId"], "name": socket.gethostname()})
        elif method == "POST" and parts == ["phone", "pair"]:
            if not self.is_json():
                self.send_json({"error": "请求需要 JSON 格式"}, 415)
                return True
            body = self.read_body()
            body = body if isinstance(body, dict) else {}
            status, payload = link.pair(body.get("code"), body.get("name"))
            self.send_json(payload, status)
        elif method == "GET" and parts == ["phone", "nonce"]:
            self.send_json({"nonce": link.new_nonce()})
        elif method == "POST" and parts == ["phone", "sync"]:
            # 同步：先把手机上的改动合并进电脑，再把合并后的全部数据发回手机
            if not self.is_json():
                self.send_json({"error": "请求需要 JSON 格式"}, 415)
                return True
            raw = self.read_raw()
            device = link.verify(self.headers, method, "/api/phone/sync", raw)
            if not device:
                self.send_json({"error": "这台手机需要重新配对（可能已在电脑上被移除）"}, 401)
                return True
            body = json.loads(raw.decode("utf-8") or "null")
            body = body if isinstance(body, dict) else {}
            report = apply_phone_sync(body)
            log_sync(device, report)
            bundle = phone_bundle(link.config["serverId"], body.get("known"))
            self.send_json({"report": report, "bundle": bundle}, compress=True)
        else:
            return False
        return True

class Handler(ApiMixin, SimpleHTTPRequestHandler):
    server_version = "Drillbook/2.0"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB_DIR), **kwargs)

    def log_message(self, fmt, *args):  # 保持控制台安静
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def guess_type(self, path):
        # Windows 注册表可能把 .js 映射成 text/plain，导致 ES 模块加载失败，这里显式指定
        return MIME.get(os.path.splitext(str(path))[1].lower()) or super().guess_type(path)

    def list_directory(self, path):
        self.send_error(404)
        return None

    def do_GET(self):
        url = urlparse(self.path)
        if url.path.startswith("/api/"):
            return self.handle_api("GET", url.path)
        if url.path == "/drillbook.apk":
            return self.send_apk()
        return super().do_GET()

    def do_POST(self):
        url = urlparse(self.path)
        if url.path.startswith("/api/"):
            return self.handle_api("POST", url.path)
        self.send_error(405)

    def do_PUT(self):
        url = urlparse(self.path)
        if url.path.startswith("/api/"):
            return self.handle_api("PUT", url.path)
        self.send_error(405)

    def local_host(self) -> bool:
        """请求是否以本机地址访问：别的网站借 DNS 重绑定指向 127.0.0.1 时，Host 是它自己的域名。"""
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0].strip("[]").lower()
        return host in ("", "127.0.0.1", "localhost") or host.endswith(".localhost")

    def handle_phone_admin(self, method: str, parts: list[str]):
        """电脑网页里的「连接手机」：开关、配对码、已配对的手机。"""
        if parts == ["phone"] and method == "GET":
            return self.send_json(link.status())
        if parts == ["phone"] and method == "POST":
            body = self.read_body()
            if not isinstance(body, dict) or not isinstance(body.get("enabled"), bool):
                return self.send_json({"error": "缺少 enabled"}, 400)
            link.set_enabled(body["enabled"])
            if body["enabled"] and link.httpd:
                link.new_code()
            return self.send_json(link.status())
        if parts == ["phone", "code"] and method == "POST":
            link.new_code()
            return self.send_json(link.status())
        if len(parts) == 4 and parts[1] == "devices" and parts[3] == "remove" and method == "POST":
            link.remove_device(parts[2])
            return self.send_json(link.status())
        return self.send_json({"error": "未知接口"}, 404)

    def handle_api(self, method: str, path: str):
        parts = [unquote(p) for p in path.split("/")[2:] if p]
        try:
            # 只接受本机网页的请求：别的网站可以让浏览器向 127.0.0.1 发请求（改笔记、打开手机端口），
            # 但改不了 Host，也发不出带 JSON 请求头的跨站请求（需要预检，本服务不响应）
            if not self.local_host():
                return self.send_json({"error": "只能用 127.0.0.1 或 localhost 访问"}, 403)
            if method in ("POST", "PUT") and not self.is_json():
                return self.send_json({"error": "请求需要 JSON 格式（Content-Type: application/json）"}, 415)

            if parts[:1] == ["phone"]:
                if self.handle_phone(method, parts):
                    return None
                return self.handle_phone_admin(method, parts)

            if method == "GET" and parts == ["topics"]:
                return self.send_json(list_topics())

            if method == "GET" and len(parts) == 2 and parts[0] == "topics":
                tdir = topic_dir(parts[1])
                if not tdir:
                    return self.send_json({"error": "专题不存在"}, 404)
                return self.send_json(load_topic(tdir))

            if len(parts) >= 2 and parts[0] == "records":
                tid = parts[1]
                if not topic_dir(tid):
                    return self.send_json({"error": "专题不存在"}, 404)
                if method == "GET" and len(parts) == 2:
                    recs, skipped = read_records(tid)
                    return self.send_json({"records": recs, "skipped": skipped})
                if method == "POST" and len(parts) == 2:
                    body = self.read_body()
                    saved = append_records(tid, body if isinstance(body, list) else [body])
                    return self.send_json({"saved": saved})
                if method == "POST" and parts[2:] == ["archive"]:
                    return self.send_json({"archived": archive_records(tid)})

            if len(parts) == 3 and parts[0] == "notes":
                tid, page_id = parts[1], parts[2]
                tdir = topic_dir(tid)
                if not tdir:
                    return self.send_json({"error": "专题不存在"}, 404)
                if not ID_RE.match(page_id) or page_id not in page_ids(tdir):
                    return self.send_json({"error": "页面不存在"}, 404)
                if method == "GET":
                    return self.send_json(read_note(tid, page_id))
                if method == "PUT":
                    body = self.read_body()
                    if not isinstance(body, dict) or not isinstance(body.get("content"), str):
                        return self.send_json({"error": "缺少笔记内容 content"}, 400)
                    base = body.get("base") if isinstance(body.get("base"), str) else None
                    status, payload = write_note(tid, page_id, body["content"], base)
                    return self.send_json(payload, status)

            if len(parts) == 3 and parts[0] == "knowledge":
                tid, page_id = parts[1], parts[2]
                tdir = topic_dir(tid)
                if not tdir:
                    return self.send_json({"error": "专题不存在"}, 404)
                pdir = page_dir_of(tdir, page_id) if ID_RE.match(page_id) else None
                if not pdir:
                    return self.send_json({"error": "页面不存在"}, 404)
                if method == "GET":
                    return self.send_json(read_knowledge(tid, pdir))
                if method == "PUT":
                    body = self.read_body()
                    if not isinstance(body, dict) or not isinstance(body.get("content"), str):
                        return self.send_json({"error": "缺少文件内容 content"}, 400)
                    if not body["content"].strip():
                        return self.send_json({"error": "内容不能为空；要删除页面请直接删除文件夹"}, 400)
                    base = body.get("base") if isinstance(body.get("base"), str) else None
                    status, payload = write_knowledge(pdir, body["content"], base)
                    return self.send_json(payload, status)

            return self.send_json({"error": "未知接口"}, 404)
        except Exception as e:  # 返回错误信息，方便在页面上看到原因
            traceback.print_exc()
            return self.send_json({"error": f"{type(e).__name__}: {e}"}, 500)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    # Windows 上 SO_REUSEADDR 会允许两个进程抢同一个端口，必须关闭
    allow_reuse_address = os.name != "nt"


class PhoneHandler(ApiMixin, BaseHTTPRequestHandler):
    """手机连接用的局域网端口：只提供手机接口和 App 安装包。"""

    server_version = "Drillbook/2.0"
    timeout = 15  # 空闲或很慢的连接不长期占着线程

    def log_message(self, fmt, *args):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def ip_host(self) -> bool:
        """只接受以 IP 地址访问：别的网站借 DNS 重绑定指向这台电脑时，Host 是它自己的域名。"""
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0].strip("[]")
        if not host or host.lower() == "localhost":
            return True
        try:
            ipaddress.ip_address(host)
            return True
        except ValueError:
            return False

    def route(self, method: str):
        path = urlparse(self.path).path
        try:
            if not self.ip_host():
                return self.send_json({"error": "请用 IP 地址访问"}, 403)
            if method == "GET" and path == "/drillbook.apk":
                return self.send_apk()
            parts = [unquote(p) for p in path.split("/")[2:] if p] if path.startswith("/api/") else []
            if not (parts and self.handle_phone(method, parts)):
                self.send_json({"error": "未知接口"}, 404)
        except Exception as e:
            traceback.print_exc()
            self.send_json({"error": f"{type(e).__name__}: {e}"}, 500)

    def do_GET(self):
        self.route("GET")

    def do_POST(self):
        self.route("POST")


class PhoneServer(Server):
    pass


def make_server(port: int) -> tuple[Server, int]:
    for p in range(port, port + 20):
        try:
            return Server(("127.0.0.1", p), Handler), p
        except OSError:
            continue
    sys.exit(f"端口 {port}-{port + 19} 都被占用了，请用 --port 指定其他端口")


def run_check() -> int:
    dirs = [d for d in visible_dirs(TOPICS_DIR) if ID_RE.match(d.name)]
    if not dirs:
        print(f"{TOPICS_REL}/ 下还没有专题。")
        return 0
    errors = 0
    for d in sorted(dirs):
        p = load_topic(d)
        n_points = sum(len(pg["points"]) for pg in p["pages"])
        n_q = sum(len(pg["questions"]) for pg in p["pages"])
        print(f"[{p['id']}] {p['name']}：{len(p['pages'])} 页，{n_points} 个知识点，{n_q} 道题")
        if not p["issues"]:
            print("  没有发现问题")
        for it in p["issues"]:
            tag = "错误" if it["level"] == "error" else "提示"
            errors += it["level"] == "error"
            print(f"  {tag}  {it['where']}：{it['msg']}")
    return 1 if errors else 0


def run_outline() -> int:
    """打印已有内容的结构，供人或 agent 判断新来源与已有专题的重叠、检查覆盖情况。"""
    dirs = [d for d in visible_dirs(TOPICS_DIR) if ID_RE.match(d.name)]
    if not dirs:
        print(f"{TOPICS_REL}/ 下还没有专题。")
        return 0
    topics = sorted((load_topic(d) for d in dirs), key=lambda p: (p["order"], p["name"]))
    for p in topics:
        n_points = sum(len(pg["points"]) for pg in p["pages"])
        n_q = sum(len(pg["questions"]) for pg in p["pages"])
        tags = " · ".join(x for x in (KIND_LABEL.get(p["kind"], p["kind"]), p["origin"]) if x)
        tags = f"（{tags}）" if tags else ""
        print(f"[{p['id']}] {p['name']}{tags}  {len(p['pages'])} 页 / {n_points} 个知识点 / {n_q} 道题  order={p['order']}")
        if p["description"]:
            print(f"  说明：{p['description']}")
        print(f"  来源：{p['path']}/{p['sourceFile']}" if p["source"] else "  来源：无")
        for pg in p["pages"]:
            counts: dict[str, int] = {}
            for q in pg["questions"]:
                for ref in q["points"]:
                    counts[ref] = counts.get(ref, 0) + 1
            print(f"  {pg['dir']}  {pg['title']}  ({len(pg['questions'])} 题)")
            for pt in pg["points"]:
                print(f"    - {pt['id']}  {pt['title']}  [{counts.get(pt['id'], 0)} 题]")
        if p["issues"]:
            print(f"  另有 {len(p['issues'])} 项格式问题，运行 --check 查看")
        print()
    return 0


def main() -> None:
    ap = argparse.ArgumentParser(description="Drillbook 本地服务")
    ap.add_argument("--port", type=int, default=8765, help="端口，默认 8765")
    ap.add_argument("--no-browser", action="store_true", help="不自动打开浏览器")
    ap.add_argument("--check", action="store_true", help="只检查题库格式")
    ap.add_argument("--outline", action="store_true", help="列出所有专题、页面和知识点")
    args = ap.parse_args()

    if args.check:
        sys.exit(run_check())
    if args.outline:
        sys.exit(run_outline())

    TOPICS_DIR.mkdir(parents=True, exist_ok=True)
    RECORDS_DIR.mkdir(parents=True, exist_ok=True)
    httpd, port = make_server(args.port)
    url = f"http://127.0.0.1:{port}/"
    print(f"Drillbook 已启动：{url}")
    print(f"题库目录：{TOPICS_DIR}")
    print(f"作答记录：{RECORDS_DIR}")
    if link.config["enabled"]:
        if link.start():
            where = "、".join(f"{ip}:{link.port}" for ip in lan_addresses()) or f"本机局域网地址:{link.port}"
            print(f"手机连接：已开启，手机上填 {where}")
        else:
            print(f"手机连接：没能开启（{link.error}）")
    print("关闭此窗口或按 Ctrl+C 停止服务。")
    if not args.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        link.stop()
        httpd.server_close()


if __name__ == "__main__":
    main()
