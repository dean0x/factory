#!/bin/sh
# Docs check: the docs that hold the intent of the design agree with each other.
# It uses POSIX shell with grep and awk, and no other tool.
#
# Usage: sh scripts/check-intent-docs.sh [DOCS_DIR]
# DOCS_DIR is the docs folder to check. The default is the docs folder of this repo.
# Check 8 also reads README.md and CHANGELOG.md in the folder above DOCS_DIR, when they exist.
#
# Exit code 0: every check passes. Exit code 1: a check fails. The output names the first failure of each check.

# The awk programs are in single quotes on purpose: the shell must not expand their $1 and their backticks.
# shellcheck disable=SC2016

case $0 in
  */*) here=${0%/*} ;;
  *) here=. ;;
esac
docs=${1:-$here/../docs}

design=$docs/design.md
trace=$docs/intent-trace.md
roadmap=$docs/roadmap-v2.md
budget=$docs/token-budget.md
research=$docs/research

# The marks and the byte-wise match of awk do not depend on the locale of the person.
LC_ALL=C
export LC_ALL

failed=0

report() {
  if [ -z "$3" ]; then
    printf 'ok   %s  %s\n' "$1" "$2"
  else
    printf 'FAIL %s  %s\n     %s\n' "$1" "$2" "$3"
    failed=$((failed + 1))
  fi
}

for file in "$design" "$trace" "$roadmap" "$budget"; do
  if [ ! -f "$file" ]; then
    printf 'FAIL the file %s is missing\n' "$file"
    exit 1
  fi
done

# 1. Each section mark (a paragraph sign and a number) in the trace is a heading of the design.
first=$(awk '
  FILENAME == ARGV[1] {
    if ($0 ~ /^##+ [0-9]+(\.[0-9]+)*\.? /) {
      id = $2
      sub(/\.$/, "", id)
      heading[id] = 1
    }
    next
  }
  {
    line = $0
    mark = "§"
    while ((at = index(line, mark)) > 0) {
      line = substr(line, at + length(mark))
      if (match(line, /^[0-9]+(\.[0-9]+)*/)) {
        id = substr(line, 1, RLENGTH)
        if (!(id in heading)) {
          printf "intent-trace.md line %d: section %s is not a heading of design.md\n", FNR, id
          exit
        }
      }
    }
  }
' "$design" "$trace")
report 1 "each section in intent-trace.md is a heading of design.md" "$first"

