# File formats

How content is laid out under `data/topics/` and what each file must look like. `python server.py --check` reports anything the site can't read.

## Folders and naming

```text
data/topics/
└── <topic-id>/              e.g. ai-agent-security, csapp, mit-6-824
    ├── topic.json
    ├── source.md            optional: the source text (JD, table of contents, syllabus)
    ├── mindmap.md           mind map summarizing all pages and knowledge points
    └── pages/
        ├── 01-<page-id>/    e.g. 01-prompt-injection
        │   ├── knowledge.md
        │   └── questions.json
        └── 02-<page-id>/ …
```

- Topic, page and knowledge point ids are lowercase English words joined by hyphens, e.g. `tool-calling`; question ids are `q01`, `q02`, ….
- Pick a topic id for a broad scope that won't need changing later: jobs use the direction (`backend`, `ai-agent-security`), not the company name; books use an abbreviation of the title (`csapp`, `ddia`) without the edition; courses use the course code or name (`mit-6-824`, `operating-systems`) without the term.
- Page folder name = two-digit number + `-` + page id. Page ids are unique within a topic; the number only sets the order.
- Folders starting with `_` are not loaded and can be used for drafts.
- A page folder's `_history/` holds old versions saved automatically when the user edits `knowledge.md` on the site; loading ignores it. Don't write into it.
- The old names `data/positions/`, `position.json`, `jd.md` and the `company` field are still read, but new content always uses the new names.

## Writing the files

- Write files with your built-in file-writing tool. If you must use a script, specify UTF-8 (no BOM) explicitly; don't rely on the default encodings of Windows PowerShell's `>` or `Set-Content`.
- Keep LF line endings.

## topic.json

```json
{
  "name": "AI Agent Security Engineer",
  "kind": "job",
  "origin": "Some Company",
  "description": "One sentence on what it covers",
  "order": 2
}
```

| Field | Meaning |
| --- | --- |
| `name` | Required. Topic name: job title, book title, course name |
| `kind` | Optional. `job`, `book`, `course` or `exam`; any other text is shown as is. When sources of different types are merged, use the main one |
| `origin` | Optional. Where it comes from: company, author or publisher, school or lecturer. May be empty when several sources are merged |
| `description` | Optional. One sentence on what it covers |
| `order` | Position in the topic list, smaller first. A new topic takes the current maximum + 1 (the sample topic's 99 doesn't count). When the user drag-sorts the topic list, the site rewrites every topic's `order` as 1, 2, 3, … |

## source.md

Records the sources, one `###` subsection per source, titled "Type · Name · Origin (date)". Job: keep the JD text, minus the company introduction, benefits and other irrelevant parts. Book: only the title, edition, author, table of contents and the range this topic covers — **don't paste the text**. Course: only the course name, school or lecturer, term, the list of lectures and the exam scope — **don't paste slide content**. When appending to an existing `source.md` whose content has no subsection heading yet, add one first.

```markdown
### Job · AI Agent Security Engineer · Some Company (2026-10)

**Responsibilities**

- …

**Requirements**

- …

### Book · *Computer Systems: A Programmer's Perspective*, 3rd ed. · Bryant & O'Hallaron

**Contents**

1. A Tour of Computer Systems
2. Representing and Manipulating Information
3. …

This topic covers chapters 1–9; chapters 10–12 are left out.

### Course · MIT 6.824 Distributed Systems (Spring 2024) · MIT

**Lectures**

- L1 Introduction
- L2 RPC and Threads
- …
```

## knowledge.md

```markdown
# Prompt Injection

## Direct and Indirect Injection {#direct-indirect}

Body (Markdown)…

### Subheading (inside a knowledge point, only ### and below)

## Defenses {#defenses}

…
```

- The first line is `# Page title`.
- Each `## Title {#point-id}` starts a knowledge point, which runs until the next `##`. `{#point-id}` is required. Subheadings inside a knowledge point use `###` and `####`.
- A one- or two-sentence page lead may go before the first `##`; leave it out when it isn't needed.
- `##` inside code blocks is not treated as a knowledge point.
- Supported: tables, blockquotes, lists, inline code, fenced code blocks with a language tag (python, javascript, typescript, json, bash, shell, sql, yaml, go, java, cpp, rust, xml/html, markdown, dockerfile, http), and KaTeX math (inline `$...$`, display `$$...$$` on its own lines). Don't write paired single `$` in body text (e.g. prices), or they will be rendered as math.
- Images and Mermaid diagrams are not supported (the site runs offline and has no image folder). Show flows and architectures with ordered lists, tables or text diagrams in code blocks.

## questions.json

```json
[
  {
    "id": "q01",
    "points": ["direct-indirect"],
    "stem": "The question; Markdown supported",
    "options": ["Option one", "Option two", "Option three", "Option four"],
    "answer": "B",
    "explanation": "The explanation; Markdown supported"
  },
  {
    "id": "q02",
    "points": ["direct-indirect", "defenses"],
    "stem": "A multiple-answer question lists several letters",
    "options": ["…", "…", "…", "…"],
    "answer": "AC",
    "explanation": "…"
  }
]
```

| Field | Meaning |
| --- | --- |
| `id` | Unique within the page: `q01`, `q02`, … in order |
| `points` | Ids of the knowledge points this question tests; may be several; must be knowledge points of this page |
| `stem` | The question; may contain code blocks |
| `options` | 2–8 options, mapped in order to A, B, C, … |
| `answer` | Letter of the correct option; several letters make it a multiple-answer question |
| `explanation` | The explanation |
| `type` | Optional: `single` / `multi`. Write `multi` only when a question has one correct answer but should be presented as a multiple-answer question |
| `shuffle` | Optional: `false` keeps this question's options in their order |

- It is standard JSON: no comments and no trailing commas; inside strings, write newlines as `\n`, double quotes as `\"` and backslashes as `\\`. So LaTeX `\frac` is written `\\frac` in JSON.
- The site shuffles options by default, so stems, options and explanations must not depend on option positions.

## mindmap.md

The format, and what a good map looks like, are in [mind-map.md](mind-map.md#format).

## In-site links

Usable in `knowledge.md`, `source.md`, mind map bullets and question explanations; clicking one navigates within the site. The `p` in the path is a fixed prefix.

```markdown
See [Prompt Injection](#/p/llm-security/page/prompt-injection)
Jump straight to a knowledge point: [indirect injection](#/p/llm-security/page/prompt-injection?kp=indirect)
```
