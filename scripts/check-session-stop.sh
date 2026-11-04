#!/bin/sh
# Docs check: docs/session-stop.md holds the rule for "safe" before the table, the 12 rows of the table, the four facts of
# each row, and a verdict for each row that is not open. It uses POSIX shell with awk, and no other tool.
#
# Usage: sh scripts/check-session-stop.sh [DOCS_DIR]
# DOCS_DIR is the docs folder with session-stop.md. The default is the docs folder of this repo.
#
# The doc has a heading "The rule for safe" with the four numbered facts (lines that start with 1. to 4.), and then a
# table. The table is the first block of lines that start with a bar; a later table is not read. The table rows have this
# form, in this order of cells:
#   | Way | Case | fact 1 | fact 2 | fact 3 | fact 4 | Verdict | ... |
# The six ways are /exit, /quit, /restart, kill -TERM, kill -INT and agent view delete. The two cases are idle and busy.
# Backticks around a cell are ignored. A fact starts with yes, no, open or n/a, and a reason may follow. The verdict is
# safe, not safe, not available or open. The verdict not safe needs a fact that is no. The exception is a row that no test
# reached: its facts are not no, at least one is open, and its Probe cell starts with "not tested".
#
# Exit code 0: every check passes. Exit code 1: a check fails. The output names the first failure of each check.
# A check that did not run is a failure, never ok: a file that cannot be read, and an awk that stops with an error.

# The awk program is in single quotes on purpose: the shell must not expand its $0 and its backticks.
# shellcheck disable=SC2016

