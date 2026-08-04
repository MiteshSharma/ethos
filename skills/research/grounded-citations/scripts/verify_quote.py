#!/usr/bin/env python3
"""Verify that a quoted span actually appears in a source text.

Stdlib-only — no pip dependencies required. The matcher answers one question
and only that question: does this exact span of text occur in this source?

Statuses
    exact       The quote occurs byte-identically in the raw source.
    normalized  The quote occurs after the enumerated normalization pipeline
                below was applied to BOTH sides. The report names every step
                that changed either text.
    absent      Not found. A best near-miss window is reported so a human can
                see whether the quote is a paraphrase or a fabrication.
    unverifiable  There was nothing to match against (empty quote, empty or
                unreachable source, or a source known to be a summary).

Citation classes
    verified      exact | normalized
    unverifiable  absent | unverifiable

    There is deliberately no `contradicted` class here. A string matcher can
    establish that a quote is absent; it cannot establish that a source asserts
    the opposite. Contradiction is a reading judgement made by the caller after
    reading the source. Reporting `absent` as `contradicted` is the exact
    failure this tool exists to prevent.

Normalization pipeline — applied in this order, to BOTH the quote and the
source, and to nothing else. These rules are load-bearing: too strict and every
real quote is unverifiable; too loose and paraphrases get certified as quotes.

    1. Unicode NFC (canonical composition). "e" + combining acute matches the
       precomposed "e-acute". NFC is canonical and does not fold ligatures,
       widths, or superscripts — NFKC would, and NFKC is deliberately NOT used.
    2. Zero-width characters are deleted: U+200B ZWSP, U+200C ZWNJ,
       U+200D ZWJ, U+2060 WORD JOINER, U+FEFF BOM.
    3. Typographic quotation marks and primes map to ASCII:
         ' U+2018  ' U+2019  ‚ U+201A  ‛ U+201B  ′ U+2032   ->  '
         " U+201C  " U+201D  „ U+201E  ‟ U+201F  ″ U+2033
         « U+00AB  » U+00BB                                 ->  "
    4. Dash variants map to ASCII hyphen "-":
         U+2010 U+2011 U+2012 U+2013 U+2014 U+2015 U+2043 U+2212
    5. U+2026 HORIZONTAL ELLIPSIS expands to "..."; any run of three or more
       "." collapses to exactly "...".
    6. Whitespace collapse: every run of characters for which Python's
       str.isspace() is true (space, tab, newline, CR, FF, VT, U+00A0 NBSP,
       U+2000-U+200A, U+202F, U+205F, U+3000) becomes a single ASCII space;
       leading and trailing whitespace is stripped.
    7. Case fold via str.lower().

Two further rules apply to the QUOTE ONLY, because they strip authorial
markup rather than source text. Both are reported when they fire:

    8. One matching pair of outer ASCII quotation marks is removed
       (the caller pasted the quote with its delimiters).
    9. A leading or trailing "..." (ellipsis) is removed — it marks truncation
       by the quoting author, not text present in the source.

    An INTERIOR "..." is never removed. An interior ellipsis marks elided
    text; matching across it would certify a spliced quote. Verify spliced
    quotes one segment at a time.

Explicitly NOT normalization rules, because each one would certify a
paraphrase as a quote: punctuation stripping, stopword removal, stemming,
synonym folding, and any similarity threshold. Similarity is computed for the
near-miss hint only and never decides a status.

Usage:
    python3 verify_quote.py --quote "some text" --source-file page.txt
    python3 verify_quote.py --quote-file q.txt --source-file - --json
    python3 verify_quote.py --quote "x" --source-file p.txt --source-kind summary

Exit codes:
    0  verified (exact or normalized)
    1  absent
    2  usage error (argparse)
    3  unverifiable
"""

import argparse
import difflib
import json
import re
import sys
import unicodedata

# --- Rule tables (see the pipeline description in the module docstring) ------

# Written as escapes on purpose — these characters are invisible in an editor.
ZERO_WIDTH = frozenset(chr(c) for c in (0x200B, 0x200C, 0x200D, 0x2060, 0xFEFF))

