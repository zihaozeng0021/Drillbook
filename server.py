#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Drillbook · local server (Python standard library only, nothing to install)

Usage:
  python server.py               start the server and open the browser
  python server.py --port 9000   use another port (default 8765; moves to the next one if taken)
  python server.py --no-browser  don't open the browser
  python server.py --check       only check the topic files and print the problems; don't start the server
  python server.py --outline     list all topics → pages → knowledge points (with question counts per point); don't start the server

Layout (data formats: see AGENTS.md):
  web/                         front end
  data/topics/<topic>/         topic folder: topic.json, source.md, mindmap.md (mind map, optional), pages/<NN-page>/{knowledge.md, questions.json}
                               (the old names data/positions/, position.json and jd.md still work)
  data/records/<topic>.jsonl   answer records (one answer per line, appended automatically)
  data/notes/<topic>/<page>.md page notes (edited and autosaved in the web page; can also be opened in any editor)
  data/topics/<topic>/pages/<page>/_history/  old versions kept automatically when knowledge.md is edited in the web page (ignored when loading)
  .local/                      local config (not in git): the phone connection switch and paired phones, the Android app signing key
  android/                     Android app (phone version): build with python android/build.py, output android/build/drillbook.apk
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
    sys.exit("Python 3.8 or later is required")

try:  # Windows console: replace characters it can't encode (e.g. Chinese titles and notes) instead of crashing
    sys.stdout.reconfigure(errors="replace")
    sys.stderr.reconfigure(errors="replace")
except Exception:
    pass

ROOT = Path(__file__).resolve().parent
WEB_DIR = ROOT / "web"
DATA_DIR = ROOT / "data"
TOPICS_DIR = DATA_DIR / "topics"
if not TOPICS_DIR.is_dir() and (DATA_DIR / "positions").is_dir():
    TOPICS_DIR = DATA_DIR / "positions"  # old directory name, still supported
TOPICS_REL = TOPICS_DIR.relative_to(ROOT).as_posix()
META_FILES = ("topic.json", "position.json")  # topic metadata; the second is the old name
SOURCE_FILES = ("source.md", "jd.md")         # source text (JD, table of contents, syllabus); the second is the old name
MINDMAP_FILE = "mindmap.md"                   # mind map (optional)
KIND_LABEL = {"job": "Job", "book": "Book", "course": "Course", "exam": "Exam"}
RECORDS_DIR = DATA_DIR / "records"
ARCHIVE_DIR = RECORDS_DIR / "archive"
NOTES_DIR = DATA_DIR / "notes"
NOTE_HISTORY_KEEP = 30     # old versions kept per page for notes / knowledge files
NOTE_SNAPSHOT_GAP = 600    # during continuous editing, keep at most one old version per this many seconds
LOCAL_DIR = ROOT / ".local"             # local config, not in git
PHONE_FILE = LOCAL_DIR / "phone.json"   # phone connection: switch, port, paired phones
APK_FILE = ROOT / "android" / "build" / "drillbook.apk"
PHONE_PORT = 8766          # LAN port for phone connections (moves to the next one if taken)
PAIR_TTL = 600             # pairing code lifetime (seconds)
PAIR_MAX_TRIES = 5         # a pairing code is voided after this many wrong tries
PAIR_FAIL_LIMIT = 20       # this many wrong pairing codes in total within 10 minutes pauses pairing (a new code doesn't reset it)
PAIR_FAIL_WINDOW = 600
NONCE_TTL = 120            # lifetime (seconds) of the one-time nonces for signed phone requests
NONCE_MAX = 64             # max number of nonces valid at the same time
LAN_NETS = tuple(ipaddress.ip_network(n) for n in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))

ID_RE = re.compile(r"^[\w-]+$")                      # topic / page / knowledge point / question id
TITLE_RE = re.compile(r"^#\s+(.+?)\s*$")              # first line of knowledge.md: # Page title
POINT_RE = re.compile(r"^##\s+(.+?)\s*(?:\{#([\w-]+)\})?\s*$")  # ## Knowledge point title {#id}
FENCE_RE = re.compile(r"^\s*(```|~~~)")
PAGE_DIR_RE = re.compile(r"^(\d+)[-_ ]+(.+)$")         # 01-rag -> (1, "rag")
MM_ITEM_RE = re.compile(r"^(\s*)(?:[-*+]|\d+[.)])\s+(.*?)\s*$")       # one mindmap.md node: - text
MM_REF_RE = re.compile(r"\s*\{\s*([\w-]*)\s*(?:#\s*([\w-]+))?\s*\}$")  # at the end of a line: {page-id} / {page-id#point-id} / {#point-id}
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


# ───────────────────────────── Loading and checking topic files ─────────────────────────────

class Issues:
    def __init__(self) -> None:
        self.items: list[dict] = []

    def error(self, where: str, msg: str) -> None:
        self.items.append({"level": "error", "where": where, "msg": msg})

    def warn(self, where: str, msg: str) -> None:
        self.items.append({"level": "warn", "where": where, "msg": msg})


def plural(n: int, one: str, many: str | None = None) -> str:
    """A count with its noun: 1 question, 2 questions."""
    return f"{n} {one if n == 1 else many or one + 's'}"


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8-sig")  # also accepts UTF-8 with a BOM (as saved by Notepad)


def read_json(path: Path):
    return json.loads(read_text(path))


