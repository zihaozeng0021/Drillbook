# Overlap with existing topics

Before writing anything for a new source, decide where it goes: **fold it into** an existing topic, **extend** one, create a **new** topic, or **ask the user first**. This is step 4 of [add-source.md](add-source.md).

## Principles

**Principle 1: no duplication within a topic.** A topic is one learning path; within a topic, each piece of knowledge is written once. Topics may overlap each other: each is written completely from its own source, with in-site links to deeper coverage in another topic where useful.

**Principle 2: the user decides between merging and a new topic.** When the user hasn't said where content goes, you analyze and recommend; you may not merge on your own, nor quietly create a new topic when a similar one clearly exists.

## 1. Has the user already said?

All of these count as said; just do it, without asking:

- "Create a new topic", "make it a separate topic", "don't merge"
- "Merge into X", "add it to X", "extend X", "add it to page Y of X"
- The user already made a choice for the same source earlier in this conversation
- The user has given a standing rule (e.g. "always merge roles of the same kind from now on") and it applies here

## 2. Find candidate topics

Take the knowledge list from [step 3 of add-source.md](add-source.md#3-break-the-source-down-into-a-knowledge-list) and compare it with each existing topic from two angles.

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

## 3. Decide

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

## 4. Examples

- Existing "LLM Security" (job), new "AI Agent Security" JD: same kind, high B → candidate. Recommend **extending**: keep the existing pages, add pages on tool-calling security, permissions and sandboxing, the MCP supply chain, multi-agent systems and memory poisoning, and rename the topic "LLM and AI Agent Security". **Ask the user first.**
- Existing "AI Agent Security" (job), new "LLM Security" JD: high A → candidate. Recommend **folding in**: add the few missing knowledge points and append the source. Ask the user first.
- Existing *Operating System Concepts*, 9th edition (book), new 10th edition of the same book: same book → candidate. Recommend folding in, adding only what the new edition adds or rewrites, and append an edition note to `source.md`. Ask the user first.
- Existing "Backend Engineer" (job), new *DDIA* (book): same kind across types; A high for the data-systems part, B moderate → candidate. Both approaches make sense: fold it into the backend topic as a few in-depth pages, or create a *DDIA* topic and link the backend topic's overviews to it. Ask the user first and explain the difference.
- Existing "LLM Security", new "AI Agent Developer" JD: overlaps only on a few subjects such as prompt injection, A and B both low, not the same kind of role → just create a **new** topic; describe the comparison in the report.
- Existing "AI Agent Security", new *Introduction to Algorithms*: no candidate → just create a new topic.

## 5. Carrying out the choice

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
- Write subjects that overlap other topics as usual, so that the new topic stands on its own; where useful, link to deeper pages in other topics as further reading ([in-site links](file-formats.md#in-site-links)).
