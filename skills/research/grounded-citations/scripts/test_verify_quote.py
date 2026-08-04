#!/usr/bin/env python3
"""Tests for verify_quote.py — no pytest, no pip dependencies.

Run from the skill directory:

    python3 scripts/test_verify_quote.py

Exits 0 when every check passes, 1 otherwise. Every acceptance criterion for
the grounded-citations skill has a named check below.
"""

import subprocess
import sys
import tempfile
from pathlib import Path

sys.dont_write_bytecode = True  # keep __pycache__ out of the skill directory
sys.path.insert(0, str(Path(__file__).resolve().parent))

import verify_quote as vq  # noqa: E402

SCRIPT = Path(__file__).resolve().parent / "verify_quote.py"
FIXTURES = Path(__file__).resolve().parent.parent / "references" / "fixtures"

PLAIN = (FIXTURES / "page-plain.txt").read_text(encoding="utf-8")
TYPO = (FIXTURES / "page-typographic.txt").read_text(encoding="utf-8")
SUMMARIZED = (FIXTURES / "page-summarized-extract.txt").read_text(encoding="utf-8")

FAILURES: list[str] = []
CHECKS = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global CHECKS
    CHECKS += 1
    if condition:
        print(f"  ok   {name}")
    else:
        print(f"  FAIL {name}{(' — ' + detail) if detail else ''}")
        FAILURES.append(name)


def section(title: str) -> None:
    print(f"\n{title}")


# --- Acceptance: verbatim quote -> exact, locator populated -----------------

section("verbatim quote classifies as exact with a populated locator")

quote = "Peak regional demand reached 41.2 gigawatts on 14 August 2031."
result = vq.verify(quote, PLAIN)
check("status is exact", result["status"] == "exact", result["status"])
check("citation class is verified", result["citation_class"] == "verified")
check("locator present", result["locator"] is not None)
if result["locator"]:
    loc = result["locator"]
    span = PLAIN[loc["char_offset"] : loc["char_end"]]
    check("locator offsets slice back to the quote", span == quote)
    check("locator carries a line number", loc["line"] > 1, str(loc["line"]))
    check("locator carries a paragraph index", loc["paragraph_index"] >= 1)
    check("locator resolves the nearest heading", loc["heading"] == "Summary", str(loc["heading"]))
check("text report names the status", "STATUS:         exact" in vq.render_text(result))


# --- Acceptance: absent quote is never verified -----------------------------

section("a quote that is not in the source is absent, never verified")

fabricated = "Peak regional demand reached 58.6 gigawatts on 14 August 2031."
result = vq.verify(fabricated, PLAIN)
check("status is absent", result["status"] == "absent", result["status"])
check("citation class is unverifiable", result["citation_class"] == "unverifiable")
check("never reported as verified", result["citation_class"] != "verified")
check("reason says absent is not contradicted", "NOT contradicted" in result["reason"])
check("near miss is reported", result["near_miss"] is not None)
if result["near_miss"]:
    check("near miss points at the real sentence", "41.2" in result["near_miss"]["source_text"])
    check("near miss carries a similarity hint", 0.0 < result["near_miss"]["similarity"] <= 1.0)


# --- Acceptance: whitespace-only difference -> normalized -------------------

section("a quote differing only by line wrapping is a normalized match")

wrapped = (
    "The interconnect absorbed the surge without load shedding, "
    "and the reserve margin never fell below eleven percent."
)
result = vq.verify(wrapped, PLAIN)
check("status is normalized", result["status"] == "normalized", result["status"])
check("citation class is verified", result["citation_class"] == "verified")
check("reason says the match is not byte-identical", "NOT byte-identical" in result["reason"])
steps = (result["normalization"] or {}).get("steps_that_changed_text", [])
check("whitespace collapse is named", "whitespace collapsed" in steps, str(steps))
report = vq.render_text(result)
check("report announces the normalized match", "NORMALIZED MATCH" in report)
check("report lists the steps", "whitespace collapsed" in report)
if result["locator"]:
    span = PLAIN[result["locator"]["char_offset"] : result["locator"]["char_end"]]
    check(
        "locator span normalizes to the quote",
        vq.normalize(span)[0] == vq.normalize_quote(wrapped)[0],
    )


# --- Acceptance: smart quotes -> normalized ---------------------------------

section("a quote differing only by typographic quotes is a normalized match")

smart = 'The operator called the event "a stress test we did not choose"'
result = vq.verify(smart, TYPO)
check("status is normalized", result["status"] == "normalized", result["status"])
steps = (result["normalization"] or {}).get("steps_that_changed_text", [])
check("typographic quote mapping is named", "typographic quotes -> ASCII" in steps, str(steps))
check("report says so", "typographic quotes -> ASCII" in vq.render_text(result))


# --- Acceptance: trailing ellipsis -> normalized ----------------------------

section("a quote differing only by a trailing ellipsis is a normalized match")

