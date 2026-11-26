# Turning a source into a topic

The most common task: the user sends a source — the job description (JD) for a role, a book, a course's slides or syllabus, an exam syllabus, or a learning goal they describe — and you generate knowledge points, questions and a mind map for it under `data/topics/`.

The user is involved at only one point: if they haven't said where the content should go and the site already has a similar or overlapping topic, send them your analysis and recommendation first, and wait for them to choose between merging and a new topic before you write anything ([overlap.md](overlap.md)). No other step needs the user.

While writing, keep [file-formats.md](file-formats.md) and [content-standards.md](content-standards.md) at hand. Finish with the [final checklist](#final-checklist).

## 1. Understand the input

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
- The user said where it goes: do as they say, without asking (what counts as "said": [overlap.md](overlap.md#1-has-the-user-already-said)).

## 2. Inventory existing content

1. Run `python server.py --outline`.
2. Read each topic's `topic.json` and `source.md` to learn its type (`kind`), origin and coverage.
3. When you need to judge how deep a subject goes, open that page's `knowledge.md`.

## 3. Break the source down into a knowledge list

- **By default, extract only core knowledge points.** Job: what the requirements and responsibilities state explicitly, plus the fundamentals that interviews for this role ask by default even when the JD doesn't mention them (e.g. Transformers and attention for AI roles, networking and databases for backend roles). Book: each chapter's central concepts, mechanisms and methods. Course: each lecture's topics, plus the concepts covered by assignments and exams. Minor details and nice-to-know material are left out by default.
- When the user specifies scope or granularity, follow it, e.g. "every section", "exam scope only", "as detailed as possible", "chapters 3–5 only", "focus on X"; extract the parts they want to focus on in more detail.
- Book: follow the book's own chapters and sections — one chapter (or part) per page, one section per knowledge point. Knowledge point titles keep the section name and number (e.g. "3.2 Process Scheduling"), so it's obvious where each knowledge point comes from without extra notes. When sections are too fine or too many, merge adjacent ones into one knowledge point titled e.g. "3.2–3.4 Process Scheduling and Synchronization". Keep the book's order and terminology; skip the preface, acknowledgments and chapters unrelated to the subject. When the book only touches on a prerequisite that later material depends on, you may add a knowledge point for it and say that it is supplementary.
- Course: follow the lectures — one lecture (or a few adjacent lectures) per page, each topic within a lecture its own knowledge point, titles prefixed with the lecture number (e.g. "L5 Raft Leader Election"). Base it on the concepts in the slides, notes and assignments; when there is an exam scope, it takes priority.
- Depth: jobs follow the interview level — intern and new-grad interviews test fundamentals and principles; experienced and senior ones test trade-offs, design and troubleshooting. Books and courses follow the depth of the source itself, not clearly beyond it unless the user asks.
- Leave out anything that is not knowledge: behavioral and HR questions, company gossip, unverifiable internal company information, a book's publication details and the author's biography, a course's attendance, grading weights and other administration.

## 4. Check overlap with existing topics

Follow [overlap.md](overlap.md). The outcome is one of four: **fold into** an existing topic, **extend** an existing topic, create a **new** topic, or **ask the user first**. This step decides how much to write and where; don't skip it. You may go ahead without asking only when the user has already said where the content goes, or when it has no significant overlap with any existing topic.

## 5. Plan the pages

- A page is one coherent subject area: one direction of a job topic, one chapter (or part) of a book, one lecture (or a few adjacent lectures) of a course. The number of pages, and of knowledge points per page, follows from the source; there is no preset limit.
- Order by source type:
  - Job: fundamentals → core mechanisms → engineering practice → scenarios and design. The last page is usually "Scenario Design": its knowledge points give analysis approaches and design essentials, and its questions use integrated scenarios.
  - Book: chapter order, one chapter per page; merge short chapters, split long ones. If chapters are skipped and the site's page numbers no longer match the chapter numbers, add a line to the page lead such as "Corresponds to Chapter N of the book."
  - Course: lecture order, merging adjacent lectures into one page where it makes sense.
- Page titles are short (usually at most about 5 words, or 12 Chinese characters) and unnumbered — the site shows the numbers. Book and course page titles can reuse the chapter or lecture name without "Chapter N" or "Lecture N".
- Before writing, list the plan in the conversation: the overlap conclusion (and the user's decision); the pages to create or extend (number, page id, title, and the titles of their knowledge points). Unless this is an "ask the user first" case, start writing right after listing it, without waiting for a reply.

## 6. Generate page by page

- Finish one page at a time: write `knowledge.md` → write `questions.json` → [self-review](content-standards.md#self-review) → run `--check` → fix → next page. Don't generate a whole topic and check it all at the end.
- Formats: [file-formats.md](file-formats.md) (including how to write the files safely); what good content looks like: [content-standards.md](content-standards.md).
- If you can run subagents in parallel, you may split the work by page, but fix the page list and every page's knowledge point titles first; you stay responsible for the overlap analysis and the final overall check.

## 7. Generate or update the mind map

After all pages are written and `--check` passes, write `mindmap.md` as described in [mind-map.md](mind-map.md). It summarizes the knowledge points already written, so it comes last. When you fold into or extend an existing topic, add the new pages and knowledge points to its existing map instead.

## 8. Validate

- `python server.py --check`: no `error` lines, and none of these warnings: `has no questions yet`, `Not linked to any knowledge point`, `Missing explanation`, nor any `mindmap.md` warning (knowledge points missing from or repeated in the map, pages or knowledge points that can't be found).
- `python server.py --outline`: confirm that the structure is right, every knowledge point has at least 2 questions, and the topic has a mind map.
- If you can't run Python in your environment, check everything in [file-formats.md](file-formats.md) by hand and say in your report that validation couldn't be run.

## 9. Report

Tell the user in a few lines:

- The overlap conclusion and its basis (created a new topic / extended or folded into which topic; if the user chose, say that you followed their choice)
- Which pages were added or changed, with knowledge point and question counts; which mind map branches were created or updated
- What you inferred and what you left out (e.g. chapters skipped)
- That refreshing the browser shows the changes

## Final checklist

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
- [ ] Nothing changed in `data/records/`, `data/notes/`, `data/feedback/` (except sample data) or code files