# 2. Each milestone id of the trace is named in the roadmap. Each milestone from FAC-M2 up has a heading there.
first=$(awk '
  FILENAME == ARGV[1] {
    line = $0
    while (match(line, /FAC-M[0-9]+/)) {
      named[substr(line, RSTART + 5, RLENGTH - 5) + 0] = 1
      line = substr(line, RSTART + RLENGTH)
    }
    if ($0 ~ /^#+ FAC-M[0-9]+/) {
      split($2, part, ":")
      heading[substr(part[1], 6) + 0] = 1
    }
    if ($0 ~ /^\| *[0-9]+ *\| *FAC-M[0-9]+ /) {
      split($0, cell, "|")
      if (match(cell[3], /FAC-M[0-9]+/) && substr(cell[3], RSTART + 5, RLENGTH - 5) + 0 > top) {
        top = substr(cell[3], RSTART + 5, RLENGTH - 5) + 0
      }
    }
    next
  }
  {
    line = $0
    while (match(line, /FAC-M[0-9]+/)) {
      id = substr(line, RSTART + 5, RLENGTH - 5) + 0
      if (id > top) top = id
      if (!(id in named) && !failed) {
        printf "intent-trace.md line %d: FAC-M%d is not named in roadmap-v2.md\n", FNR, id
        failed = 1
      }
      line = substr(line, RSTART + RLENGTH)
    }
  }
  END {
    if (failed) exit
    for (id = 2; id <= top; id++) {
      if (!(id in heading)) {
        printf "roadmap-v2.md has no heading for FAC-M%d\n", id
        exit
      }
    }
  }
' "$roadmap" "$trace")
report 2 "each milestone of the trace is in roadmap-v2.md, with a heading" "$first"

# 3. The first word of each command line in the code block of design 4.2 has a row in the Command map of the roadmap.
first=$(awk '
  FILENAME == ARGV[1] {
    if ($0 ~ /^### 4\.2 /) { inside = 1; next }
    if (inside && $0 ~ /^#/) { inside = 0 }
    if (inside && $0 ~ /^```/) {
      fence = !fence
      if (!fence) inside = 0
      next
    }
    if (inside && fence && $1 == "factory" && $2 != "") {
      if (!($2 in seen)) { seen[$2] = 1; count++; word[count] = $2 }
    }
    next
  }
  /^### Command map/ { map = 1; next }
  map && /^#/ { map = 0 }
  map && /^\|/ {
    split($0, cell, "|")
    text = cell[2]
    while ((at = index(text, "`")) > 0) {
      text = substr(text, at + 1)
      if (match(text, /^[a-z][a-z-]*/)) mapped[substr(text, 1, RLENGTH)] = 1
    }
  }
  END {
    if (count == 0) { print "design.md 4.2 has no command line in its code block"; exit }
    for (n = 1; n <= count; n++) {
      if (!(word[n] in mapped)) {
        printf "the command %s of design.md 4.2 has no row in the Command map of roadmap-v2.md\n", word[n]
        exit
      }
    }
  }
' "$design" "$roadmap")
report 3 "each command of design 4.2 has a row in the Command map" "$first"

# 4. The table of design 7.1 has 11 rows.
first=$(awk '
  /^### 7\.1 / { inside = 1; next }
  inside && /^#/ { inside = 0 }
  inside && /^\| *[0-9]+ *\|/ { rows++ }
  END { if (rows != 11) printf "design.md 7.1 has %d table rows, expected 11\n", rows }
' "$design")
report 4 "the table of design 7.1 has 11 rows" "$first"

# 5. The Status column of the parity table in design 8.1 holds only planned, done or retired.
first=$(awk '
  /^### 8\.1 / { inside = 1; next }
  inside && /^#/ { inside = 0 }
  inside && /^\|/ {
    lines++
    if (lines <= 2) next
    rows++
    row = $0
    sub(/[ \t]*\|[ \t]*$/, "", row)
    n = split(row, cell, "|")
    status = cell[n]
    gsub(/^[ \t]+/, "", status)
    gsub(/[ \t]+$/, "", status)
    if (status != "planned" && status != "done" && status != "retired") {
      printf "design.md line %d: the Status \"%s\" is not planned, done or retired\n", NR, status
      exit
    }
  }
  END { if (rows == 0) print "design.md 8.1 has no parity table rows" }
' "$design")
report 5 "the Status column of the parity table holds only planned, done or retired" "$first"

# 6. The token budget has one row for each of the 17 jobs, numbered 1 to 17.
first=$(awk '
  /^\| *[0-9]+ *\|/ {
    split($0, cell, "|")
    number = cell[2] + 0
    rows++
    if (number != rows && !bad) {
      printf "token-budget.md line %d: the row has the number %d, expected %d\n", NR, number, rows
      bad = 1
    }
  }
  END { if (!bad && rows != 17) printf "token-budget.md has %d job rows, expected 17\n", rows }
' "$budget")
report 6 "token-budget.md has one row for each of the 17 jobs" "$first"

# 7. No file under docs/research holds the whole word lane or lanes. The search goes down five levels.
first=""
if [ ! -d "$research" ]; then
  first="the folder $research is missing"
else
  for file in "$research"/* "$research"/*/* "$research"/*/*/* "$research"/*/*/*/* "$research"/*/*/*/*/*; do
    [ -f "$file" ] || continue
    hit=$(grep -n -i -E '(^|[^[:alnum:]_])lanes?($|[^[:alnum:]_])' "$file" | awk 'NR == 1 { print; exit }')
    if [ -n "$hit" ]; then
      first="${file}:${hit%%:*} holds the word lane"
      break
    fi
  done
fi
report 7 "no file under docs/research holds the word lane" "$first"

# 8. No file of the docs folder (down five levels), no README.md and no CHANGELOG.md above it holds a local machine path.
# A local path is a user folder path (/Users/<name>/), a home path with a name (/home/<name>/), a private path (/private/)
# or a temp Claude path (/tmp/claude). The name "example" is the only name that is accepted. A marker that follows a
# letter, a digit or one of _ . ~ - is part of a longer relative path (docs/private/), so it is not a local path.
# The output names the file, the line and the kind of path, never the path.
set --
for file in "$docs"/* "$docs"/*/* "$docs"/*/*/* "$docs"/*/*/*/* "$docs"/*/*/*/*/* "$docs/../README.md" "$docs/../CHANGELOG.md"; do
  [ -f "$file" ] || continue
  set -- "$@" "$file"
done
first=$(awk '
  BEGIN {
    marker[1] = "/Users/";     kind[1] = "a user folder path";      named[1] = 1
    marker[2] = "/home/";      kind[2] = "a home path with a name"; named[2] = 1
    marker[3] = "/private/";   kind[3] = "a private path";          named[3] = 0
    marker[4] = "/tmp/claude"; kind[4] = "a temp Claude path";      named[4] = 0
    count = 4
  }
  function local_path(line,   n, pos, at, before, rest, name) {
    for (n = 1; n <= count; n++) {
      pos = 1
      while ((at = index(substr(line, pos), marker[n])) > 0) {
        at += pos - 1
        before = at > 1 ? substr(line, at - 1, 1) : ""
        if (before !~ /[A-Za-z0-9_.~-]/) {
          if (!named[n]) return kind[n]
          rest = substr(line, at + length(marker[n]))
          match(rest, /^[A-Za-z0-9._-]*/)
          name = substr(rest, 1, RLENGTH)
          sub(/\.+$/, "", name)
          if (name != "example") return kind[n]
        }
        pos = at + 1
      }
    }
    return ""
  }
  {
    found = local_path($0)
    if (found != "") {
      printf "%s:%d holds %s\n", FILENAME, FNR, found
      exit
    }
  }
' "$@")
report 8 "the docs, the README and the CHANGELOG hold no local machine path" "$first"

first=$(awk '
  /^#+ ([0-9]+(\.[0-9]+)* )?Core and setup[ \t]*$/ { core = 1 }
  /^#+ ([0-9]+(\.[0-9]+)* )?Extension points[ \t]*$/ { points = 1 }
  END {
    if (!core) print "design.md has no heading \"Core and setup\""
    else if (!points) print "design.md has no heading \"Extension points\""
  }
' "$design")
report 9 "design.md has the headings for core and setup and for extension points" "$first"

if [ "$failed" -ne 0 ]; then
  printf '%s of 9 checks failed\n' "$failed"
  exit 1
fi
printf 'all 9 checks passed\n'