def visible_dirs(parent: Path) -> list[Path]:
    """Subfolders; names starting with . or _ are hidden or drafts and are not loaded."""
    if not parent.is_dir():
        return []
    return [d for d in parent.iterdir() if d.is_dir() and not d.name.startswith((".", "_"))]


def parse_knowledge(text: str, where: str, issues: Issues) -> tuple[str | None, str, list[dict]]:
    """Split knowledge.md into the page title, the intro and the knowledge points (each ## heading starts one)."""
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
            issues.warn(where, f"Knowledge point \"{p['title']}\" has no id; write {{#english-id}} after the title, otherwise questions can't link to it reliably")
        if pid in seen:
            issues.error(where, f"Duplicate knowledge point id: {pid}")
            continue
        seen.add(pid)
        out.append({"id": pid, "title": p["title"], "content": "\n".join(p["lines"]).strip()})

    if title is None:
        issues.error(where, "The first line must be the page title: # Title")
    if not out:
        issues.warn(where, "No knowledge points (start one with ## Title {#id})")
    return title, "\n".join(intro).strip(), out


def normalize_answer(answer) -> str:
    if isinstance(answer, list):
        answer = "".join(str(a) for a in answer)
    if not isinstance(answer, str):
        return ""
    # Separators between letters are dropped; the class keeps the Chinese commas because old question files use them
    return "".join(sorted(set(re.sub(r"[\s,，、/]", "", answer.upper()))))


def load_questions(path: Path, page_id: str, dir_name: str, points: list[dict], issues: Issues) -> list[dict]:
    where = f"{dir_name}/questions.json"
    if not path.exists():
        issues.warn(where, "Missing questions.json")
        return []
    try:
        data = read_json(path)
    except json.JSONDecodeError as e:
        issues.error(where, f"Invalid JSON at line {e.lineno}, column {e.colno}: {e.msg}")
        return []
    if isinstance(data, dict) and isinstance(data.get("questions"), list):
        data = data["questions"]
    if not isinstance(data, list):
        issues.error(where, "The content must be an array of questions [ {...}, {...} ]")
        return []

    point_ids = {p["id"] for p in points}
    seen: set[str] = set()
    out = []
    for i, q in enumerate(data, 1):
        qw = f"{where} question {i}"
        if not isinstance(q, dict):
            issues.error(qw, "A question must be an object {...}")
            continue
        qid = str(q.get("id") or "").strip()
        if not qid:
            issues.error(qw, "Missing id")
            continue
        qw = f"{where}#{qid}"
        if not ID_RE.match(qid):
            issues.error(qw, "The id may only contain letters, digits, underscores and hyphens")
            continue
        if qid in seen:
            issues.error(qw, "Duplicate id")
            continue
        seen.add(qid)

        stem = q.get("stem")
        options = q.get("options")
        if not isinstance(stem, str) or not stem.strip():
            issues.error(qw, "Missing stem")
            continue
        if not isinstance(options, list) or len(options) < 2 or not all(isinstance(o, str) and o.strip() for o in options):
            issues.error(qw, "options needs at least 2 non-empty strings")
            continue
        if len(options) > len(LETTERS):
            issues.error(qw, f"At most {len(LETTERS)} options are allowed")
            continue
        if len({o.strip() for o in options}) != len(options):
            issues.warn(qw, "Duplicate options")

        answer = normalize_answer(q.get("answer"))
        valid = LETTERS[: len(options)]
        if not answer or any(c not in valid for c in answer):
            issues.error(qw, f"Answer {q.get('answer')!r} is outside the option range A-{valid[-1]}")
            continue
        qtype = q.get("type") or ("multi" if len(answer) > 1 else "single")
        if qtype not in ("single", "multi"):
            issues.error(qw, "type must be single or multi")
            continue
        if qtype == "single" and len(answer) > 1:
            issues.error(qw, "A single-answer question can only have one answer")
            continue

        refs = q.get("points") or []
        if isinstance(refs, str):
            refs = [refs]
        refs = [str(r) for r in refs]
        missing = [r for r in refs if r not in point_ids]
        if missing:
            issues.warn(qw, f"Linked knowledge point{'s' if len(missing) > 1 else ''} not found: {', '.join(missing)}")
        refs = [r for r in refs if r in point_ids]
        if not refs:
            issues.warn(qw, "Not linked to any knowledge point (points)")

        explanation = str(q.get("explanation") or "").strip()
        if not explanation:
            issues.warn(qw, "Missing explanation")

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
            issues.warn(where, f"Knowledge point \"{p['title']}\" has no questions yet")
    return out


def page_sort_key(d: Path):
    m = PAGE_DIR_RE.match(d.name)
    return (int(m.group(1)) if m else 10**9, d.name)


def load_page(page_dir: Path, issues: Issues) -> dict:
    m = PAGE_DIR_RE.match(page_dir.name)
    index, page_id = (int(m.group(1)), m.group(2)) if m else (None, page_dir.name)
    where = page_dir.name
    if not ID_RE.match(page_id):
        issues.error(where, "Page folder names may only contain letters, digits, underscores and hyphens, e.g. 01-rag")

    kfile = page_dir / "knowledge.md"
    if kfile.exists():
        title, intro, points = parse_knowledge(read_text(kfile), f"{where}/knowledge.md", issues)
    else:
        issues.warn(where, "Missing knowledge.md")
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