QUOTE_MAP = {
    "‘": "'",
    "’": "'",
    "‚": "'",
    "‛": "'",
    "′": "'",
    "“": '"',
    "”": '"',
    "„": '"',
    "‟": '"',
    "″": '"',
    "«": '"',
    "»": '"',
}

DASH_CHARS = frozenset("‐‑‒–—―⁃−")

ELLIPSIS = "…"

# Heuristic markers that a block of text is an aux-model summary rather than
# verbatim page text. Hint only — never changes a positive match, only adds a
# caveat to an `absent` result. See SKILL.md "The summarized-source hazard".
SUMMARY_MARKERS = (
    "summary:",
    "in summary,",
    "key points",
    "key takeaways",
    "main takeaways",
    "the article discusses",
    "the article describes",
    "the page describes",
    "the document outlines",
    "this document outlines",
    "the author argues",
    "the text explains",
)

STATUS_EXIT = {"exact": 0, "normalized": 0, "absent": 1, "unverifiable": 3}


# --- Normalization ----------------------------------------------------------


def _normalize_pairs(text: str) -> list[tuple[str, int]]:
    """Run rules 2-7 char by char, keeping each output char's source index."""
    out: list[tuple[str, int]] = []
    prev_space = True  # True at the start so leading whitespace is dropped
    for i, ch in enumerate(text):
        if ch in ZERO_WIDTH:  # rule 2
            continue
        if ch.isspace():  # rule 6
            if not prev_space:
                out.append((" ", i))
                prev_space = True
            continue
        prev_space = False
        if ch in QUOTE_MAP:  # rule 3
            out.append((QUOTE_MAP[ch], i))
        elif ch in DASH_CHARS:  # rule 4
            out.append(("-", i))
        elif ch == ELLIPSIS:  # rule 5
            out.extend((".", i) for _ in range(3))
        else:  # rule 7
            for sub in ch.lower():
                out.append((sub, i))
    while out and out[-1][0] == " ":  # rule 6, trailing strip
        out.pop()
    return out


def _collapse_dot_runs(pairs: list[tuple[str, int]]) -> list[tuple[str, int]]:
    """Rule 5, second half: any run of 3+ dots becomes exactly three dots."""
    out: list[tuple[str, int]] = []
    i = 0
    n = len(pairs)
    while i < n:
        if pairs[i][0] != ".":
            out.append(pairs[i])
            i += 1
            continue
        j = i
        while j < n and pairs[j][0] == ".":
            j += 1
        run = j - i
        out.extend(pairs[i : i + (3 if run >= 3 else run)])
        i = j
    return out


def normalize(text: str) -> tuple[str, list[int]]:
    """Normalize `text`, returning the result and a per-char source index map.

    The index map lets a match found in normalized space be reported against
    real offsets in the NFC-normalized source, so locators stay honest.
    """
    pairs = _collapse_dot_runs(_normalize_pairs(unicodedata.normalize("NFC", text)))
    return "".join(ch for ch, _ in pairs), [idx for _, idx in pairs]


def normalize_quote(quote: str) -> tuple[str, list[str]]:
    """Normalize a quote and apply the quote-only trims (rules 8-9)."""
    text, _ = normalize(quote)
    trims: list[str] = []
    changed = True
    while changed:
        changed = False
        if len(text) >= 2 and text[0] == text[-1] and text[0] in ("'", '"'):
            text = text[1:-1].strip()
            changed = True
            if "outer quotation marks removed" not in trims:
                trims.append("outer quotation marks removed")
        if text.startswith("..."):
            text = text[3:].lstrip()
            changed = True
            if "leading ellipsis removed" not in trims:
                trims.append("leading ellipsis removed")
        if text.endswith("..."):
            text = text[:-3].rstrip()
            changed = True
            if "trailing ellipsis removed" not in trims:
                trims.append("trailing ellipsis removed")
    return text, trims


# --- Staged pipeline, used only to explain what differed --------------------


def _stage_nfc(s: str) -> str:
    return unicodedata.normalize("NFC", s)