for trailing in (
    "reserve margin never fell below eleven percent...",
    "reserve margin never fell below eleven percent…",
):
    result = vq.verify(trailing, PLAIN)
    label = "unicode" if "…" in trailing else "ascii"
    check(
        f"status is normalized ({label} ellipsis)",
        result["status"] == "normalized",
        result["status"],
    )
    trims = (result["normalization"] or {}).get("quote_only_trims", [])
    check(
        f"trailing ellipsis trim is reported ({label})",
        "trailing ellipsis removed" in trims,
        str(trims),
    )
    check(f"report says so ({label})", "trailing ellipsis removed" in vq.render_text(result))


# --- Normalization: the remaining enumerated rules --------------------------

section("each enumerated normalization rule is exercised")

result = vq.verify("Regional Grid Reliability Report 2031", TYPO)
check(
    "zero-width removal yields a normalized match",
    result["status"] == "normalized",
    result["status"],
)
steps = (result["normalization"] or {}).get("steps_that_changed_text", [])
check("zero-width removal is named", "zero-width characters removed" in steps, str(steps))

result = vq.verify(
    "a stress test we did not choose\" - and noted that reserves held throughout.", TYPO
)
check(
    "dash variant yields a normalized match",
    result["status"] == "normalized",
    result["status"],
)
steps = (result["normalization"] or {}).get("steps_that_changed_text", [])
check("dash mapping is named", "dash variants -> '-'" in steps, str(steps))

result = vq.verify(
    "THE INTERCONNECT ABSORBED THE SURGE WITHOUT LOAD SHEDDING, AND THE RESERVE MARGIN", TYPO
)
check(
    "case difference yields a normalized match",
    result["status"] == "normalized",
    result["status"],
)
steps = (result["normalization"] or {}).get("steps_that_changed_text", [])
check("case folding is named", "case folded" in steps, str(steps))

result = vq.verify("and the reserve margin never fell below eleven percent", TYPO)
check(
    "non-breaking and repeated spaces yield a normalized match",
    result["status"] == "normalized",
    result["status"],
)

result = vq.verify('"a stress test we did not choose"', TYPO)
check(
    "outer quotation marks are trimmed off the quote",
    result["status"] == "normalized",
    result["status"],
)
trims = (result["normalization"] or {}).get("quote_only_trims", [])
check("the outer-quote trim is reported", "outer quotation marks removed" in trims, str(trims))

interior = "the figures are provisional...and will be revised at settlement."
result = vq.verify(interior, TYPO)
check(
    "an interior ellipsis still matches the source's own ellipsis",
    result["status"] == "normalized",
)
check(
    "an interior ellipsis raises a splice note",
    any("interior ellipsis" in note for note in result["notes"]),
    str(result["notes"]),
)


# --- Acceptance: a paraphrase is absent, not normalized ---------------------

section("a paraphrase is absent with a near miss, never normalized")

paraphrase = "The interconnect handled the spike without shedding any load."
result = vq.verify(paraphrase, PLAIN)
check("status is absent", result["status"] == "absent", result["status"])
check("status is not normalized", result["status"] != "normalized")
check("citation class is unverifiable", result["citation_class"] == "unverifiable")
check("near miss is reported", result["near_miss"] is not None)
if result["near_miss"]:
    check(
        "near miss shows the source wording",
        "absorbed the surge" in result["near_miss"]["source_text"],
        result["near_miss"]["source_text"],
    )
    check(
        "near miss names words the source does not contain",
        "handled" in result["near_miss"]["quote_words_absent_from_source"],
        str(result["near_miss"]["quote_words_absent_from_source"]),
    )
    check(
        "high similarity does not promote a paraphrase",
        result["near_miss"]["similarity"] > 0.5 and result["status"] == "absent",
        str(result["near_miss"]["similarity"]),
    )

close_paraphrase = "The interconnect absorbed the surge without any load shedding at all."
result = vq.verify(close_paraphrase, PLAIN)
check(
    "a near-identical paraphrase is still absent",
    result["status"] == "absent",
    result["status"],
)


# --- Acceptance: unreachable / empty source is unverifiable ----------------

section("an unreachable or empty source is unverifiable, not contradicted")

for label, source in (("empty string", ""), ("whitespace only", "   \n\t  \n")):
    result = vq.verify(quote, source)
    check(
        f"status is unverifiable ({label})", result["status"] == "unverifiable", result["status"]
    )
    check(f"citation class is unverifiable ({label})", result["citation_class"] == "unverifiable")
    check(f"reason says not contradicted ({label})", "NOT contradicted" in result["reason"])

result = vq.verify("", PLAIN)
check("an empty quote is unverifiable", result["status"] == "unverifiable", result["status"])

check(
    "the matcher never emits a contradicted class",
    "contradicted"
    not in {
        vq.verify(q, s)["citation_class"]
        for q in (quote, fabricated, paraphrase, "")
        for s in (PLAIN, TYPO, SUMMARIZED, "")
    },
)