def parse_mindmap(text: str, root_title: str, pages: list[dict], issues: Issues) -> dict | None:
    """Parse mindmap.md into a tree: {text, page?, point?, children?}.
    · The first line may be # Title (the root text; defaults to the topic name); every other line is one list item "- text", indented to nest
    · {page-id}, {page-id#point-id} or {#point-id} at the end of a line links the node to a page or knowledge point; {#point-id} belongs to the nearest parent page
    · A linked node without its own text shows the title of the page or knowledge point
    · Every knowledge point should appear in the map exactly once: missing and repeated ones get a warning"""
    by_page = {pg["id"]: pg for pg in pages}
    root: dict = {"text": root_title}
    stack: list[tuple[int, dict, str | None]] = [(-1, root, None)]  # (indent, node, owning page)
    used: dict[tuple[str, str], int] = {}
    items = 0
    titled = False
    for n, raw in enumerate(text.splitlines(), 1):
        line = raw.expandtabs(4).rstrip()
        if not line.strip():
            continue
        where = f"{MINDMAP_FILE} line {n}"
        if not items and not titled:
            m = TITLE_RE.match(line)
            if m:
                root["text"], titled = m.group(1), True
                continue
        m = MM_ITEM_RE.match(line)
        if not m:
            issues.warn(where, 'Not a list item; ignored (write each node as one line "- text" and indent to nest)')
            continue
        items += 1
        indent, body = len(m.group(1)), m.group(2)
        while stack[-1][0] >= indent:
            stack.pop()
        parent, ctx = stack[-1][1], stack[-1][2]
        node: dict = {}
        ref = MM_REF_RE.search(body)
        if ref and (ref.group(1) or ref.group(2)):
            label, page_id, point_id = body[: ref.start()].strip(), ref.group(1) or ctx, ref.group(2)
            pg = by_page.get(page_id) if page_id else None
            fallback = ref.group(0).strip()
            if not page_id:
                issues.warn(where, f"{fallback} has no page: put it under a page node, or write {{page-id#{point_id}}}")
            elif not pg:
                issues.warn(where, f"Page \"{page_id}\" does not exist")
            elif point_id is None:
                node["page"], fallback = page_id, pg["title"]
            else:
                pt = next((p for p in pg["points"] if p["id"] == point_id), None)
                if pt:
                    node["page"], node["point"], fallback = page_id, point_id, pt["title"]
                    used[(page_id, point_id)] = used.get((page_id, point_id), 0) + 1
                else:
                    issues.warn(where, f"Page \"{pg['title']}\" has no knowledge point \"{point_id}\"")
            node = {"text": label or fallback, **node}
        else:
            node = {"text": body}
        parent.setdefault("children", []).append(node)
        stack.append((indent, node, node.get("page") or ctx))

    if not items:
        issues.warn(MINDMAP_FILE, 'The mind map is empty (write each node as one line "- text" and indent to nest)')
        return None
    for pg in pages:
        for pt in pg["points"]:
            times = used.get((pg["id"], pt["id"]), 0)
            if not times:
                issues.warn(MINDMAP_FILE, f"Knowledge point \"{pg['title']} / {pt['title']}\" is missing from the mind map")
            elif times > 1:
                issues.warn(MINDMAP_FILE, f"Knowledge point \"{pg['title']} / {pt['title']}\" appears {times} times in the mind map")
    return root


def count_nodes(node: dict | None) -> int:
    return 1 + sum(count_nodes(c) for c in node.get("children", [])) if node else 0


def topic_dir(tid: str) -> Path | None:
    if not tid or not ID_RE.match(tid) or tid.startswith(("_", ".")):
        return None
    d = TOPICS_DIR / tid
    return d if d.is_dir() else None