def _stage_zero_width(s: str) -> str:
    return "".join(ch for ch in s if ch not in ZERO_WIDTH)


def _stage_quotes(s: str) -> str:
    return "".join(QUOTE_MAP.get(ch, ch) for ch in s)


def _stage_dashes(s: str) -> str:
    return "".join("-" if ch in DASH_CHARS else ch for ch in s)


def _stage_ellipsis(s: str) -> str:
    return re.sub(r"\.{3,}", "...", s.replace(ELLIPSIS, "..."))


def _stage_whitespace(s: str) -> str:
    return " ".join(s.split())


def _stage_case(s: str) -> str:
    return s.lower()


STAGES = (
    ("unicode NFC", _stage_nfc),
    ("zero-width characters removed", _stage_zero_width),
    ("typographic quotes -> ASCII", _stage_quotes),
    ("dash variants -> '-'", _stage_dashes),
    ("ellipsis -> '...'", _stage_ellipsis),
    ("whitespace collapsed", _stage_whitespace),
    ("case folded", _stage_case),
)


def describe_differences(span: str, quote: str, trims: list[str]) -> dict:
    """Name the normalization steps that account for a non-exact match."""
    left, right = span, quote
    fired: list[tuple[int, str]] = []
    equal_after: str | None = None
    equal_at = len(STAGES) - 1
    for position, (name, fn) in enumerate(STAGES):
        new_left, new_right = fn(left), fn(right)
        if new_left != left or new_right != right:
            fired.append((position, name))
        left, right = new_left, new_right
        if equal_after is None and left == right:
            equal_after, equal_at = name, position
    if equal_after is None and trims:
        equal_after = "quote-only trims"
    # Report only the steps that ran before the two texts converged. A later
    # step that changed both texts identically did not account for anything.
    return {
        "steps_that_changed_text": [name for position, name in fired if position <= equal_at],
        "quote_only_trims": trims,
        "equal_after": equal_after,
    }


# --- Locators ---------------------------------------------------------------

HEADING_RE = re.compile(r"^ {0,3}#{1,6}\s+(.*\S)\s*$")


def locate(base: str, start: int, end: int, context: int) -> dict:
    """Build a human-usable locator for a matched span of `base`."""
    line_no = base.count("\n", 0, start) + 1
    paragraph = base.count("\n\n", 0, start) + 1
    heading = None
    for line in base[:start].splitlines():
        found = HEADING_RE.match(line)
        if found:
            heading = found.group(1)
    lead = max(0, start - context)
    tail = min(len(base), end + context)
    return {
        "char_offset": start,
        "char_end": end,
        "line": line_no,
        "paragraph_index": paragraph,
        "heading": heading,
        "matched_span": base[start:end],
        "context": ("..." if lead > 0 else "")
        + base[lead:tail]
        + ("..." if tail < len(base) else ""),
    }


# --- Near-miss --------------------------------------------------------------

WORD_RE = re.compile(r"[a-z0-9']{4,}")
MAX_ANCHORS = 5
MAX_OCCURRENCES = 20


def near_miss(nq: str, ns: str, index_map: list[int], base: str) -> dict | None:
    """Best-scoring same-length window of the source, for a human to eyeball.

    Similarity is a hint. It never decides a status — a paraphrase scoring 0.9
    is still `absent`.
    """
    if not nq or not ns:
        return None
    anchors = sorted(set(WORD_RE.findall(nq)), key=len, reverse=True)[:MAX_ANCHORS]
    starts: set[int] = set()
    for word in anchors:
        offset_in_quote = nq.find(word)
        for hit in list(re.finditer(re.escape(word), ns))[:MAX_OCCURRENCES]:
            starts.add(max(0, hit.start() - offset_in_quote))
    if not starts:
        return None
    best_start, best_ratio = 0, -1.0
    for start in sorted(starts):
        window = ns[start : start + len(nq)]
        ratio = difflib.SequenceMatcher(None, nq, window, autojunk=False).ratio()
        if ratio > best_ratio:
            best_start, best_ratio = start, ratio
    end = min(len(ns), best_start + len(nq))
    src_start = index_map[best_start]
    src_end = index_map[end - 1] + 1 if end > best_start else src_start
    quote_words = [w for w in WORD_RE.findall(nq) if w not in ns]
    return {
        "similarity": round(best_ratio, 3),
        "char_offset": src_start,
        "line": base.count("\n", 0, src_start) + 1,
        "source_text": base[src_start:src_end],
        "quote_words_absent_from_source": sorted(set(quote_words))[:8],
    }


