# AGENTS.md

For AI agents working in this repository.

This is a study and review site that runs on your own computer: `server.py` (Python standard library only) reads the files under `data/`, and `web/` is a plain front end. Content is organized as **topic → page → knowledge point → multiple-choice question**; each topic also has a mind map (`mindmap.md`) that summarizes all of its knowledge points. Everything is plain files.

A **topic** is a learning path generated from one or more **sources**. A source can be the job description (JD) for a role, a book, a course's slides or syllabus, an exam syllabus, or a learning goal the user describes. Several heavily overlapping sources can be merged into one topic or get a topic each; the user decides (see "II. Overlap analysis and authorization").

**The most common task: the user sends a source, and you generate knowledge points, questions and a mind map for it under `data/topics/`.** Follow the workflow below. The user is involved at only one point: if they haven't said where the content should go and the site already has a similar or overlapping topic, send them your analysis and recommendation first, and wait for them to choose between merging and a new topic before you write anything (see "II. Overlap analysis and authorization"). No other step needs the user.

## Hard rules

Whatever the task:

1. Don't modify `data/records/`, `data/notes/`, `data/feedback/` (except closing question reports with `python server.py --resolve`), `server.py`, `web/`, `android/` or `start.bat`, and don't touch `.local/`; change code only when the user explicitly asks you to change the site.
2. Never change an existing topic id, page id, knowledge point id or question id: answer records and notes are linked through them.
3. If the user hasn't said where content should go and the site has a similar or overlapping topic, ask first, and write files only after the user decides.
4. Every question tests understanding and application; no recall questions about years, who proposed something, paper titles, version numbers or item numbers.
5. Write one page at a time: after each page, self-review and run `--check`, and fix everything before starting the next page.

## Sample topic

`data/topics/sample/` is a demo topic on AI agent development. It only shows the format and takes no part in overlap analysis against real sources. When you add the first real topic, delete it, together with the sample-only `data/records/sample.jsonl` and `data/notes/sample/` (if they exist).

## Quick reference

| Item | Details |
| --- | --- |
| Where content goes | `data/topics/<topic-id>/` |
| Don't modify when generating content | `data/records/` (answer records), `data/notes/` (user notes), `data/feedback/` (question reports), `server.py`, `web/`, `android/`, `start.bat`, `.local/` (local config and keys) |
| Mind map | `data/topics/<topic-id>/mindmap.md`: generate it after all pages are written; update it when pages or knowledge points are added or removed |
| Inventory existing content | `python server.py --outline`: every topic → page → knowledge point, how many questions each knowledge point has, and whether the topic has a mind map |
| Validate | `python server.py --check`: format errors and coverage warnings; exits with code 1 if there is any `error` |
| Question reports | `python server.py --feedback`: the questions the user reported while practicing; see "Fixing reported questions" in "V. Editing existing content" |
| Taking effect | No restart needed; the user just refreshes the browser |

Replace `python` with `python3` (macOS / Linux) or `py -3` (Windows) as appropriate.

## I. Workflow

### 1. Understand the input

Source types, and what the user may add:

| Type | The user may give | Common extra requirements |
| --- | --- | --- |
| Job | Full JD, only the job title, a job-posting link | Level (intern / new grad / experienced / senior), focus areas, interview language |
| Book | Title (edition, author), table of contents, some chapters, the whole book as a file | Purpose (interview / exam / self-study), which chapters, depth |
| Course | Slides (PDF / PPT), lecture notes, syllabus, link to an open course | Term, which lectures, exam scope |
| Other | Exam syllabus, certification outline, a set of papers, the user's own list of learning goals | Treat as the closest type |

- A link: open and read it if you can go online; otherwise ask the user to paste the text.
- A file: read it with your file-reading tools. For a long book or a full set of slides, first read the table of contents and the start of each chapter (lecture) to settle the structure, then read it chapter by chapter; don't infer the whole book from its opening.
- Only a name: for a job, infer what such a role usually requires; for a book, use its well-known table of contents and content; for a course, use a typical syllabus. Say in your report that it was inferred. If you are not sure of a book's or course's chapters, don't invent chapter titles or page numbers.
- Several sources at once: handle them one at a time; when handling the next one, count the result of the previous one as an existing topic.
- The user said where it goes: do as they say, without asking (what counts as "said" is in "II.1").

### 2. Inventory existing content

