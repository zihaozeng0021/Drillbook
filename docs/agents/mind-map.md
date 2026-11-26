# Mind maps

Each topic has a `mindmap.md` that the site draws as the topic's mind map ("Mind map" in the side navigation): the topic name in the center, then groups, pages, knowledge points and bullets outward, each level expandable. Page and knowledge point nodes are colored by how well their questions are mastered, and the arrow on a node opens its text. Its purpose is overview and memory relief: one scan should bring back the topic's structure and each knowledge point's core content.

## When to write or update it

- **New topic**: after all pages are written and `--check` passes. It summarizes the knowledge points already written, so it comes last.
- **Pages or knowledge points added to an existing topic** (folding in, extending, supplementing): add the new content at the right place. Renaming a knowledge point or page doesn't require touching the map: linked nodes show the new title automatically.
- **The user asks for a map for a topic that has none**: do only this: read every page's `knowledge.md`, write `mindmap.md` to the standard below, and change no other file.
- With many pages, you may have subagents draft the bullets page by page, but fix the grouping and page order first; after merging, read the whole map yourself and even out length and style.

## Format

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
- Bullets may use inline Markdown: inline code, bold, `$math$`, [in-site links](file-formats.md#in-site-links). Don't end a line with something shaped like `{…}` (it would be read as a link), and don't use paired single `$`.

## What a good map looks like

- Structure: center (topic) → groups → pages → knowledge points → bullets. Job topics with many pages (8 or more) group them by theme into 3–6 groups, e.g. "Foundations / Threats and Attacks / Defenses / Evaluation and Practice"; with few pages, they hang directly under the center. Book and course topics follow chapter or lecture order, usually without extra groups.
- Each knowledge point appears exactly once, under its page, in the same order as in `knowledge.md`.
- 3–5 bullets per knowledge point, up to 6 for big ones: the first is the core definition or conclusion, then the mechanism or root cause, key contrasts, main measures, a representative example. When the knowledge point has an `> Interview answer:` or `> Recap:`, the bullets cover it.
- Bullets are memory cues, not sentences: usually at most about 10 words (25 characters in Chinese), no final period; `→` for cause or flow, `vs` for contrast, a colon between a label and its content, `/` or commas for lists.
- A contrast or a short list may go one level deeper (e.g. the two lines under "vs jailbreak"), no deeper. Merge a dozen-item list into 2–4 bullets by theme instead of listing every item.
- Only distill what `knowledge.md` already says — no new facts — and keep the body's terminology. English names used directly in interviews or exams (ReAct, RAG, LoRA) are written as they are; to keep bullets short, they need no English annotations even in non-English topics.
- No years, authors, paper titles, version numbers or item numbers; case names (e.g. EchoLeak) are fine as memory cues.

## Checking it

`python server.py --check` warns about pages or knowledge points that can't be found, knowledge points missing from the map, knowledge points that appear more than once, and lines that are not list items. There must be no such warnings; `python server.py --outline` shows the node count.