# --- Summary detection ------------------------------------------------------


def looks_like_summary(text: str) -> bool:
    """Heuristic hint that `text` is an aux-model summary, not verbatim text."""
    head = text[:400].lower()
    if any(marker in head for marker in SUMMARY_MARKERS):
        return True
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    if len(lines) >= 4 and len(text) < 4000:
        bullets = sum(1 for ln in lines if ln[0] in "-*•" or re.match(r"^\d+[.)]\s", ln))
        if bullets / len(lines) > 0.6:
            return True
    return False


# --- Verification -----------------------------------------------------------


def _result(status: str, reason: str, **extra) -> dict:
    out = {
        "status": status,
        "citation_class": "verified" if status in ("exact", "normalized") else "unverifiable",
        "reason": reason,
        "locator": None,
        "normalization": None,
        "near_miss": None,
        "notes": [],
    }
    out.update(extra)
    return out


def verify(quote: str, source: str, source_kind: str = "unknown", context: int = 160) -> dict:
    """Check `quote` against `source`. See the module docstring for statuses."""
    summary_suspected = bool(source.strip()) and looks_like_summary(source)
    common = {"source_kind": source_kind, "summary_suspected": summary_suspected}

    if not quote.strip():
        return _result("unverifiable", "the quote is empty — nothing to check", **common)
    if not source.strip():
        return _result(
            "unverifiable",
            "the source text is empty or could not be retrieved — nothing to match "
            "against. This is unverifiable, NOT contradicted.",
            **common,
        )
    if source_kind == "summary":
        return _result(
            "unverifiable",
            "the source text is a summary, not verbatim page text — a verbatim quote "
            "cannot be checked against it. Refetch the verbatim source. This is "
            "unverifiable, NOT contradicted.",
            **common,
        )

    base = unicodedata.normalize("NFC", source)
    offset_basis = "raw source" if base == source else "NFC-normalized source"

    index = source.find(quote)
    if index >= 0:
        return _result(
            "exact",
            "the quote occurs byte-identically in the source",
            locator=locate(source, index, index + len(quote), context),
            offset_basis="raw source",
            **common,
        )

    nq, trims = normalize_quote(quote)
    if not nq:
        return _result(
            "unverifiable", "the quote is empty after normalization — nothing to check", **common
        )

    ns, index_map = normalize(base)
    notes: list[str] = []
    if len(nq) > 6 and "..." in nq[3:-3]:
        notes.append(
            "the quote contains an interior ellipsis; interior elisions are never "
            "stripped — verify spliced quotes one segment at a time"
        )

    found = ns.find(nq)
    if found >= 0:
        start = index_map[found]
        end = index_map[found + len(nq) - 1] + 1
        return _result(
            "normalized",
            "the quote occurs after normalization; the match is NOT byte-identical",
            locator=locate(base, start, end, context),
            normalization=describe_differences(base[start:end], quote, trims),
            offset_basis=offset_basis,
            notes=notes,
            **common,
        )

    if summary_suspected:
        notes.append(
            "the source text looks like a summary rather than verbatim page text; "
            "a missing quote here is weak evidence — refetch the verbatim source"
        )
    return _result(
        "absent",
        "the quote does not occur in this source, byte-identically or after "
        "normalization. Absent is NOT contradicted: it means this source does not "
        "contain this span, not that the source asserts otherwise.",
        near_miss=near_miss(nq, ns, index_map, base),
        offset_basis=offset_basis,
        notes=notes,
        **common,
    )


# --- Reporting --------------------------------------------------------------


