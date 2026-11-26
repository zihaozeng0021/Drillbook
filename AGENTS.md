# AGENTS.md

For AI agents working in this repository. This file is the index: what the project is, the hard rules, and which guide to read for your task. The guides are in [`docs/agents/`](docs/agents/); read the ones your task needs.

## What this is

Drillbook is a study and review site that runs on the user's own computer: `server.py` (Python standard library only) serves the front end in `web/` and reads plain files under `data/`. Content is organized as **topic → page → knowledge point → multiple-choice question**, and each topic has a mind map (`mindmap.md`) that summarizes its knowledge points. A **topic** is a learning path generated from one or more **sources**: the job description (JD) for a role, a book, a course's slides or syllabus, an exam syllabus, or a learning goal the user describes. An Android app runs the same site offline and syncs with the computer.

## Hard rules

Whatever the task:

1. Don't modify `data/records/`, `data/notes/`, `data/feedback/` (except closing question reports with `python server.py --resolve`), `server.py`, `web/`, `android/` or `start.bat`, and don't touch `.local/`; change code only when the user explicitly asks you to change the site.
2. Never change an existing topic id, page id, knowledge point id or question id: answer records and notes are linked through them.
3. If the user hasn't said where content should go and the site has a similar or overlapping topic, ask first, and write files only after the user decides.
4. Every question tests understanding and application, and is self-contained: answerable from what was learned plus the question itself. Never "according to the slides" or anything else that needs the source document; no recall questions about years, who proposed something, paper titles, version numbers or item numbers.
5. Write one page at a time: after each page, self-review and run `--check`, and fix everything before starting the next page.

## Sample topic

`data/topics/sample/` is a demo topic on AI agent development. It only shows the format and takes no part in overlap analysis against real sources. When you add the first real topic, delete it, together with the sample-only `data/records/sample.jsonl`, `data/feedback/sample.jsonl` and `data/notes/sample/` (if they exist).

## Find your task

| The user asks you to… | Read |
| --- | --- |
| Turn a source into a topic (a job description, book, course slides, syllabus or learning goal) — the most common task | [add-source.md](docs/agents/add-source.md); it leads you to [overlap.md](docs/agents/overlap.md), [file-formats.md](docs/agents/file-formats.md), [content-standards.md](docs/agents/content-standards.md) and [mind-map.md](docs/agents/mind-map.md) when you need them |
| Write or update a topic's mind map | [mind-map.md](docs/agents/mind-map.md) |
| Fix or improve existing content (a question, a knowledge point, a page) | [editing.md](docs/agents/editing.md), with [file-formats.md](docs/agents/file-formats.md) and [content-standards.md](docs/agents/content-standards.md) |
| Fix the questions they reported while practicing | [editing.md → Fixing reported questions](docs/agents/editing.md#fixing-reported-questions) |
| Change the site itself (server, web pages, Android app) | [site-code.md](docs/agents/site-code.md) |

## Commands

| Command | What it does |
| --- | --- |
| `python server.py` | Start the site at http://127.0.0.1:8765 |
| `python server.py --outline` | Every topic → page → knowledge point, with question counts, and whether each topic has a mind map |
| `python server.py --check` | Format errors and coverage warnings; exits with code 1 if there is any `error` |
| `python server.py --feedback [topic-id]` | The open question reports |
| `python server.py --resolve <topic-id> <page-id>/<question-id> "<note>"` | Close a report after fixing the question |

Replace `python` with `python3` (macOS / Linux) or `py -3` (Windows) as appropriate. Content changes take effect when the user refreshes the browser; no restart needed.

## Where things are

| Path | What it holds | Who changes it |
| --- | --- | --- |
| `data/topics/<topic-id>/` | `topic.json`, `source.md`, `mindmap.md`, and `pages/<NN>-<page-id>/` with `knowledge.md` and `questions.json` | You, following the guides |
| `data/records/` | Answer records | Only the site |
| `data/notes/` | The user's notes | Only the user |
| `data/feedback/` | Question reports | The site; you only close reports with `--resolve` |
| `server.py`, `web/`, `android/`, `start.bat` | The site's code | Only when the user asks you to change the site |
| `.local/` | Machine-local settings and keys | Nobody: don't touch |

## Guides

- [add-source.md](docs/agents/add-source.md): from a source to a topic, step by step, with the final checklist
- [overlap.md](docs/agents/overlap.md): folding into an existing topic, extending one, or creating a new one; when to ask the user
- [file-formats.md](docs/agents/file-formats.md): folders and ids, `topic.json`, `source.md`, `knowledge.md`, `questions.json`, in-site links
- [content-standards.md](docs/agents/content-standards.md): language, knowledge points, questions, explanations, accuracy, self-review
- [mind-map.md](docs/agents/mind-map.md): when to write the mind map, its format, what a good one looks like
- [editing.md](docs/agents/editing.md): what may change in existing content; fixing reported questions
- [site-code.md](docs/agents/site-code.md): changing the server, web pages and Android app; phone sync
