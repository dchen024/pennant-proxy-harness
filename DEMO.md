# Demo script (about 3 minutes)

**0:00 The problem (15s).** Institutional investors vote thousands of proxies against their own voting policy. The facts come from dense filings, and a wrong number read from the wrong table, the wrong year or the wrong person silently flips a vote. The goal is not a chatbot. It is a pipeline where every number traces to its source and every error traces to the step that caused it.

**0:15 Policy → rules (20s), `/policy`.** A written voting policy compiled into expression trees over 14 facts. The model extracts facts; code casts the vote with three-valued logic, so a missing fact means REVIEW, not a guess. (Opus 5.5 compiled this policy text into trees that agree with the hand-written ones on 100% of 2,000 random fact combinations.)

**0:35 One fact, fully traced (30s), `/runs/<demo run>`.** Click a cell in the JPMorgan row, CEO total pay:
- the value, the verbatim quote, and the exact lines highlighted on page 76 of the PDF
- the checks, all done in code: the quote is in that chunk, and the value is in that quote
- the trap: JPM also has its own "annual compensation" table showing **$43.0M**. The SEC Summary Compensation Table says **$40,632,724**. Which models read the wrong table?

**1:05 Leaderboard (30s), `/`.** Six models, same retrieved context, same prompt. Show accuracy, **consequential errors** (errors that flip a vote), votes correct, citation validity, cost per filing and the cost/accuracy frontier. Then **reading only**: each model is handed the verified passage. Every model reads correctly (98.6%, except Luna at 97.1%), so the remaining gap is search, not the model. Opus and Sol tie at 94.3% on the full pipeline; DeepSeek is within one fact at 1/20th of the cost.

**1:35 What was wrong, how we found it, what we changed (45s).** README "Results":
1. Attribution showed 17 of 18 dev-run errors were **retrieval**, not reading.
2. Root cause: a table's title ("Summary compensation table") lands in a different chunk from its rows.
3. Fix: chunks carry their preceding headings (parser v3). **Recall@8 went from 67.6% to 82.4%, then 85.3% with hybrid Atlas Search + Vector Search.** Luna's accuracy went from 74% to 89%, and its correct votes from 9/15 to 13/15.
4. Both fixes target the same root cause, so they overlap. We measured that instead of stacking them blindly.

**2:20 The answer key (25s), `/review`.** Two models outside the comparison draft answers; a human verifies each against the highlighted source, fixes citations with the editor, and reviews a page at a time. Two lessons: model agreement isn't correctness (both drafters called JPM pay "not disclosed"), and absence is an answer (no sunset provision, no "other fees" row).

**2:45 MongoDB (15s).** Atlas holds filings, page-anchored chunks, Voyage embeddings, the Vector Search and Atlas Search indexes, both parser versions side by side, the cached retrievals that keep comparisons fair, every run and result, and the answer key. Grading is separate from inference, so re-grading is free.
