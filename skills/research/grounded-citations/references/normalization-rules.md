# Normalization rules

The reference for `scripts/verify_quote.py`. The rules are enumerated here, in the script's module docstring, and in `SKILL.md`. All three must agree; if you change one, change all three and update `scripts/test_verify_quote.py`.

## The design constraint

A quote matcher has two failure directions and they pull against each other.

- **Too strict** — a quote that is genuinely on the page comes back absent because the page wrapped the line, or used a curly apostrophe, or the CMS injected a zero-width space. Everything becomes unverifiable, the tool gets ignored, and citations go back to being asserted.
- **Too loose** — a paraphrase comes back verified. This is the worse failure by a wide margin: it puts quotation marks around words the source never wrote and attaches a locator that makes it look checked.

The resolution is that normalization is a **defined, enumerated transform**, not a similarity score. Every rule below removes a difference in *rendering*. No rule removes a difference in *wording*. That line is what keeps the tool honest in both directions.

Similarity is computed exactly once, for the near-miss hint on an `absent` result, and it never decides a status. A paraphrase scoring 0.97 is still `absent`.

## Rules applied to both sides

Order matters — this is the order the script applies them.

### 1. Unicode NFC

Canonical composition. `e` + U+0301 COMBINING ACUTE becomes `é`.

NFKC is deliberately **not** used. NFKC is a compatibility fold: it turns `ﬁ` into `fi`, `²` into `2`, full-width `Ａ` into `A`. Those are real differences in a quoted source — a superscript footnote marker folded into a digit changes the text.

Offsets are reported into the NFC-normalized source. When NFC changes nothing (the overwhelmingly common case) that is the raw source, and the report says `offset basis: raw source`. When NFC does change something the report says `offset basis: NFC-normalized source`.

### 2. Zero-width deletion

Deleted entirely: U+200B ZWSP, U+200C ZWNJ, U+200D ZWJ, U+2060 WORD JOINER, U+FEFF BOM.

These are invisible. CMSes inject them as soft line-break hints, and they survive copy-paste. A quote that differs from the source only by an invisible character is the same quote.

### 3. Typographic quotes and primes

| From | To |
|---|---|
| `‘` U+2018, `’` U+2019, `‚` U+201A, `‛` U+201B, `′` U+2032 | `'` |
| `“` U+201C, `”` U+201D, `„` U+201E, `‟` U+201F, `″` U+2033, `«` U+00AB, `»` U+00BB | `"` |

Smart-quote substitution is applied by the publishing pipeline, not the author. A quote typed with straight quotes and a page rendered with curly ones are the same words.

Not included: the backtick `` ` `` and the acute accent `´`. Both are sometimes used as apostrophes in scraped text, but the backtick is load-bearing in code samples and the acute is a diacritic. Mapping them would risk collapsing distinctions that matter.

### 4. Dash variants

U+2010 HYPHEN, U+2011 NON-BREAKING HYPHEN, U+2012 FIGURE DASH, U+2013 EN DASH, U+2014 EM DASH, U+2015 HORIZONTAL BAR, U+2043 HYPHEN BULLET, U+2212 MINUS SIGN → ASCII `-`.

Same rationale: which dash a typesetter used is not part of the wording.

### 5. Ellipsis

`…` U+2026 expands to `...`, then any run of three or more `.` collapses to exactly three. `....` and `.....` both become `...`.

### 6. Whitespace collapse

Every run of characters for which Python's `str.isspace()` is true becomes a single ASCII space, and the ends are stripped. That covers space, tab, newline, carriage return, form feed, vertical tab, U+00A0 NBSP, U+2000–U+200A, U+202F, U+205F, and U+3000.

This is the rule that fires most often in practice, because pages wrap lines and quotes do not.

### 7. Case fold

`str.lower()`. Headline casing, small-caps rendering, and all-caps section headers are typesetting.

This is the loosest rule in the set and it is worth being clear about the cost: it means `"the Bank refused"` matches a source reading `"The bank refused"`. That is the right call for prose quotation, where casing follows position in a sentence. If a future use case needs case-sensitive matching (code, identifiers, proper-noun disambiguation), that is a new flag, not a change to the default.

## Rules applied to the quote only

These strip markup added by the person quoting. They are reported in the result under `quote_only_trims` whenever they fire.

### 8. Outer quotation marks

One matching pair of outer ASCII `"` or `'` is removed, repeatedly while a pair remains. The delimiters belong to the quoter.

This rule can only widen a match, never invent one: the trimmed quote is a substring of the untrimmed one.

### 9. Leading and trailing ellipsis

A leading or trailing `...` is removed. It is the quoting author's truncation marker, not text in the source.

### Interior ellipsis is never removed

An interior `...` marks elided text. Removing it — or matching across it — would let a spliced quote pass:

> Source: "The margin held in June. Storage failed in July. The margin held again in August."
>
> Quote: "The margin held in June... The margin held again in August."

Splicing across the elision hides "Storage failed in July". The matcher does not do it. When a quote's normalized form contains an interior `...`, the result carries a note saying to verify segment by segment. Split the quote at the ellipsis, verify each segment, and report each locator so the reader can see what was elided.

Note that a *source* containing a literal `…` is matched normally — rule 5 expands it on both sides, so a quote reproducing the source's own ellipsis matches.

## Deliberately not rules

Each of these would let a paraphrase pass as a quote:

- **Punctuation stripping.** `"we will not proceed"` and `"we will, not proceed"` are different sentences.
- **Stopword removal.** Dropping `not`, `no`, `never` inverts meaning.
- **Stemming or lemmatization.** `"the bank failed"` and `"the banks fail"` are different claims.
- **Synonym or number folding.** `"eleven percent"` is not `"11%"`. If the source wrote one and the quote the other, quote the source's form.
- **A similarity threshold.** Any threshold has a value at which a paraphrase certifies. There is no such threshold in the status decision.

## Adding a rule

If a real quote is failing to match and no existing rule covers it:

1. Confirm the difference is in rendering, not wording. If any reader would call it a different sentence, it is wording — the answer is `absent`, not a new rule.
2. Add it to all three places: the script's rule table and docstring, this file, and the `SKILL.md` table.
3. Add a case to `scripts/test_verify_quote.py` in **both** directions — one quote that should now match, and one paraphrase that must still be `absent`.
4. The staged pipeline in `describe_differences` must stay equivalent to the char-wise pipeline in `_normalize_pairs`; the test suite asserts this over every fixture.