case $0 in
  */*) here=${0%/*} ;;
  *) here=. ;;
esac
docs=${1:-$here/../docs}
doc=$docs/session-stop.md

# The match of awk does not depend on the locale of the person.
LC_ALL=C
export LC_ALL

failed=0
awk_failed='the check did not run: awk stopped with an error'

report() {
  if [ -z "$3" ]; then
    printf 'ok   %s  %s\n' "$1" "$2"
  else
    printf 'FAIL %s  %s\n     %s\n' "$1" "$2" "$3"
    failed=$((failed + 1))
  fi
}

if [ ! -f "$doc" ]; then
  printf 'FAIL the file %s is missing\n' "$doc"
  exit 1
fi
if [ ! -r "$doc" ]; then
  printf 'FAIL the file %s cannot be read\n' "$doc"
  exit 1
fi

# One pass of awk reads the doc and prints one line for each failed check: the number of the check, a colon, and the first
# failure of that check.
if findings=$(awk '
  function trim(text) {
    gsub(/^[ \t]+/, "", text)
    gsub(/[ \t]+$/, "", text)
    return text
  }
  function plain(text) {
    gsub(/`/, "", text)
    return trim(text)
  }
  # The first word of a fact or of a verdict: letters, and the form n/a.
  function word(text) {
    text = plain(text)
    if (match(text, /^[a-z]+(\/[a-z])?/)) return substr(text, 1, RLENGTH)
    return ""
  }
  function fail(number, message) {
    if (!(number in found)) found[number] = message
  }
  BEGIN {
    ways = split("/exit|/quit|/restart|kill -TERM|kill -INT|agent view delete", way, "[|]")
    cases = split("idle|busy", kind, "[|]")
    for (w = 1; w <= ways; w++) for (c = 1; c <= cases; c++) expected[way[w], kind[c]] = 1
    split("yes|no|open|n/a", listed, "[|]")
    for (i = 1; i <= 4; i++) fact_word[listed[i]] = 1
    split("safe|not safe|not available|open", listed, "[|]")
    for (i = 1; i <= 4; i++) verdict_word[listed[i]] = 1
  }
  # The table is the first block of lines that start with a bar. A later table in the doc is not read.
  !/^\|/ && tableline { tabledone = 1 }
  /^```/ { fenced = !fenced; next }
  fenced { next }
  /^#+[ \t]/ {
    inrule = 0
    if ($0 ~ /^#+ The rule for safe[ \t]*$/) {
      if (!ruleline) ruleline = NR
      inrule = 1
    }
    next
  }
  inrule && /^[1-4]\. / { has_fact[substr($0, 1, 1)] = 1 }
  /^\|/ {
    if (tabledone) next
    if (!tableline) tableline = NR
    cells = split($0, cell, "|")
    name = plain(cell[2])
    state = plain(cell[3])
    if (name == "Way" || name ~ /^:?-+:?$/) next
    key = name SUBSEP state
    if (!(key in expected)) {
      fail(2, sprintf("line %d: the row \"%s\" \"%s\" is not one of the 12 rows", NR, name, state))
      next
    }
    seen[key]++
    if (seen[key] > 1) {
      fail(2, sprintf("line %d: the row of %s %s is in the table twice", NR, name, state))
      next
    }
    rowline[key] = NR
    for (k = 1; k <= 4; k++) fact[key, k] = cell[3 + k]
    verdict[key] = plain(cell[8])
    probe[key] = plain(cell[9])
    next
  }
  END {
    # 1. The rule is a heading with its four facts, before the table.
    if (!ruleline) fail(1, "there is no heading \"The rule for safe\"")
    else {
      for (k = 1; k <= 4; k++) {
        if (!(k in has_fact)) {
          fail(1, sprintf("the rule for safe has no line for fact %d (a line that starts with %d.)", k, k))
          break
        }
      }
      if (tableline && ruleline > tableline) fail(1, "the rule for safe is not before the table")
    }
    # 2. The 12 rows are in the table, each once.
    for (w = 1; w <= ways; w++) {
      for (c = 1; c <= cases; c++) {
        if (!((way[w], kind[c]) in seen)) fail(2, sprintf("the table has no row for %s %s", way[w], kind[c]))
      }
    }
    # 3 to 5. Each row has four facts, a verdict that is not open, and a verdict that agrees with its facts.
    for (w = 1; w <= ways; w++) {
      for (c = 1; c <= cases; c++) {
        key = way[w] SUBSEP kind[c]
        if (!(key in seen)) continue
        label = sprintf("line %d: the row %s %s", rowline[key], way[w], kind[c])
        facts_ok = 1
        yes = 0; no = 0; open = 0; na = 0
        for (k = 1; k <= 4; k++) {
          text = plain(fact[key, k])
          value = word(text)
          if (text == "") {
            fail(3, sprintf("%s has no value for fact %d", label, k))
            facts_ok = 0
          } else if (!(value in fact_word)) {
            fail(3, sprintf("%s has the fact %d \"%s\", which does not start with yes, no, open or n/a", label, k, text))
            facts_ok = 0
          } else if (value == "yes") yes++
          else if (value == "no") no++
          else if (value == "open") open++
          else na++
        }
        text = verdict[key]
        if (text == "") fail(4, sprintf("%s has no verdict", label))
        else if (text == "open") fail(4, sprintf("%s has the verdict open", label))
        else if (!(text in verdict_word)) fail(4, sprintf("%s has the verdict \"%s\", which is not safe, not safe, not available or open", label, text))
        if (!facts_ok || !(text in verdict_word) || text == "open") continue
        if (text == "safe" && yes != 4) fail(5, sprintf("%s has the verdict safe, but a fact is not yes", label))
        else if (text == "not safe" && no == 0) {
          if (open == 0) fail(5, sprintf("%s has the verdict not safe, but no fact is no", label))
          else if (probe[key] !~ /^not tested/) fail(5, sprintf("%s has the verdict not safe, but no fact is no and the Probe cell does not start with \"not tested\"", label))
        } else if (text == "not available" && na != 4) fail(5, sprintf("%s has the verdict not available, but a fact is not n/a", label))
      }
    }
    for (number = 1; number <= 5; number++) {
      if (number in found) printf "%d:%s\n", number, found[number]
    }
  }
' "$doc"); then
  ran=1
else
  ran=0
fi

# The first failure of the check $1, or nothing when it passed.
finding() {
  if [ "$ran" -eq 0 ]; then
    printf '%s' "$awk_failed"
    return
  fi
  printf '%s\n' "$findings" | awk -v n="$1" 'index($0, n ":") == 1 { print substr($0, length(n) + 2); exit }'
}

report 1 "the rule for safe is in the doc, with its four facts, before the table" "$(finding 1)"
report 2 "the table has the 12 rows: six ways, idle and busy, each once" "$(finding 2)"
report 3 "each row has four facts, each yes, no, open or n/a" "$(finding 3)"
report 4 "each row has a verdict, and no verdict is open" "$(finding 4)"
report 5 "each verdict agrees with the facts of its row" "$(finding 5)"

if [ "$failed" -ne 0 ]; then
  printf '%s of 5 checks failed\n' "$failed"
  exit 1
fi
printf 'all 5 checks passed\n'
