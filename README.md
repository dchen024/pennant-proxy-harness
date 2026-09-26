# Proxy Harness

An evaluation harness for applying an institutional investor's **proxy-voting policy** to company **proxy statements (SEC DEF 14A)** with LLMs, built so that every number traces back to the exact place in the PDF it came from, and every wrong vote can be traced to the step that caused it.

Built at the MongoDB "Harness Engineering & Model Wrangling" hackathon (NYC, Sept 2026).

## How it works

```
EDGAR DEF 14A ──► PDF ──► page-anchored chunks ──► Voyage embeddings ──► MongoDB Atlas Vector Search
                          (every line keeps its bbox)                           │
voting policy text ──► boolean expression tree (per ballot item)                │ top-k per fact
                                   │                                            ▼
                                   │                 extraction model (any OpenRouter model)
                                   │                 → { value, chunk_id, verbatim quote, fiscal_year }
                                   │                                            │
                                   │                 deterministic checks: quote ∈ chunk? value ∈ quote?
                                   ▼                                            ▼
                     votes computed in code  ◄──────────────  facts
```

- **The model never casts the vote.** It only extracts the facts the policy needs. The policy is compiled into expression trees, and code evaluates them with three-valued logic, so a missing fact yields REVIEW instead of a guess.
- **Citations are checked without a model.** Every answer must cite one chunk and quote it verbatim. Code verifies that the quote is actually in that chunk and that the value is actually in the quote (allowing for tables stated in thousands or millions). The UI highlights the exact lines on the PDF page.
- **Errors are attributed to the first stage that failed**, using the human-verified answer key:

  | stage | meaning |
  |---|---|
  | `parse` | the correct evidence isn't in any parsed chunk (the parser lost it) |
  | `retrieval` | the evidence exists but wasn't in the chunks given to the model |
  | `extraction` | the evidence was in context and the model read it wrong (wrong period, row or units) |
  | `citation` | the value is right but the quote doesn't support it |
  | `format` / `api` | malformed output after one repair retry / provider error |

- **Consequential errors.** A wrong fact counts as consequential only if substituting the correct value changes a vote. The headline metric is consequential errors, not raw accuracy.
- **Fair model comparison.** Retrieval is cached per company × fact, so every model sees identical context. **Reading-only** mode (called `oracle` in code) hands each model the human-verified evidence passage directly, and the gap to the **full pipeline** is retrieval's share of the error.
- **Answer key.** Two strong models that are *not* in the comparison draft answers (agreements are marked `proposed`, disagreements `disputed`), and a human verifies every one in `/review` against the highlighted source. The key is exported to `data/gold/gold.json` so it outlives the database.

## Next steps

- **Is the item on the ballot?** Meta holds say-on-pay every three years and has none on its 2026 ballot, yet the policy currently produces a say-on-pay vote for every company. A per-item "on the ballot" fact would yield "not on ballot".
- **Multiple evidence passages per answer.** Derived values need more than one span, e.g. "12 nominees" plus "all but the CEO are independent", or JPMorgan's $0 other fees proven by rows that sum to the total. The answer key and reading-only mode should accept several passages.
- **Images.** Only the text layer is read today. Vision-model captions stored as page-anchored "image" chunks would make charts and infographics searchable, and tables published as images need a vision fallback.
- **Table serialization.** Column-aligned Markdown tables with explicit empty cells, measured as a controlled experiment on extraction-stage errors (so far there has been only one).
- **Jev as a classifier.** TypeSafe's Jev (via OpenRouter) for cheap, calibrated yes/no checks such as "does this passage state that the CEO chairs the board?", scored against the human-verified key.
- **Keyword-search regression.** On JPMorgan, keyword search ranks fee *descriptions* above the fee *table*. Field boosts or table-aware scoring should fix it.

## Stack

TypeScript end to end: Next.js 16, MongoDB Atlas (documents, chunks, vectors, runs, results, answer key), Voyage `voyage-4` embeddings and all models via OpenRouter, pdf.js for parsing (the same version react-pdf uses to render, so boxes line up), LangSmith tracing, and vitest for the deterministic parts.

## Run it

```bash
cp .env.example .env        # OPENROUTER_API_KEY, MONGODB_URI, SEC_USER_AGENT (+ optional LangSmith)
pnpm install
pnpm pipeline               # fetch filings → parse + embed + index → draft answer key
pnpm dev                    # verify answers at /review, then start runs from the leaderboard
pnpm harness --profile dev  # or run comparisons from the CLI (--profile demo, --models a,b, --modes e2e,oracle = full pipeline, reading only)
pnpm test                   # policy engine tests
```

Model line-ups live in `src/lib/config.ts` (`dev` = 2 cheap models, `demo` = 6 across Anthropic, OpenAI, Google and DeepSeek). Runs always pin exact model IDs, with no routers or "latest" aliases, so every result is attributable to one model.

## Results

All numbers are graded against the **fully human-verified answer key** (70 facts: 5 filings × 14 facts). Re-grading never re-calls a model.

### Six models, same retrieved context (parser v3, hybrid retrieval, prompt v2)

Each model answered every fact twice. **Full pipeline**: it sees the passages our search retrieved. **Reading only**: it is handed the human-verified evidence passage, so any error is about reading, not search.