def first_existing(parent: Path, names: tuple) -> Path | None:
    """The first of names that exists as a file: the new name comes first, old names are the fallback."""
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
            issues.error(mfile.name, f"Invalid JSON at line {e.lineno}, column {e.colno}: {e.msg}")
        if not isinstance(meta, dict):
            issues.error(mfile.name, "The content must be an object {...}")
            meta = {}
    else:
        issues.warn("topic.json", "Missing topic.json; using the folder name as the topic name for now")

    sfile = first_existing(tdir, SOURCE_FILES)
    source = read_text(sfile).strip() if sfile else None

    pages = []
    seen: set[str] = set()
    for d in sorted(visible_dirs(tdir / "pages"), key=page_sort_key):
        page = load_page(d, issues)
        if page["id"] in seen:
            issues.error(d.name, f"Duplicate page id: {page['id']}")
            continue
        seen.add(page["id"])
        pages.append(page)
    if not pages:
        issues.warn("pages", "No pages yet (create a folder such as 01-xxx under pages/)")

    mfile = tdir / MINDMAP_FILE
    name = str(meta.get("name") or tdir.name)
    mindmap = parse_mindmap(read_text(mfile), name, pages, issues) if mfile.is_file() else None

    for page in pages:
        nf = note_file(tdir.name, page["id"])
        page["noteSize"] = nf.stat().st_size if nf.is_file() else 0
    note_dir = NOTES_DIR / tdir.name
    if note_dir.is_dir():
        ids = {p["id"] for p in pages}
        for f in sorted(note_dir.glob("*.md")):
            if f.stem not in ids:
                issues.warn(f"data/notes/{tdir.name}/{f.name}", "This note has no matching page (if the page id changed, rename the file to the new page id)")

    return {
        "id": tdir.name,
        "name": name,
        "kind": str(meta.get("kind") or "").strip(),
        "origin": str(meta.get("origin") or meta.get("company") or ""),  # company is the old field name
        "description": str(meta.get("description") or ""),
        "order": meta.get("order") if isinstance(meta.get("order"), (int, float)) else 0,
        "source": source,
        "sourceFile": sfile.name if sfile else None,
        "path": f"{TOPICS_REL}/{tdir.name}",
        "pages": pages,
        "mindmap": mindmap,
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


# ───────────────────────────── Topic order ─────────────────────────────
#
# The topic list is sorted by the order in topic.json (smaller first, ties by name). After topics are dragged in the web
# page, each topic's order is rewritten as 1, 2, 3… in the new order (only files whose value changed are written). An order
# dragged on the phone is merged during sync, see merge_phone_order

meta_lock = threading.RLock()


def merge_order(current: list[str], wanted) -> list[str]:
    """Reorder current by wanted: the topics named in wanted fill, in wanted's order, the positions they held in current;
    topics not named (e.g. created after the web page was opened) keep their place, and topics that no longer exist are ignored."""
    have = set(current)
    picked: list[str] = []
    seen: set[str] = set()
    for tid in wanted if isinstance(wanted, list) else []:
        if isinstance(tid, str) and tid in have and tid not in seen:
            seen.add(tid)
            picked.append(tid)
    it = iter(picked)
    return [next(it) if tid in seen else tid for tid in current]


def same_relative_order(a: list, b: list) -> bool:
    """Whether the topics the two orders share come in the same sequence (topics merely added or removed don't count as a reorder)."""
    a = [t for t in a if isinstance(t, str)]
    b = [t for t in b if isinstance(t, str)]
    common = set(a) & set(b)
    return [t for t in a if t in common] == [t for t in b if t in common]


def write_topic_order(wanted) -> int:
    """Reorder the topics by wanted (a list of topic ids) and write the new order into each topic's topic.json. Returns how many
    files were rewritten. If any topic.json can't be read, nothing is changed and ValueError is raised."""
    with meta_lock:
        current = [p["id"] for p in list_topics()]
        plan = []
        for i, tid in enumerate(merge_order(current, wanted), 1):
            tdir = TOPICS_DIR / tid
            mfile = first_existing(tdir, META_FILES)
            meta = {}
            if mfile:
                try:
                    meta = read_json(mfile)
                except ValueError:
                    meta = None
                if not isinstance(meta, dict):
                    raise ValueError(f"{TOPICS_REL}/{tid}/{mfile.name} is malformed; fix it before changing the order")
            if type(meta.get("order")) is int and meta["order"] == i:
                continue
            meta["order"] = i
            plan.append((mfile or tdir / "topic.json", meta))
        for path, meta in plan:
            tmp = path.with_name(path.name + ".tmp")
            with open(tmp, "wb") as f:
                f.write((json.dumps(meta, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, path)
    return len(plan)


def topic_order_time() -> int:
    """When the topic order on the computer may last have changed (ms): the latest modification time of any topic.json."""
    latest = 0.0
    for d in visible_dirs(TOPICS_DIR):
        f = first_existing(d, META_FILES) if ID_RE.match(d.name) else None
        if f:
            latest = max(latest, f.stat().st_mtime)
    return int(latest * 1000)


def merge_phone_order(order: dict) -> dict:
    """Merge a topic order dragged on the phone. base is the computer's order at the phone's last sync:
    · the computer's order matches base → the computer hasn't changed it: use the phone's
    · it doesn't → both sides changed it: use the later change (on the computer, judged by topic.json modification times)"""
    with meta_lock:
        current = [p["id"] for p in list_topics()]
        base = order.get("base") if isinstance(order.get("base"), list) else []
        pc_changed = not same_relative_order(current, base)
        at = order.get("at")
        if pc_changed and not (isinstance(at, (int, float)) and at > topic_order_time()):
            return {"kept": "pc", "conflict": True}
        try:
            changed = write_topic_order(order.get("ids"))
        except (OSError, ValueError) as e:
            return {"kept": "pc", "error": str(e)}
    return {"kept": "phone", "conflict": pc_changed, "changed": changed}


# ───────────────────────────── Answer records ─────────────────────────────

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
    """Each topic's latest reset time (ms). Answer records before it no longer count; phone sync cleans up both sides by it."""
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
    """Reset = move the records file to data/records/archive/ instead of deleting it, and note the reset time (phone sync cleans up by it)."""
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
    """The topic was reset on the phone: move records older than the reset time to archive/ and keep the later ones.
    Returns how many records were moved; the caller must hold records_lock."""
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


# ───────────────────────────── Page notes ─────────────────────────────

def page_ids(tdir: Path) -> set[str]:
    ids = set()
    for d in visible_dirs(tdir / "pages"):
        m = PAGE_DIR_RE.match(d.name)
        ids.add(m.group(2) if m else d.name)
    return ids


def note_file(tid: str, page_id: str) -> Path:
    return NOTES_DIR / tid / f"{page_id}.md"


def digest(raw: bytes) -> str:
    """Content fingerprint: the web page sends it back when saving, so changes made to the file elsewhere are detected."""
    return hashlib.sha256(raw).hexdigest()[:16] if raw else ""


def decode_note(raw: bytes) -> str:
    return raw.decode("utf-8-sig", errors="replace").replace("\r\n", "\n")


def read_note(tid: str, page_id: str) -> dict:
    path = note_file(tid, page_id)
    with notes_lock:
        raw = path.read_bytes() if path.is_file() else b""
    return {"content": decode_note(raw), "hash": digest(raw), "size": len(raw), "path": f"data/notes/{tid}/{page_id}.md"}


def snapshot(hdir: Path, old_raw: bytes, new_size: int) -> None:
    """Save the old content to hdir before it is overwritten: at most one copy per 10 minutes of continuous editing,
    but always when the content suddenly shrinks by more than half (e.g. an accidental delete)."""
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
            return 409, {"error": "The note file was changed elsewhere", "content": decode_note(old_raw), "hash": current}
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
        os.replace(tmp, path)  # atomic replace: a power cut while saving never leaves half a file
        return 200, {"hash": digest(new_raw), "size": len(new_raw)}


# ───────────────────────────── Editing knowledge files ─────────────────────────────

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
    """Parse right after saving: format problems, plus knowledge point ids that were deleted or renamed but are still linked."""
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
                issues.error(where, f"Knowledge point id \"{pid}\" was deleted or renamed, but it is still linked from {plural(refs[pid], 'question')} on this page")
            else:
                issues.warn(where, f"Knowledge point id \"{pid}\" was deleted or renamed; links to it within the site will stop working")
    return issues.items


def write_knowledge(page_dir: Path, content: str, base: str | None) -> tuple[int, dict]:
    path = page_dir / "knowledge.md"
    new_raw = content.replace("\r\n", "\n").encode("utf-8")
    with knowledge_lock:
        old_raw = path.read_bytes() if path.is_file() else b""
        current = digest(old_raw)
        if base is not None and base != current:
            return 409, {"error": "knowledge.md was changed elsewhere", "content": decode_note(old_raw), "hash": current}
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


# ───────────────────────────── Phone connection ─────────────────────────────
#
# The Android app (android/) carries its own copy of the site code, runs offline and syncs both ways with this computer over the LAN.
# · Off by default. Turning it on under "Connect phone" in the computer's web page opens an extra LAN port (default 8766);
#   that port serves only the phone endpoints below and the app package, not the web page or the other endpoints
# · The first connection needs the 6-digit pairing code shown in the computer's web page (valid for 10 minutes, void after
#   5 wrong tries); the phone gets a long-lived token. After that the token never crosses the network: sync requests are
#   signed with it (see PhoneLink.verify). The computer keeps only the token's sha256
# · Sync rules: see apply_phone_sync / merge_phone_note; each topic's reset time is kept in data/records/resets.json
# · The switch, the port and the paired phones are saved in .local/phone.json (not in git)

def lan_addresses() -> list[str]:
    """This computer's IPv4 addresses on the LAN, the default outgoing interface first."""
    found: list[str] = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("192.0.2.1", 9))  # a UDP connect sends no packet; it only finds the outgoing interface
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
        # Home / LAN ranges only (the same ones the app may connect to); virtual adapters of proxy software (e.g. 198.18.x) don't count
        if any(addr in net for net in LAN_NETS) and ip not in out:
            out.append(ip)
    return out


def topic_fingerprint(p: dict) -> str:
    """Fingerprint of a topic's content (without noteSize, which changes with the notes): not sent again if the phone already has it."""
    pages = [{k: v for k, v in pg.items() if k != "noteSize"} for pg in p["pages"]]
    return digest(json.dumps(dict(p, pages=pages), ensure_ascii=False, sort_keys=True).encode("utf-8"))


def phone_bundle(server_id: str, known=None) -> dict:
    """All of the computer's data that the phone receives: topics (parsed), answer records, notes, reset times.
    known holds the fingerprints the phone already has {topic: fingerprint}; for unchanged topics only records and notes are sent."""
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
    """A note changed on both sides: the copy that wasn't used goes into _history/<page>/, named with -phone (the phone's) or -pc (the computer's)."""
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
    """Merge one note changed on the phone. base is the fingerprint of the computer's copy at the phone's last sync:
    · equal to the computer's current fingerprint → the computer hasn't changed it: use the phone's
    · different → both sides changed it: use the one changed later and save the other separately, so nothing is lost"""
    content = content.replace("\r\n", "\n")
    mine = content.encode("utf-8") if content.strip() else b""
    path = note_file(tid, page_id)
    with notes_lock:
        raw = path.read_bytes() if path.is_file() else b""
        mtime = int(path.stat().st_mtime * 1000) if raw else 0
    current = digest(raw)
    if digest(mine) == current:
        return None  # both sides are already the same
    info = {"tid": tid, "pageId": page_id}
    if not page_exists:  # the page no longer exists on the computer: save the phone's copy separately
        return dict(info, conflict=True, kept="pc", saved=save_note_copy(tid, page_id, mine, "phone"))
    pc_changed = base != current
    if pc_changed and not (isinstance(updated_at, (int, float)) and updated_at > mtime):
        return dict(info, conflict=True, kept="pc", saved=save_note_copy(tid, page_id, mine, "phone"))
    saved = save_note_copy(tid, page_id, raw, "pc") if pc_changed else None
    status, _ = write_note(tid, page_id, content, current)
    if status != 200:  # changed on the computer at this very moment: leave it and merge at the next sync
        return dict(info, retry=True)
    return dict(info, conflict=True, kept="phone", saved=saved) if pc_changed else dict(info, kept="phone")


def apply_phone_sync(body: dict) -> dict:
    """Merge the phone's changes into the computer: resets, answer records, notes, topic order. Returns the merge report.
    · The later reset of the two sides wins; if the phone's is later, older records on the computer move to data/records/archive/
    · Answer records from both sides are combined, same time + same question counting as one; records before the reset time are dropped
    · Notes: see merge_phone_note; topic order: see merge_phone_order"""
    report: dict = {"records": 0, "notes": [], "conflicts": [], "resets": [], "order": None}
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

    order = body.get("order")
    if isinstance(order, dict) and isinstance(order.get("ids"), list):
        report["order"] = merge_phone_order(order)
    return report


def log_sync(device: dict, report: dict) -> None:
    parts = []
    if report["records"]:
        parts.append(plural(report["records"], "answer record"))
    if report["notes"]:
        parts.append(plural(len(report["notes"]), "note"))
    if report["resets"]:
        parts.append("reset (" + ", ".join(r["tid"] for r in report["resets"]) + ")")
    order = report.get("order") or {}
    if order.get("changed"):
        parts.append("topic order")
    if parts:
        print(f"Phone sync ({device.get('name')}): received " + ", ".join(parts), flush=True)
    for c in report["conflicts"]:
        kept = "phone" if c.get("kept") == "phone" else "computer"
        where = f"; the other copy is in {c['saved']}" if c.get("saved") else ""
        print(f"  Note {c['tid']}/{c['pageId']} was changed on both sides: kept the {kept}'s version{where}", flush=True)
    if order.get("conflict"):
        print(f"  Topic order was changed on both sides: kept the {'phone' if order.get('kept') == 'phone' else 'computer'}'s order", flush=True)
    if order.get("error"):
        print(f"  Couldn't write the topic order from the phone: {order['error']}", flush=True)


class PhoneLink:
    """Phone connection state: pairing code, paired phones, and the switch for the LAN port."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.httpd: ThreadingHTTPServer | None = None
        self.port: int | None = None
        self.error = ""
        self.pairing: dict | None = None  # {"code", "expires", "tries"}
        self.failures: list[float] = []   # times of recent wrong pairing codes
        self.nonces: dict[str, float] = {}  # one-time nonces for signed requests → expiry time
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
                self.error = f"Ports {base}-{base + 9} are all in use"
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
                return 429, {"error": "Too many wrong pairing codes; try again in 10 minutes"}
            p = self.pairing
            if not p or p["expires"] < now:
                self.pairing = None
                return 403, {"error": "The pairing code has expired: get a new one under \"Connect phone\" on the computer"}
            if not isinstance(code, str) or not hmac.compare_digest(re.sub(r"\s", "", code).encode(), p["code"].encode()):
                self.failures.append(now)
                p["tries"] += 1
                if p["tries"] >= PAIR_MAX_TRIES:
                    self.pairing = None
                    return 403, {"error": "Too many wrong tries, so this pairing code is void: get a new one on the computer"}
                return 403, {"error": "Wrong pairing code"}
            token = secrets.token_hex(32)
            now = int(time.time() * 1000)
            device = {
                "id": secrets.token_hex(4),
                "name": name.strip()[:40] if isinstance(name, str) and name.strip() else "Phone",
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
        """Verify a phone's signed request and return that phone. After pairing the token never crosses the network: the phone
        uses sha256(token) as the key for an HMAC over "method, path, one-time nonce, body hash"; a nonce works only once, so a
        captured request can't be replayed."""
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


# ───────────────────────────── HTTP server ─────────────────────────────

class ApiMixin:
    """Shared by the server for the computer's web page and the LAN port for phones: JSON in and out, phone endpoints, the app package."""

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
        if length < 0 or length > 5_000_000:  # a negative length would make read() wait until the connection closes
            raise ValueError("Invalid request body length")
        return self.rfile.read(length) if length else b""

    def read_body(self):
        return json.loads(self.read_raw().decode("utf-8") or "null")

    def is_json(self) -> bool:
        """Writes require a JSON Content-Type: other sites can only send "simple requests" (text/plain, forms), which can't carry it."""
        return (self.headers.get("Content-Type") or "").lower().startswith("application/json")

    def send_apk(self):
        if not APK_FILE.is_file():
            return self.send_json({"error": "The app hasn't been built yet: run python android/build.py in the project folder"}, 404)
        data = APK_FILE.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "application/vnd.android.package-archive")
        self.send_header("Content-Disposition", 'attachment; filename="drillbook.apk"')
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def handle_phone(self, method: str, parts: list[str]) -> bool:
        """The phone endpoints (served by both servers). Returns False for any other endpoint."""
        if method == "GET" and parts == ["phone", "hello"]:
            self.send_json({"app": "drillbook", "serverId": link.config["serverId"], "name": socket.gethostname()})
        elif method == "POST" and parts == ["phone", "pair"]:
            if not self.is_json():
                self.send_json({"error": "The request must be JSON"}, 415)
                return True
            body = self.read_body()
            body = body if isinstance(body, dict) else {}
            status, payload = link.pair(body.get("code"), body.get("name"))
            self.send_json(payload, status)
        elif method == "GET" and parts == ["phone", "nonce"]:
            self.send_json({"nonce": link.new_nonce()})
        elif method == "POST" and parts == ["phone", "sync"]:
            # Sync: first merge the phone's changes into the computer, then send all the merged data back to the phone
            if not self.is_json():
                self.send_json({"error": "The request must be JSON"}, 415)
                return True
            raw = self.read_raw()
            device = link.verify(self.headers, method, "/api/phone/sync", raw)
            if not device:
                self.send_json({"error": "This phone needs to be paired again (it may have been removed on the computer)"}, 401)
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

    def log_message(self, fmt, *args):  # keep the console quiet
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def guess_type(self, path):
        # The Windows registry may map .js to text/plain, which breaks loading ES modules, so the types are set explicitly here
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
        """Whether the request addresses this machine by a local name: when another site points at 127.0.0.1 through DNS rebinding, Host is its own domain."""
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0].strip("[]").lower()
        return host in ("", "127.0.0.1", "localhost") or host.endswith(".localhost")

    def handle_phone_admin(self, method: str, parts: list[str]):
        """The "Connect phone" panel in the computer's web page: the switch, the pairing code, the paired phones."""
        if parts == ["phone"] and method == "GET":
            return self.send_json(link.status())
        if parts == ["phone"] and method == "POST":
            body = self.read_body()
            if not isinstance(body, dict) or not isinstance(body.get("enabled"), bool):
                return self.send_json({"error": "Missing enabled"}, 400)
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
        return self.send_json({"error": "Unknown endpoint"}, 404)

    def handle_api(self, method: str, path: str):
        parts = [unquote(p) for p in path.split("/")[2:] if p]
        try:
            # Only requests from the local web page: another site can make the browser send requests to 127.0.0.1 (to change
            # notes, open the phone port), but it can't change Host or send cross-site requests with a JSON Content-Type
            # (those need a preflight, which this server doesn't answer)
            if not self.local_host():
                return self.send_json({"error": "Only accessible via 127.0.0.1 or localhost"}, 403)
            if method in ("POST", "PUT") and not self.is_json():
                return self.send_json({"error": "The request must be JSON (Content-Type: application/json)"}, 415)

            if parts[:1] == ["phone"]:
                if self.handle_phone(method, parts):
                    return None
                return self.handle_phone_admin(method, parts)

            if method == "GET" and parts == ["topics"]:
                return self.send_json(list_topics())

            if method == "PUT" and parts == ["topic-order"]:
                body = self.read_body()
                ids = body.get("order") if isinstance(body, dict) else None
                if not isinstance(ids, list) or not all(isinstance(t, str) for t in ids):
                    return self.send_json({"error": "Missing the topic order (order, a list of topic ids)"}, 400)
                try:
                    write_topic_order(ids)
                except ValueError as e:
                    return self.send_json({"error": str(e)}, 400)
                return self.send_json(list_topics())

            if method == "GET" and len(parts) == 2 and parts[0] == "topics":
                tdir = topic_dir(parts[1])
                if not tdir:
                    return self.send_json({"error": "Topic not found"}, 404)
                return self.send_json(load_topic(tdir))

            if len(parts) >= 2 and parts[0] == "records":
                tid = parts[1]
                if not topic_dir(tid):
                    return self.send_json({"error": "Topic not found"}, 404)
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
                    return self.send_json({"error": "Topic not found"}, 404)
                if not ID_RE.match(page_id) or page_id not in page_ids(tdir):
                    return self.send_json({"error": "Page not found"}, 404)
                if method == "GET":
                    return self.send_json(read_note(tid, page_id))
                if method == "PUT":
                    body = self.read_body()
                    if not isinstance(body, dict) or not isinstance(body.get("content"), str):
                        return self.send_json({"error": "Missing the note content (content)"}, 400)
                    base = body.get("base") if isinstance(body.get("base"), str) else None
                    status, payload = write_note(tid, page_id, body["content"], base)
                    return self.send_json(payload, status)

            if len(parts) == 3 and parts[0] == "knowledge":
                tid, page_id = parts[1], parts[2]
                tdir = topic_dir(tid)
                if not tdir:
                    return self.send_json({"error": "Topic not found"}, 404)
                pdir = page_dir_of(tdir, page_id) if ID_RE.match(page_id) else None
                if not pdir:
                    return self.send_json({"error": "Page not found"}, 404)
                if method == "GET":
                    return self.send_json(read_knowledge(tid, pdir))
                if method == "PUT":
                    body = self.read_body()
                    if not isinstance(body, dict) or not isinstance(body.get("content"), str):
                        return self.send_json({"error": "Missing the file content (content)"}, 400)
                    if not body["content"].strip():
                        return self.send_json({"error": "The content can't be empty; to delete the page, delete its folder"}, 400)
                    base = body.get("base") if isinstance(body.get("base"), str) else None
                    status, payload = write_knowledge(pdir, body["content"], base)
                    return self.send_json(payload, status)

            return self.send_json({"error": "Unknown endpoint"}, 404)
        except Exception as e:  # return the error so the page can show the cause
            traceback.print_exc()
            return self.send_json({"error": f"{type(e).__name__}: {e}"}, 500)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    # On Windows SO_REUSEADDR lets two processes take the same port, so it must stay off
    allow_reuse_address = os.name != "nt"


