# Content standards

What good knowledge points, questions and explanations look like, in any topic. The mind map has its own standards in [mind-map.md](mind-map.md).

## Language

- Write in the language of the user's request. If the user says the interview or exam will be in a particular language, write in that language. A topic stays in one language: when you add to an existing topic, keep the language it is written in unless the user asks otherwise.
- **When the content is not in English, put the English term in parentheses after every core term**, e.g. in Chinese `梯度（gradient）`, `线性无关（linearly independent）`. Annotate the term's first occurrence in every knowledge point, even when an earlier knowledge point already annotated it; later occurrences within the same knowledge point may use the term alone, or the English term or abbreviation directly. Core terms are the concepts, methods and theorem names that the knowledge point explains; everyday words and words that are already English need no annotation. Core terms in stems, options and explanations that the body hasn't annotated get annotated too. Take the English term from the source; without a source, use the established industry term; don't coin translations.
- English content needs no annotations.
- Book and course topics keep the source's terminology and notation (the book's variable names, the slides' symbols).

## Knowledge points

- Open with one or two sentences that state the conclusion or definition directly — something that could be the first sentence of an interview or exam answer.
- Then expand as needed: principle and mechanism → comparison and trade-offs (tables work well) → practice and examples (code, configuration, real scenarios) → common pitfalls.
- For knowledge points that interviews or exams often ask about, end with a blockquote `> Interview answer:` (job topics) or `> Recap:` (book and course topics), with the label written in the content's language, giving the points you could say in 30 seconds.
- Length: mostly 100–350 words (150–500 characters in Chinese); complex subjects up to about 550 words (800 characters). Anything longer gets split into two knowledge points.
- Knowledge point titles are short and specific (usually at most about 6 words, or 16 Chinese characters).
- No filler or transition sentences (e.g. "This section introduces…"), no historical anecdotes that don't help learning.
- Use your own words. Quote a book or slides only for the key sentence or two, with the source named; don't copy whole paragraphs.
- Within one topic, each knowledge point is written once; content that overlaps other topics is written as usual, with in-site links to deeper coverage in another topic where useful.

## Questions

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

## Explanations

- First explain why the answer is right, then where the main distractors go wrong; usually 40–100 words (50–150 Chinese characters).
- Refer to options by their content, never "pick B" or "option A" (options are shuffled).

## Accuracy

- Write only what you are sure of. For fast-moving areas (models, framework versions, standards such as the OWASP Top 10 for LLM Applications), verify online if you can and state the version or year; don't present what you can't verify as fact.
- Book and course topics follow the source; when the source disagrees with industry consensus, follow the source and note the difference in the knowledge point or explanation.
- Don't invent numbers, papers, links, product features, chapters or page numbers.
- Use the same term for the same concept across the whole site.

## Self-review

After writing or changing a page, read all of its questions and confirm for each one that the answer is unique and sound, the distractors come from real misconceptions, the stem doesn't give the answer away, nothing depends on option positions, and it is not a recall question. Then check that the page's correct answers are spread across positions and that multiple-answer questions make up 25%–40%.