| model | full pipeline | reading only | vote-flipping errors (full pipeline) | votes matching the key | cost per 5 filings |
|---|---|---|---|---|---|
| Claude Opus 5.5 | **94.3%** | 98.6% | 1 | 13/15 | $1.26 |
| GPT-6 Sol | **94.3%** | 98.6% | 1 | 13/15 | $0.51 |
| Claude Sonnet 5 | 92.9% | 98.6% | 1 | 13/15 | $0.63 |
| DeepSeek V4.1 Flash | 92.9% | 98.6% | 1 | 13/15 | **$0.065** |
| GPT-6 Luna | 91.4% | 97.1% | 0 | 13/15 | **$0.026** |
| Gemini 3.8 Flash | 91.4% | 98.6% | 0 | 13/15 | $0.38 |

- **Given the right passage, every model reads it correctly.** The one reading-only error all six share is a fact that needs two passages (see below). The single genuine misread came from the cheapest model, Luna, which read Meta's company TSR as the peer TSR (the wrong-column trap). It didn't change a vote.
- **Every other full-pipeline error is retrieval.** No model misread a passage it was given. The next gains come from search, not from a bigger model.
- **All vote mismatches are REVIEW, never a wrong FOR/AGAINST.** When a fact is missing, three-valued logic escalates the item to a human instead of guessing.
- **Decision-grade cost.** DeepSeek V4.1 Flash is within one fact of the best models, with the same votes, at about 1/20th of Opus's cost. GPT-6 Luna is within two facts at about 1/50th.
- **Caveat:** 70 facts is small. One fact moves accuracy by 1.4 points, so treat gaps under about 3 points as ties (Opus and Sol are tied at 66/70).

**A fact that needs two passages.** Apple's independent-nominee count is 7: "the Board's eight nominees" is on p. 65, and "all Board members, other than Mr. Cook, are independent" is on p. 18. Reading-only mode hands over one passage, so all six models correctly refuse to guess. This is the case for multi-passage evidence (see Next steps).

**Reference votes from the answer key:** Alphabet and Meta get AGAINST on the nominating/governance chair (R3: unequal voting rights with no sunset), and Microsoft gets AGAINST on say-on-pay (R4: CEO pay rose from $79.1M to $96.5M while TSR of 255 trailed the peer group's 276). Everything else is FOR.

### What was wrong, how we found it, what we changed

**1. The harness said retrieval, not reading, was the problem.** The first dev run (GPT-6 Luna on 5 filings × 14 facts) got 74% of facts right. Error attribution put **17 of its 18 wrong facts in `retrieval`**: the model never saw the evidence. Only one was a misread. The obvious move would have been to tweak the prompt or reformat tables; the attribution said otherwise.

**2. Root cause: a table's title lands in a different chunk from its numbers.** In JPMorgan's proxy, chunk `p76:0` holds the heading "I. Summary compensation table (SCT)" and chunk `p76:1` holds the rows. Search found the heading and missed the table. The same pattern hid the pay-versus-performance TSR table at four of the five companies.

**3. Fix (parser v3): each chunk carries the heading lines that precede it.** The heading is embedded with the chunk and shown to the model as context, but never counted as a quotable part of the chunk. Parser versions live side by side in MongoDB, so the before/after changes nothing but the parser.

| retrieval recall@8 (68 facts, measured before the final review) | vector only | hybrid (Atlas Search + Vector Search, RRF) |
|---|---|---|
| parser v2 | 67.6% | 80.9% |
| parser v3 (heading context) | 82.4% | **85.3%** |

Both fixes attack the same root cause, so they overlap. Hybrid search alone recovers 13 points on the old parser but adds only 3 on top of the parser fix.

| end to end, vs. the verified key (same model, prompt and checker) | v2 | v3 |
|---|---|---|
| GPT-6 Luna accuracy | 74.3% | **88.6%** |
| Luna consequential errors (flip a vote) | 4 | **1** |
| Luna votes matching the key | 9/15 | **13/15** |

(Gemini 3.8 Flash's v3 dev run is excluded: five of its answers were cut off by the output budget, a harness bug fixed before the final run.)

**Harness bugs the dev runs caught before the full comparison:**
- The citation checker rejected numbers written as words ("the Board's eight nominees").
- It failed counts a model derived ("all nominees other than the CEO"), which are now marked *not checkable* rather than wrong.
- Gemini's JSON was truncated because reasoning tokens ate a 1,200-token output budget; the budget is now 4,096 for every model.
- Symbol-font checkmarks (Wingdings `U+F0FC`) hid Meta's "Independent" column from every model.

### Traps worth knowing about in real filings

- **Wrong table.** JPMorgan reports Jamie Dimon's 2025 pay twice. Its own "annual compensation" table says **$43,000,000**; the SEC Summary Compensation Table says **$40,632,724**. Only the second is the regulatory number.
- **Agreement is not correctness.** Both answer-key drafting models agreed JPMorgan's pay facts were "not disclosed". Neither had been shown the right table. A human caught it.
- **Absence is an answer.** No sunset provision, no lead independent director, no "All Other Fees" row: there is nothing to quote. One drafting model returned `null`, the other inferred `false`/`0`. The spec now says how to answer and cite absence. JPMorgan's fee rows sum exactly to the total ($91.0M + $38.1M + $5.9M = $135.0M), which is the proof that the other-fees figure is $0.