class PhoneHandler(ApiMixin, BaseHTTPRequestHandler):
    """The LAN port for phones: serves only the phone endpoints and the app package."""

    server_version = "Drillbook/2.0"
    timeout = 15  # idle or very slow connections don't hold a thread for long

    def log_message(self, fmt, *args):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def ip_host(self) -> bool:
        """Accept only requests addressed by IP: when another site points at this computer through DNS rebinding, Host is its own domain."""
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
                return self.send_json({"error": "Connect using the IP address"}, 403)
            if method == "GET" and path == "/drillbook.apk":
                return self.send_apk()
            parts = [unquote(p) for p in path.split("/")[2:] if p] if path.startswith("/api/") else []
            if not (parts and self.handle_phone(method, parts)):
                self.send_json({"error": "Unknown endpoint"}, 404)
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
    sys.exit(f"Ports {port}-{port + 19} are all in use; choose another port with --port")


def run_check() -> int:
    dirs = [d for d in visible_dirs(TOPICS_DIR) if ID_RE.match(d.name)]
    if not dirs:
        print(f"No topics in {TOPICS_REL}/ yet.")
        return 0
    errors = 0
    for d in sorted(dirs):
        p = load_topic(d)
        n_points = sum(len(pg["points"]) for pg in p["pages"])
        n_q = sum(len(pg["questions"]) for pg in p["pages"])
        print(f"[{p['id']}] {p['name']}: {plural(len(p['pages']), 'page')}, {plural(n_points, 'knowledge point')}, {plural(n_q, 'question')}")
        if not p["issues"]:
            print("  No problems found")
        for it in p["issues"]:
            tag = "error" if it["level"] == "error" else "warning"
            errors += it["level"] == "error"
            print(f"  {tag}  {it['where']}: {it['msg']}")
    return 1 if errors else 0