def _clip(text: str, limit: int = 300) -> str:
    flat = " ".join(text.split())
    return flat if len(flat) <= limit else flat[:limit] + " ..."


def render_text(result: dict) -> str:
    lines = [
        f"STATUS:         {result['status']}",
        f"CITATION CLASS: {result['citation_class']}",
        f"REASON:         {result['reason']}",
    ]
    loc = result.get("locator")
    if loc:
        lines.append("")
        lines.append("LOCATOR")
        lines.append(f"  char offset:     {loc['char_offset']}-{loc['char_end']}")
        lines.append(f"  line:            {loc['line']}")
        lines.append(f"  paragraph index: {loc['paragraph_index']}")
        lines.append(f"  heading:         {loc['heading'] or '(none found)'}")
        lines.append(f"  offset basis:    {result.get('offset_basis', 'raw source')}")
        lines.append(f"  matched span:    {_clip(loc['matched_span'])}")
    norm = result.get("normalization")
    if norm:
        lines.append("")
        lines.append("NORMALIZED MATCH — the quote is not byte-identical to the source.")
        steps = norm["steps_that_changed_text"] or ["(none)"]
        lines.append(f"  steps that changed text: {', '.join(steps)}")
        if norm["quote_only_trims"]:
            lines.append(f"  quote-only trims:        {', '.join(norm['quote_only_trims'])}")
        lines.append(f"  equal after:             {norm['equal_after'] or '(never equal)'}")
    miss = result.get("near_miss")
    if miss:
        lines.append("")
        lines.append("NEAREST SOURCE TEXT (similarity is a hint, not a verdict)")
        lines.append(f"  similarity:  {miss['similarity']}")
        lines.append(f"  char offset: {miss['char_offset']}")
        lines.append(f"  line:        {miss['line']}")
        lines.append(f"  source says: {_clip(miss['source_text'])}")
        if miss["quote_words_absent_from_source"]:
            lines.append(
                f"  quote words absent from source: "
                f"{', '.join(miss['quote_words_absent_from_source'])}"
            )
    elif result["status"] == "absent":
        lines.append("")
        lines.append(
            "NEAREST SOURCE TEXT: none — the quote shares no vocabulary with the source."
        )
    if result.get("summary_suspected"):
        lines.append("")
        lines.append("WARNING: the source text looks like a summary, not verbatim page text.")
    for note in result.get("notes", []):
        lines.append(f"NOTE: {note}")
    return "\n".join(lines)


def read_text_file(path: str, label: str) -> str:
    """Read a UTF-8 file ('-' means stdin). An unreadable file yields '', which
    the caller turns into an `unverifiable` result rather than a crash."""
    if path == "-":
        return sys.stdin.read()
    try:
        with open(path, encoding="utf-8", errors="replace") as handle:
            return handle.read()
    except OSError as exc:
        print(f"Cannot read {label} file: {exc}", file=sys.stderr)
        return ""


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Verify that a quoted span actually appears in a source text.",
        epilog='Example: python3 verify_quote.py --quote "the exact words" --source-file page.txt',
    )
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--quote", help="The quoted span to verify")
    group.add_argument("--quote-file", help="File containing the quoted span")
    parser.add_argument(
        "--source-file",
        required=True,
        help="File containing the source text ('-' for stdin)",
    )
    parser.add_argument(
        "--source-kind",
        choices=("verbatim", "summary", "unknown"),
        default="unknown",
        help="Whether the source text is verbatim page text or a summary (default: unknown)",
    )
    parser.add_argument(
        "--context",
        type=int,
        default=160,
        help="Characters of context to show around a match (default: 160)",
    )
    parser.add_argument("--json", action="store_true", help="Emit JSON instead of a text report")
    args = parser.parse_args()

    if args.quote_file:
        quote = read_text_file(args.quote_file, "quote")
    else:
        quote = args.quote

    source = read_text_file(args.source_file, "source")
    result = verify(quote, source, args.source_kind, args.context)

    if args.json:
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        print(render_text(result))

    sys.exit(STATUS_EXIT[result["status"]])


if __name__ == "__main__":
    main()