1. Run `python server.py --outline`.
2. Read each topic's `topic.json` and `source.md` to learn its type (`kind`), origin and coverage.
3. When you need to judge how deep a subject goes, open that page's `knowledge.md`.

### 3. Break the source down into a knowledge list

- **By default, extract only core knowledge points.** Job: what the requirements and responsibilities state explicitly, plus the fundamentals that interviews for this role ask by default even when the JD doesn't mention them (e.g. Transformers and attention for AI roles, networking and databases for backend roles). Book: each chapter's central concepts, mechanisms and methods. Course: each lecture's topics, plus the concepts covered by assignments and exams. Minor details and nice-to-know material are left out by default.
- When the user specifies scope or granularity, follow it, e.g. "every section", "exam scope only", "as detailed as possible", "chapters 3–5 only", "focus on X"; extract the parts they want to focus on in more detail.
- Book: follow the book's own chapters and sections — one chapter (or part) per page, one section per knowledge point. Knowledge point titles keep the section name and number (e.g. "3.2 Process Scheduling"), so it's obvious where each knowledge point comes from without extra notes. When sections are too fine or too many, merge adjacent ones into one knowledge point titled e.g. "3.2–3.4 Process Scheduling and Synchronization". Keep the book's order and terminology; skip the preface, acknowledgments and chapters unrelated to the subject. When the book only touches on a prerequisite that later material depends on, you may add a knowledge point for it and say that it is supplementary.
- Course: follow the lectures — one lecture (or a few adjacent lectures) per page, each topic within a lecture its own knowledge point, titles prefixed with the lecture number (e.g. "L5 Raft Leader Election"). Base it on the concepts in the slides, notes and assignments; when there is an exam scope, it takes priority.
- Depth: jobs follow the interview level — intern and new-grad interviews test fundamentals and principles; experienced and senior ones test trade-offs, design and troubleshooting. Books and courses follow the depth of the source itself, not clearly beyond it unless the user asks.
- Leave out anything that is not knowledge: behavioral and HR questions, company gossip, unverifiable internal company information, a book's publication details and the author's biography, a course's attendance, grading weights and other administration.

### 4. Analyze overlap with existing topics; get the user's decision if needed

Follow "II. Overlap analysis and authorization". The outcome is one of four: **fold into** an existing topic, **extend** an existing topic, create a **new** topic, or **ask the user first**. This step decides how much to write and where; don't skip it. You may go ahead without asking only when the user has already said where the content goes, or when it has no significant overlap with any existing topic.

### 5. Plan the pages

- A page is one coherent subject area: one direction of a job topic, one chapter (or part) of a book, one lecture (or a few adjacent lectures) of a course. The number of pages, and of knowledge points per page, follows from the source; there is no preset limit.
- Order by source type:
  - Job: fundamentals → core mechanisms → engineering practice → scenarios and design. The last page is usually "Scenario Design": its knowledge points give analysis approaches and design essentials, and its questions use integrated scenarios.
  - Book: chapter order, one chapter per page; merge short chapters, split long ones. If chapters are skipped and the site's page numbers no longer match the chapter numbers, add a line to the page lead such as "Corresponds to Chapter N of the book."
  - Course: lecture order, merging adjacent lectures into one page where it makes sense.