def run_outline() -> int:
    """Print the structure of the existing content, so a person or an agent can judge how a new source overlaps existing topics and check coverage."""
    dirs = [d for d in visible_dirs(TOPICS_DIR) if ID_RE.match(d.name)]
    if not dirs:
        print(f"No topics in {TOPICS_REL}/ yet.")
        return 0
    topics = sorted((load_topic(d) for d in dirs), key=lambda p: (p["order"], p["name"]))
    for p in topics:
        n_points = sum(len(pg["points"]) for pg in p["pages"])
        n_q = sum(len(pg["questions"]) for pg in p["pages"])
        tags = " · ".join(x for x in (KIND_LABEL.get(p["kind"], p["kind"]), p["origin"]) if x)
        tags = f" ({tags})" if tags else ""
        print(f"[{p['id']}] {p['name']}{tags}  {plural(len(p['pages']), 'page')} / {plural(n_points, 'knowledge point')} / {plural(n_q, 'question')}  order={p['order']}")
        if p["description"]:
            print(f"  Description: {p['description']}")
        print(f"  Source: {p['path']}/{p['sourceFile']}" if p["source"] else "  Source: none")
        mm = p["mindmap"]
        print(f"  Mind map: {p['path']}/{MINDMAP_FILE} ({plural(count_nodes(mm) - 1, 'node')})" if mm else "  Mind map: none")
        for pg in p["pages"]:
            counts: dict[str, int] = {}
            for q in pg["questions"]:
                for ref in q["points"]:
                    counts[ref] = counts.get(ref, 0) + 1
            print(f"  {pg['dir']}  {pg['title']}  ({plural(len(pg['questions']), 'question')})")
            for pt in pg["points"]:
                print(f"    - {pt['id']}  {pt['title']}  [{plural(counts.get(pt['id'], 0), 'question')}]")
        if p["issues"]:
            n = len(p["issues"])
            print(f"  {plural(n, 'more format issue')}; run --check to see {'it' if n == 1 else 'them'}")
        print()
    return 0