# --- Acceptance: the summarized-source hazard ------------------------------

section("a summarized source cannot falsify a quote")

result = vq.verify(quote, PLAIN, source_kind="summary")
check(
    "a declared summary is unverifiable", result["status"] == "unverifiable", result["status"]
)
check("citation class is unverifiable", result["citation_class"] == "unverifiable")
check("reason names the summary", "summary" in result["reason"])
check("reason says not contradicted", "NOT contradicted" in result["reason"])

check("the summarized fixture is detected heuristically", vq.looks_like_summary(SUMMARIZED))
check("the verbatim fixture is not flagged", not vq.looks_like_summary(PLAIN))
check("the typographic fixture is not flagged", not vq.looks_like_summary(TYPO))

result = vq.verify(quote, SUMMARIZED)
check(
    "an undeclared summary still reports absent", result["status"] == "absent", result["status"]
)
check("the summary suspicion is surfaced", result["summary_suspected"] is True)
check(
    "the report warns before the absence is trusted",
    "looks like a summary" in vq.render_text(result),
)


# --- Internal consistency ---------------------------------------------------

section("internal consistency")

for label, text in (("plain", PLAIN), ("typographic", TYPO), ("summarized", SUMMARIZED)):
    staged = text
    for _, stage in vq.STAGES:
        staged = stage(staged)
    check(
        f"staged pipeline equals the char-wise pipeline ({label})",
        staged == vq.normalize(text)[0],
    )
    normalized, index_map = vq.normalize(text)
    check(
        f"index map is one entry per normalized char ({label})",
        len(normalized) == len(index_map),
    )
    check(
        f"index map is non-decreasing and in range ({label})",
        all(0 <= i < len(text) for i in index_map)
        and all(a <= b for a, b in zip(index_map, index_map[1:])),
    )

check(
    "every status has an exit code",
    set(vq.STATUS_EXIT) == {"exact", "normalized", "absent", "unverifiable"},
)


# --- CLI ---------------------------------------------------------------------

section("command line interface")

proc = subprocess.run(
    [
        sys.executable,
        str(SCRIPT),
        "--quote",
        quote,
        "--source-file",
        str(FIXTURES / "page-plain.txt"),
    ],
    capture_output=True,
    text=True,
    check=False,
)
check("exact match exits 0", proc.returncode == 0, f"exit {proc.returncode}")
check("exact match prints the status", "STATUS:         exact" in proc.stdout, proc.stdout[:200])

proc = subprocess.run(
    [
        sys.executable,
        str(SCRIPT),
        "--quote",
        fabricated,
        "--source-file",
        str(FIXTURES / "page-plain.txt"),
        "--json",
    ],
    capture_output=True,
    text=True,
    check=False,
)
check("absent exits 1", proc.returncode == 1, f"exit {proc.returncode}")
check("json output is emitted", proc.stdout.lstrip().startswith("{"), proc.stdout[:120])

proc = subprocess.run(
    [sys.executable, str(SCRIPT), "--quote", quote, "--source-file", "/nonexistent/page.txt"],
    capture_output=True,
    text=True,
    check=False,
)
check(
    "an unreadable source exits 3 (unverifiable)", proc.returncode == 3, f"exit {proc.returncode}"
)
check("the unreadable source is explained on stderr", "Cannot read source file" in proc.stderr)

with tempfile.TemporaryDirectory() as tmp:
    quote_path = Path(tmp) / "quote.txt"
    quote_path.write_text(wrapped, encoding="utf-8")
    proc = subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            "--quote-file",
            str(quote_path),
            "--source-file",
            str(FIXTURES / "page-plain.txt"),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    check("--quote-file exits 0 on a normalized match", proc.returncode == 0, proc.stdout[:200])
    check("--quote-file reports the normalized status", "STATUS:         normalized" in proc.stdout)

proc = subprocess.run(
    [
        sys.executable,
        str(SCRIPT),
        "--quote",
        quote,
        "--source-file",
        str(FIXTURES / "page-summarized-extract.txt"),
        "--source-kind",
        "summary",
    ],
    capture_output=True,
    text=True,
    check=False,
)
check("a declared summary exits 3 (unverifiable)", proc.returncode == 3, f"exit {proc.returncode}")
check("the summary reason is printed", "summary" in proc.stdout)

proc = subprocess.run(
    [sys.executable, str(SCRIPT), "--source-file", str(FIXTURES / "page-plain.txt")],
    capture_output=True,
    text=True,
    check=False,
)
check(
    "omitting the quote is a usage error (exit 2)", proc.returncode == 2, f"exit {proc.returncode}"
)


# --- Summary -----------------------------------------------------------------

print()
if FAILURES:
    print(f"FAILED — {len(FAILURES)} of {CHECKS} checks failed:")
    for name in FAILURES:
        print(f"  - {name}")
    sys.exit(1)

print(f"PASSED — {CHECKS} checks")
sys.exit(0)
