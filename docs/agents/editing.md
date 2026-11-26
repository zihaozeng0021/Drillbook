# Editing existing content

Rules for changing topics that already exist — fixing a question, deepening a page, adding knowledge points — and the workflow for fixing the questions the user reported while practicing. What good content looks like is in [content-standards.md](content-standards.md); the formats are in [file-formats.md](file-formats.md).

## What may change

- Don't change: topic folder names, page ids (the part of the folder name after the number), knowledge point ids, question ids. Answer records and notes are linked through them.
- You may change: the page number prefix, the wording of the body and explanations; you may add knowledge points and questions.
- Fixing a question: if only the wording or the correct answer changes, keep the id; if what it tests changes, use a new id and delete the old question (the site ignores answer records for ids that no longer exist).
- A new question's id is the page's highest number + 1; never reuse deleted numbers.
- When you add, delete or move knowledge points or pages, update `mindmap.md` ([mind-map.md](mind-map.md)); renaming alone doesn't require it.
- Don't delete content the user didn't ask you to delete.
- After changing a page, [self-review](content-standards.md#self-review) its questions and run `python server.py --check`.

## Fixing reported questions

While practicing, the user can flag a badly generated question with the **Report** button and say what's wrong with it. Reports are kept in `data/feedback/<topic-id>.jsonl`, an append-only log (reports made on the phone arrive with the next sync). When the user asks you to fix the reported questions:

1. Run `python server.py --feedback` (or `--feedback <topic-id>` for one topic). For each open report it shows the question (`<page-id>/<question-id>`), the file to edit, the question as it reads now, and the user's note; "When reported it read" appears when the question has been edited since.
2. For each report, read the question in `questions.json` and its knowledge points in `knowledge.md`, and judge the report. The note may be short or in another language: work out what the user means, and check the claim against the source (for book and course topics) instead of taking it on trust.
3. If the report is right, fix the question by the rules above: wording, options, answer and explanation are edited in place and keep the id; if the question has to test something else, write it with a new id and delete the old one. If the error comes from the knowledge point itself, fix `knowledge.md` too, and `mindmap.md` if a bullet repeats it. Keep the topic's language and the standards in [content-standards.md](content-standards.md).
4. If the question is fine as it is (the report is mistaken, or the question was already fixed), leave it unchanged.
5. After each page, run `--check`.
6. Close each report with `python server.py --resolve <topic-id> <page-id>/<question-id> "<what changed, or why nothing did>"`. The user sees this note when they open the question's report again, so write one clear sentence, in the language of their report. Close reports on questions that no longer exist the same way, saying so. Never edit or delete lines in `data/feedback/` by hand.
7. Tell the user in a few lines what you changed for each report, and which ones you left unchanged and why.

## Before you finish

- [ ] `--check` shows no errors and no coverage or mind map warnings
- [ ] No existing topic, page, knowledge point or question id changed; new question ids continue the page's numbering
- [ ] `mindmap.md` updated if knowledge points or pages were added, deleted or moved
- [ ] Every report you handled is closed with `--resolve` and a note
- [ ] Nothing changed in `data/records/`, `data/notes/` or `data/feedback/` (other than through `--resolve`), or in code files