def main() -> None:
    ap = argparse.ArgumentParser(description="Drillbook local server")
    ap.add_argument("--port", type=int, default=8765, help="port (default 8765)")
    ap.add_argument("--no-browser", action="store_true", help="don't open the browser")
    ap.add_argument("--check", action="store_true", help="only check the topic files")
    ap.add_argument("--outline", action="store_true", help="list all topics, pages and knowledge points")
    args = ap.parse_args()

    if args.check:
        sys.exit(run_check())
    if args.outline:
        sys.exit(run_outline())

    TOPICS_DIR.mkdir(parents=True, exist_ok=True)
    RECORDS_DIR.mkdir(parents=True, exist_ok=True)
    httpd, port = make_server(args.port)
    url = f"http://127.0.0.1:{port}/"
    print(f"Drillbook is running: {url}")
    print(f"Topics folder: {TOPICS_DIR}")
    print(f"Answer records: {RECORDS_DIR}")
    if link.config["enabled"]:
        if link.start():
            where = ", ".join(f"{ip}:{link.port}" for ip in lan_addresses()) or f"<this computer's LAN address>:{link.port}"
            print(f"Phone connection: on; enter {where} on the phone")
        else:
            print(f"Phone connection: couldn't turn it on ({link.error})")
    print("Close this window or press Ctrl+C to stop the server.")
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