- Page titles are short (usually at most about 5 words, or 12 Chinese characters) and unnumbered — the site shows the numbers. Book and course page titles can reuse the chapter or lecture name without "Chapter N" or "Lecture N".
- Before writing, list the plan in the conversation: the overlap conclusion (and the user's decision); the pages to create or extend (number, page id, title, and the titles of their knowledge points). Unless this is an "ask the user first" case, start writing right after listing it, without waiting for a reply.

### 6. Generate page by page

- Finish one page at a time: write `knowledge.md` → write `questions.json` → self-review → run `--check` → fix → next page. Don't generate a whole topic and check it all at the end.
- Self-review means reading all of the page's questions and confirming for each one that the answer is unique and sound, the distractors come from real misconceptions, the stem doesn't give the answer away, nothing depends on option positions, and it is not a recall question; then check that the page's correct answers are spread across positions and that multiple-answer questions make up 25%–40%.
- If you can run subagents in parallel, you may split the work by page, but fix the page list and every page's knowledge point titles first; you stay responsible for the overlap analysis and the final overall check.
- Write files with your built-in file-writing tool. If you must use a script, specify UTF-8 (no BOM) explicitly; don't rely on the default encodings of Windows PowerShell's `>` or `Set-Content`.
- `questions.json` is standard JSON: no comments and no trailing commas; inside strings, write newlines as `\n`, double quotes as `\"` and backslashes as `\\`. So LaTeX `\frac` is written `\\frac` in JSON.

### 7. Generate or update the mind map

- After all pages are written and `--check` passes, write `mindmap.md` (format in "III. File formats", standards in "IV. Content standards"). It summarizes the knowledge points already written, so it comes last.
- When you add pages or knowledge points to an existing topic (folding in, extending, supplementing), add the new content at the right place in `mindmap.md`. Renaming a knowledge point or page doesn't require touching it: linked nodes show the new title automatically.
- If an existing topic has no mind map yet and the user asks for one, do only this step: read every page's `knowledge.md`, write `mindmap.md` to the standard, and change no other file.
- With many pages, you may have subagents draft the bullets page by page, but fix the grouping and page order first; after merging, read the whole map yourself and even out length and style.

### 8. Validate

- `python server.py --check`: no `error` lines, and none of these warnings: `has no questions yet`, `Not linked to any knowledge point`, `Missing explanation`, nor any `mindmap.md` warning (knowledge points missing from or repeated in the map, pages or knowledge points that can't be found).
- `python server.py --outline`: confirm that the structure is right, every knowledge point has at least 2 questions, and the topic has a mind map.
- If you can't run Python in your environment, check everything in "III. File formats" by hand and say in your report that validation couldn't be run.

### 9. Report

Tell the user in a few lines:

- The overlap conclusion and its basis (created a new topic / extended or folded into which topic; if the user chose, say that you followed their choice)
- Which pages were added or changed, with knowledge point and question counts; which mind map branches were created or updated
- What you inferred and what you left out (e.g. chapters skipped)
- That refreshing the browser shows the changes

## II. Overlap analysis and authorization

**Principle 1: no duplication within a topic.** A topic is one learning path; within a topic, each piece of knowledge is written once. Topics may overlap each other: each is written completely from its own source, with in-site links to deeper coverage in another topic where useful.

**Principle 2: the user decides between merging and a new topic.** When the user hasn't said where content goes, you analyze and recommend; you may not merge on your own, nor quietly create a new topic when a similar one clearly exists.

### 1. Has the user already said?

All of these count as said; just do it, without asking:

- "Create a new topic", "make it a separate topic", "don't merge"
- "Merge into X", "add it to X", "extend X", "add it to page Y of X"
- The user already made a choice for the same source earlier in this conversation
- The user has given a standing rule (e.g. "always merge roles of the same kind from now on") and it applies here

### 2. Find candidate topics

Take the knowledge list from step 3 and compare it with each existing topic from two angles.

**Is the source of the same kind?** (see `kind`, `name` and `origin` in `topic.json`, and `source.md`)

| Existing topic | Counts as the same kind when |
| --- | --- |
| Job | Same or similar job title; highly similar responsibilities (the same direction at different companies, different levels at the same company) |
| Book | Another edition or translation of the same book; another book on the same subject (two operating systems textbooks) |
| Course | Another term of the same course; a course of the same name at another school; another course on the same subject |
| Across types | A book or course that is exactly the core of a job topic (a backend role and *DDIA*) |

**Does the knowledge overlap?** (rough estimates of two ratios; "covered" means the same knowledge at a similar depth)

- **A**: the share of the new source's knowledge points that this existing topic already covers (how far new ⊆ old)
- **B**: the share of this existing topic's knowledge points that the new source also needs (how far old ⊆ new)

**Candidate topics** = existing topics of the same kind, or with A or B ≥ 30%. When the new source needs clearly more depth, count it as not covered; later, deepen the existing knowledge point instead of writing a second copy.

How to estimate: go through the knowledge list item by item against the existing topic's knowledge points and count "covered / total". When sending this to the user, write it as a fraction such as "about 18/40", not just a percentage, so it can be checked.

### 3. Decide

| Situation | What to do |
| --- | --- |
| The user has said | Do it |
| No candidate topics | Create a new topic without asking; say in the report which topics you compared against |
| There are candidate topics | Send the analysis and recommendation to the user and **stop and wait for the reply**; don't write any file before it comes |

Keep the message short, a few lines:

1. What the new source is (type, name).
2. For each candidate topic: name, type, estimates of A and B, and the main areas of overlap.
3. Your recommendation and why. Base it on:
   - A ≥ 70% → **fold in** (fill the gaps in the existing topic)
   - B ≥ 70% → **extend** (the existing topic grows into a broader scope; propose the new topic name)
   - A new edition of the same book, a new term of the same course → fold in, adding only the differences
   - Otherwise → **new topic**
4. Ask the user to choose: **merge into a candidate** (fold in or extend), or **create a new topic**. With several candidates, list each one.

For example:

```text
New source: job "AI Agent Security · Some Company".
Candidate: "LLM Security" (job). About 45% of the new source's knowledge points already exist there (A); about 85% of its knowledge points are also needed by the new source (B). Overlap: prompt injection, jailbreaks, data leakage.
Recommendation: extend "LLM Security" into "LLM and AI Agent Security", adding only pages on tool-calling security, permissions and sandboxing, the MCP supply chain, multi-agent systems and memory poisoning.
Please choose: 1) extend as recommended  2) create a new topic "AI Agent Security"
```

While waiting, you may do the preparation that needs no decision: read the whole source, build the knowledge list, draft the pages. After the reply, follow the user's choice, together with any other requests in it (renaming the topic, only certain chapters). If you are running unattended and get no reply, the same applies: stop at this step, put the candidates and your recommendation in the report, and don't decide on your own.

- If several candidates qualify for merging, recommend the one with the highest ratio.
- Don't merge two existing topics automatically, and don't move pages between topics: answer records and notes are linked by id, and moving breaks them. If something really is redundant, suggest it to the user and let them decide.

### 4. Examples

- Existing "LLM Security" (job), new "AI Agent Security" JD: same kind, high B → candidate. Recommend **extending**: keep the existing pages, add pages on tool-calling security, permissions and sandboxing, the MCP supply chain, multi-agent systems and memory poisoning, and rename the topic "LLM and AI Agent Security". **Ask the user first.**
- Existing "AI Agent Security" (job), new "LLM Security" JD: high A → candidate. Recommend **folding in**: add the few missing knowledge points and append the source. Ask the user first.
- Existing *Operating System Concepts*, 9th edition (book), new 10th edition of the same book: same book → candidate. Recommend folding in, adding only what the new edition adds or rewrites, and append an edition note to `source.md`. Ask the user first.
- Existing "Backend Engineer" (job), new *DDIA* (book): same kind across types; A high for the data-systems part, B moderate → candidate. Both approaches make sense: fold it into the backend topic as a few in-depth pages, or create a *DDIA* topic and link the backend topic's overviews to it. Ask the user first and explain the difference.
- Existing "LLM Security", new "AI Agent Developer" JD: overlaps only on a few subjects such as prompt injection, A and B both low, not the same kind of role → just create a **new** topic; describe the comparison in the report.
- Existing "AI Agent Security", new *Introduction to Algorithms*: no candidate → just create a new topic.

### 5. How to carry out each choice

**Fold in**

- If a missing subject fits an existing page, add it to that page as a new knowledge point (with questions); add new pages only for whole missing areas.
- Add the new knowledge points and pages to `mindmap.md`.
- Append the new source at the end of `source.md` (a new `###` subsection).
- You may add a sentence to `description` in `topic.json` about what else it now covers.

**Extend**

- Don't create a new folder; **keep the topic id (folder name)** — answer records `data/records/<topic-id>.jsonl` and notes `data/notes/<topic-id>/` are linked through it.
- Insert new pages in logical order: you may change the number prefix of page folders, but not the page id after it.
- When an existing page needs more depth, append knowledge points and questions; don't change existing question ids.
- Change `name` and `description` in `topic.json` to the wider scope (`kind` takes the main type); append the new source to `source.md`.
- Regroup `mindmap.md` for the new scope and add the new pages and knowledge points.

**New topic**

- Create `data/topics/<new-topic-id>/`.
- Write subjects that overlap other topics as usual, so that the new topic stands on its own; where useful, link to deeper pages in other topics as further reading.

**In-site links** (usable in `knowledge.md`, `source.md`, mind map bullets and question explanations; clicking one navigates within the site; the `p` in the path is a fixed prefix):

```markdown
See [Prompt Injection](#/p/llm-security/page/prompt-injection)
Jump straight to a knowledge point: [indirect injection](#/p/llm-security/page/prompt-injection?kp=indirect)
```

## III. File formats

### Folders and naming

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

### topic.json

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

### source.md

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

### knowledge.md

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

### questions.json

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

The site shuffles options by default, so stems, options and explanations must not depend on option positions.

### mindmap.md

The site draws it as the topic's mind map ("Mind map" in the side navigation): the topic name in the center, then groups, pages, knowledge points and bullets outward, each level expandable. Page and knowledge point nodes are colored by how well their questions are mastered, and the arrow on a node opens its text.

```markdown
- Threats and Attacks
  - {prompt-injection}
    - {#definition}
      - Untrusted input hijacks model behavior against developer/user intent
      - Root cause: instructions and data share one channel, no hard boundary
      - vs jailbreak
        - Injection: hijacks the app, attacker is often a third party
        - Jailbreak: bypasses the model's safety policy, often the user themselves
    - {#direct-indirect}
      - …
- Defenses
  - …
```

- The whole file is one nested list: one node per line, written `- text`, each level indented two more spaces. No other paragraphs.
- The center node shows the topic name; a first line `# Title` replaces it with other text, which is rarely needed.
- Braces at the end of a line link the node to a page or knowledge point: `{page-id}` links a page; `{#point-id}` links a knowledge point of the nearest enclosing page; `{page-id#point-id}` names both.
- Linked nodes usually have no text of their own: the site shows the page or knowledge point title and follows it when the title changes. If a title is too long, you may write a shorter label before the braces.
- Bullets may use inline Markdown: inline code, bold, `$math$`, in-site links. Don't end a line with something shaped like `{…}` (it would be read as a link), and don't use paired single `$`.
- `--check` warns about pages or knowledge points that can't be found, knowledge points missing from the map, knowledge points that appear more than once, and lines that are not list items.

## IV. Content standards

### Language

- Write in the language of the user's request. If the user says the interview or exam will be in a particular language, write in that language. A topic stays in one language: when you add to an existing topic, keep the language it is written in unless the user asks otherwise.
- **When the content is not in English, put the English term in parentheses after every core term**, e.g. in Chinese `梯度（gradient）`, `线性无关（linearly independent）`. Annotate the term's first occurrence in every knowledge point, even when an earlier knowledge point already annotated it; later occurrences within the same knowledge point may use the term alone, or the English term or abbreviation directly. Core terms are the concepts, methods and theorem names that the knowledge point explains; everyday words and words that are already English need no annotation. Core terms in stems, options and explanations that the body hasn't annotated get annotated too. Take the English term from the source; without a source, use the established industry term; don't coin translations.
- English content needs no annotations.
- Book and course topics keep the source's terminology and notation (the book's variable names, the slides' symbols).

### Knowledge points

- Open with one or two sentences that state the conclusion or definition directly — something that could be the first sentence of an interview or exam answer.
- Then expand as needed: principle and mechanism → comparison and trade-offs (tables work well) → practice and examples (code, configuration, real scenarios) → common pitfalls.
- For knowledge points that interviews or exams often ask about, end with a blockquote `> Interview answer:` (job topics) or `> Recap:` (book and course topics), with the label written in the content's language, giving the points you could say in 30 seconds.
- Length: mostly 100–350 words (150–500 characters in Chinese); complex subjects up to about 550 words (800 characters). Anything longer gets split into two knowledge points.
- Knowledge point titles are short and specific (usually at most about 6 words, or 16 Chinese characters).
- No filler or transition sentences (e.g. "This section introduces…"), no historical anecdotes that don't help learning.
- Use your own words. Quote a book or slides only for the key sentence or two, with the source named; don't copy whole paragraphs.
- Within one topic, each knowledge point is written once; content that overlaps other topics is written as usual, with in-site links to deeper coverage in another topic where useful.

### Questions

- At least 2 questions per knowledge point; 3–4 for important ones.
- Rough mix: concept understanding 30%, scenario application and troubleshooting 40%, comparison and trade-offs 20%, details and easy mistakes 10%. Multiple-answer questions make up 25%–40%.
- Difficulty: job topics at the depth interviewers actually ask; book and course topics at the depth of end-of-chapter exercises and exams, not beyond what the source covers.
- **Every question tests understanding and application of the knowledge point**: mechanisms and principles, why something is designed the way it is, trade-offs between approaches, how to judge and handle a concrete scenario. Answering correctly should show "understood this knowledge point", not "remembered a fact".
- **No pointless recall questions**: the year, person, paper or company that introduced a concept; version numbers and release dates of standards, specifications and models; the number, rank or count of an item in a ranking or list; a library parameter's default value; expanding abbreviations, translating terms and other pure name matching. These facts may appear in the body, but must not be what a question tests. The test: if the answer can be looked up once and knowing it doesn't help you do anything, don't ask it.
- When citing papers, incidents or standards, test the lesson, not the thing itself: don't ask "what did study X conclude"; turn the conclusion into a scenario or judgment question. Don't ask "what year did incident X happen"; ask "what problem did it expose, and which measures prevent it". Stems contain no years, authors, CVE numbers or other provenance; put provenance in the explanation if needed. For standards and lists (e.g. the OWASP Top 10), test what each risk means and how to recognize and mitigate it, not its number or order.
- Exception: when a number or name is itself working knowledge, it may be tested, e.g. what HTTP status codes mean, or how the TCP three-way handshake works; the question should still be about its meaning and use.
- Stems are self-contained, never "according to the text above"; one question tests one point; a negative stem bolds the negation (**not**).
- Usually 4 options (4–5 for multiple-answer questions), similar in length and tone; distractors come from real misconceptions and shouldn't be obviously wrong.
- Don't use position-dependent options such as "all of the above" / "none of the above"; if one is really needed, add `"shuffle": false` to that question.
- Multiple-answer questions have 2–3 correct options; don't write "(select all that apply)" in the stem — the site shows the question type.
- Spread correct answers across positions; don't let the longest option always be the answer.
- Don't duplicate questions the topic already has.

### Explanations

- First explain why the answer is right, then where the main distractors go wrong; usually 40–100 words (50–150 Chinese characters).
- Refer to options by their content, never "pick B" or "option A" (options are shuffled).

### Mind map

- Purpose: overview and memory relief — one scan should bring back the topic's structure and each knowledge point's core content.
- Structure: center (topic) → groups → pages → knowledge points → bullets. Job topics with many pages (8 or more) group them by theme into 3–6 groups, e.g. "Foundations / Threats and Attacks / Defenses / Evaluation and Practice"; with few pages, they hang directly under the center. Book and course topics follow chapter or lecture order, usually without extra groups.
- Each knowledge point appears exactly once, under its page, in the same order as in `knowledge.md`.
- 3–5 bullets per knowledge point, up to 6 for big ones: the first is the core definition or conclusion, then the mechanism or root cause, key contrasts, main measures, a representative example. When the knowledge point has an `> Interview answer:` or `> Recap:`, the bullets cover it.
- Bullets are memory cues, not sentences: usually at most about 10 words (25 characters in Chinese), no final period; `→` for cause or flow, `vs` for contrast, a colon between a label and its content, `/` or commas for lists.
- A contrast or a short list may go one level deeper (e.g. the two lines under "vs jailbreak"), no deeper. Merge a dozen-item list into 2–4 bullets by theme instead of listing every item.
- Only distill what `knowledge.md` already says — no new facts — and keep the body's terminology. English names used directly in interviews or exams (ReAct, RAG, LoRA) are written as they are; to keep bullets short, they need no English annotations even in non-English topics.
- No years, authors, paper titles, version numbers or item numbers; case names (e.g. EchoLeak) are fine as memory cues.

### Accuracy

- Write only what you are sure of. For fast-moving areas (models, framework versions, standards such as the OWASP Top 10 for LLM Applications), verify online if you can and state the version or year; don't present what you can't verify as fact.
- Book and course topics follow the source; when the source disagrees with industry consensus, follow the source and note the difference in the knowledge point or explanation.
- Don't invent numbers, papers, links, product features, chapters or page numbers.
- Use the same term for the same concept across the whole site.

## V. Editing existing content

- Don't change: topic folder names, page ids (the part of the folder name after the number), knowledge point ids, question ids. Answer records and notes are linked through them.
- You may change: the page number prefix, the wording of the body and explanations; you may add knowledge points and questions.
- Fixing a question: if only the wording or the correct answer changes, keep the id; if what it tests changes, use a new id and delete the old question (the site ignores answer records for ids that no longer exist).
- A new question's id is the page's highest number + 1; never reuse deleted numbers.
- When you add, delete or move knowledge points or pages, update `mindmap.md`; renaming alone doesn't require it.
- Don't delete content the user didn't ask you to delete.

### Fixing reported questions

While practicing, the user can flag a badly generated question with the **Report** button and say what's wrong with it. Reports are kept in `data/feedback/<topic-id>.jsonl`, an append-only log (reports made on the phone arrive with the next sync). When the user asks you to fix the reported questions:

1. Run `python server.py --feedback` (or `--feedback <topic-id>` for one topic). For each open report it shows the question (`<page-id>/<question-id>`), the file to edit, the question as it reads now, and the user's note; "When reported it read" appears when the question has been edited since.
2. For each report, read the question in `questions.json` and its knowledge points in `knowledge.md`, and judge the report. The note may be short or in another language: work out what the user means, and check the claim against the source (for book and course topics) instead of taking it on trust.
3. If the report is right, fix the question by the rules above: wording, options, answer and explanation are edited in place and keep the id; if the question has to test something else, write it with a new id and delete the old one. If the error comes from the knowledge point itself, fix `knowledge.md` too, and `mindmap.md` if a bullet repeats it. Keep the topic's language and the standards in "IV. Content standards".
4. If the question is fine as it is (the report is mistaken, or the question was already fixed), leave it unchanged.
5. After each page, run `--check`.
6. Close each report with `python server.py --resolve <topic-id> <page-id>/<question-id> "<what changed, or why nothing did>"`. The user sees this note when they open the question's report again, so write one clear sentence, in the language of their report. Close reports on questions that no longer exist the same way, saying so. Never edit or delete lines in `data/feedback/` by hand.
7. Tell the user in a few lines what you changed for each report, and which ones you left unchanged and why.

## VI. Final checklist

- [ ] Overlap analysis done: no candidate topics, or the user has chosen
- [ ] `--check` shows no errors and no coverage warnings
- [ ] Every knowledge point has at least 2 questions; multiple-answer questions are about 25%–40%; correct answers are spread across positions
- [ ] No letter references such as "pick B" or "option A" in explanations
- [ ] Content not in English: every knowledge point annotates its core terms with the English term in parentheses
- [ ] No recall questions about years, proposers, paper titles, version numbers or item numbers; every question maps to understanding or applying a knowledge point
- [ ] Book / course topics: pages and knowledge points follow the book's chapters or the lectures, and knowledge point titles carry section or lecture numbers; `source.md` has only the contents and scope, no copied text
- [ ] LaTeX backslashes are escaped in JSON
- [ ] No duplicate knowledge points or questions within the topic
- [ ] `mindmap.md` created or updated: each knowledge point appears once, with 3–5 short bullets; `--check` shows no mind map warnings
- [ ] `topic.json` and `source.md` updated according to the overlap conclusion
- [ ] Fixing reported questions: every report you handled is closed with `--resolve` and a note
- [ ] Nothing changed in `data/records/`, `data/notes/`, `data/feedback/` (except sample data and `--resolve`) or code files

## VII. Other tasks: changing the site itself

Change code only when the user explicitly asks you to change the site.

- No new dependencies: the backend uses only the Python standard library; the front end is plain ES modules, with third-party libraries in `web/vendor/`, never loaded from a CDN (the user may be offline, or on a network that can't reach CDNs abroad).
- Keep the file formats under `data/` backward compatible: the old `data/positions/`, `position.json`, `jd.md` and the `company` field must keep loading.
- Interface style: dark navy background; color only encodes data state (Weak / Fair / Mastered / New); no decorative text. Interface text, messages, code comments and docs are in English.
- The Android app (`android/`) is only a WebView shell; the site code is copied in from `web/` at build time. `android/build.py` drives the Android SDK using only the Python standard library, without Gradle. After changing `web/`, run `python android/build.py` to rebuild it.
- Pages in the phone app read and write the phone's own data through `web/js/api.js` (implemented by `web/js/local.js`) and never call the computer directly; when you add or change an interface in `api.js`, implement the same interface in `local.js`.
- Phone–computer sync: the phone side is in `web/js/phone.js` and `web/js/autosync.js`, the computer side in `apply_phone_sync` in `server.py`. Answer records are merged by "time + question", and question reports by "time + question + kind" (both are append-only logs). For notes, if only one side changed, that version is used; if both changed, the later edit wins and the other copy goes to `_history/`. The topic order (drag sorting) works the same way as notes. Each topic's reset time is in `data/records/resets.json`. When you change how answer records, question reports, notes or the topic order are stored, take care of all three places; the phone keeps its data in IndexedDB (`web/js/local.js`), so a new store needs a higher `DB_VERSION` and an upgrade step that keeps existing data.
- After changes, walk through the affected flows in a real browser and run `--check`.
