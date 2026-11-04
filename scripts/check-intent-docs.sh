#!/bin/sh
# Docs check: the docs that hold the intent of the design agree with each other.
# It uses POSIX shell with grep and awk, and no other tool.
#
# Usage: sh scripts/check-intent-docs.sh [DOCS_DIR]
# DOCS_DIR is the docs folder to check. The default is the docs folder of this repo.
# Check 2 also reads the label "Design v3 PR": see the comment of check 2.
# Check 8 also reads README.md and CHANGELOG.md in the folder above DOCS_DIR, when they exist.
# Check 10 also reads glossary.md in DOCS_DIR, and reads only the core parts of the design and of the glossary: see the
# comment of check 10.
#
# Exit code 0: every check passes. Exit code 1: a check fails. The output names the first failure of each check.
# A check that did not run is a failure, never ok: a file or a folder that cannot be read, and an awk that stops with an error.

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
glossary=$docs/glossary.md
research=$docs/research

# The marks and the byte-wise match of awk do not depend on the locale of the person.
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

for file in "$design" "$trace" "$roadmap" "$budget" "$glossary"; do
  if [ ! -f "$file" ]; then
    printf 'FAIL the file %s is missing\n' "$file"
    exit 1
  fi
  if [ ! -r "$file" ]; then
    printf 'FAIL the file %s cannot be read\n' "$file"
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
' "$design" "$trace") || first=$awk_failed
report 1 "each section in intent-trace.md is a heading of design.md" "$first"

# 2. Each milestone id of the trace is named in the roadmap. Each milestone from FAC-M2 up has a heading there.
# A row of the trace that names the label "Design v3 PR" needs a heading of the roadmap that starts with the label. Under
# that heading, down to the next heading of the same or a higher level, the roadmap has the two checkboxes "Docs PR" and
# "Code PR". A checkbox may be ticked or not.
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
    if ($0 ~ /^```/) fenced = !fenced
    if (!fenced && $0 ~ /^#+ /) {
      match($0, /^#+/)
      level = RLENGTH
      if (inlabel && level <= labellevel) inlabel = 0
      if ($0 ~ /^#+ Design v3 PR/) { hasheading = 1; inlabel = 1; labellevel = level }
    }
    if (inlabel && !fenced && $0 ~ /^- \[[ xX]\] Docs PR/) docsbox = 1
    if (inlabel && !fenced && $0 ~ /^- \[[ xX]\] Code PR/) codebox = 1
    if ($0 ~ /^\| *[0-9]+ *\| *FAC-M[0-9]+ /) {
      split($0, cell, "|")
      if (match(cell[3], /FAC-M[0-9]+/) && substr(cell[3], RSTART + 5, RLENGTH - 5) + 0 > top) {
        top = substr(cell[3], RSTART + 5, RLENGTH - 5) + 0
      }
    }
    next
  }
  {
    if (!labelline && $0 ~ /^\|/ && index($0, "Design v3 PR") > 0) labelline = FNR
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
    if (labelline) {
      if (!hasheading) {
        printf "intent-trace.md line %d: the label \"Design v3 PR\" is not a heading of roadmap-v2.md\n", labelline
        exit
      }
      if (!docsbox) { print "roadmap-v2.md: the heading \"Design v3 PR\" has no checkbox for the docs PR"; exit }
      if (!codebox) { print "roadmap-v2.md: the heading \"Design v3 PR\" has no checkbox for the code PR"; exit }
    }
  }
' "$roadmap" "$trace") || first=$awk_failed
report 2 "each milestone and each label of the trace is in roadmap-v2.md, with a heading" "$first"

# 3. The first word of each command line in the code block of design 4.2 has a row in the Command map of the roadmap.
first=$(awk '
  FILENAME == ARGV[1] {
    if ($0 ~ /^### 4\.2 /) { inside = 1; next }
    if (inside && !fence && $0 ~ /^#/) { inside = 0 }
    if (inside && $0 ~ /^```/) { fence = !fence; next }
    if (inside && fence && $1 == "factory" && $2 != "") {
      if ($2 == "desk" && !deskline) deskline = FNR
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
    if (deskline) { printf "design.md 4.2 has a desk row (line %d)\n", deskline; exit }
    if ("desk" in mapped) { print "the Command map of roadmap-v2.md has a desk row"; exit }
    for (n = 1; n <= count; n++) {
      if (!(word[n] in mapped)) {
        printf "the command %s of design.md 4.2 has no row in the Command map of roadmap-v2.md\n", word[n]
        exit
      }
    }
  }
' "$design" "$roadmap") || first=$awk_failed
report 3 "each command of design 4.2 has a row in the Command map" "$first"

# 4. The table of design 7.1 has 11 rows.
first=$(awk '
  /^### 7\.1 / { inside = 1; next }
  inside && /^#/ { inside = 0 }
  inside && /^\| *[0-9]+ *\|/ { rows++ }
  END { if (rows != 11) printf "design.md 7.1 has %d table rows, expected 11\n", rows }
' "$design") || first=$awk_failed
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
' "$design") || first=$awk_failed
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
' "$budget") || first=$awk_failed
report 6 "token-budget.md has one row for each of the 17 jobs" "$first"

# Checks 7 and 8 read a folder tree with the same walk. `scan_folder DIR DEPTH CHECK` runs the function CHECK on each file
# of the folder DIR, then on each file of each folder in it. DEPTH is the depth of DIR: the folder where the walk starts is
# at depth 0. The files and the folders with a name that starts with a dot count. CHECK gets the path of one file, and it
# sets $first to the reason and returns 1 when the file fails. A link to a folder is followed, and the depth limit ends a
# loop of links.
max_depth=10

scan_folder() {
  if [ ! -r "$1" ] || [ ! -x "$1" ]; then
    first="the folder $1 cannot be read"
    return 1
  fi
  for entry in "$1"/* "$1"/.[!.]* "$1"/..?*; do
    if [ -f "$entry" ]; then
      "$3" "$entry" || return 1
    fi
  done
  for entry in "$1"/* "$1"/.[!.]* "$1"/..?*; do
    if [ -d "$entry" ]; then
      if [ "$2" -ge "$max_depth" ]; then
        first="the folder $entry is deeper than $max_depth levels"
        return 1
      fi
      scan_folder "$entry" $(($2 + 1)) "$3" || return 1
    fi
  done
  return 0
}

# 7. No file under docs/research (all levels, dot files too) holds the whole word lane or lanes. A file or a folder that
# cannot be read, and a folder deeper than the depth limit, are a failure.

# Sets $first to the reason that the file $1 was not read or holds the word lane, and returns 1.
scan_lane_file() {
  if [ ! -r "$1" ]; then
    first="the file $1 cannot be read"
    return 1
  fi
  hit=$(grep -n -i -E '(^|[^[:alnum:]_])lanes?($|[^[:alnum:]_])' "$1" | awk 'NR == 1 { print; exit }') || {
    first=$awk_failed
    return 1
  }
  if [ -n "$hit" ]; then
    first="${1}:${hit%%:*} holds the word lane"
    return 1
  fi
  return 0
}

first=""
if [ ! -d "$research" ]; then
  first="the folder $research is missing"
else
  scan_folder "$research" 0 scan_lane_file
fi
report 7 "no file under docs/research holds the word lane" "$first"

# 8. No file of the docs folder (all levels, dot files too), no README.md and no CHANGELOG.md above it holds a local
# machine path. A local path is a user folder path (/Users/<name>/ in any letter case, C:\Users\<name>\ and
# /mnt/c/Users/<name>/), the encoded folder name of a Claude project (-Users-<name>-), a home path with a name
# (/home/<name>/ and /var/home/<name>/), a private path (/private/), a macOS temp path (/var/folders/), a temp Claude path
# (/tmp/claude) or a temp path (/tmp/). The name "example" is the only name that is accepted. A marker that follows a
# letter, a digit or one of _ . ~ - is part of a longer relative path (docs/private/), so it is not a local path; the
# drive letter of a WSL path is the only exception. The output names the file, the line and the kind of path, never the
# path. A file or a folder that cannot be read, and a folder deeper than the depth limit, are a failure.

# Sets $first to the first local path of the file $1, and returns 1, or to the reason that the file was not read.
scan_file() {
  if [ ! -r "$1" ]; then
    first="the file $1 cannot be read"
    return 1
  fi
  hit=$(awk '
    BEGIN {
      marker[1] = "/Users/";        kind[1] = "a user folder path";          named[1] = 1; fold[1] = 1
      marker[2] = "\\Users\\";      kind[2] = "a user folder path";          named[2] = 1; fold[2] = 1
      marker[3] = "-Users-";        kind[3] = "an encoded user folder path"; named[3] = 1; dash[3] = 1
      marker[4] = "/home/";         kind[4] = "a home path with a name";     named[4] = 1
      marker[5] = "/var/home/";     kind[5] = "a home path with a name";     named[5] = 1
      marker[6] = "/private/";      kind[6] = "a private path"
      marker[7] = "/tmp/claude";    kind[7] = "a temp Claude path"
      marker[8] = "/var/folders/";  kind[8] = "a macOS temp path"
      marker[9] = "/tmp/";          kind[9] = "a temp path"
      count = 9
    }
    function local_path(line,   n, text, key, pattern, pos, at, before, wsl, rest, name) {
      for (n = 1; n <= count; n++) {
        text = fold[n] ? tolower(line) : line
        key = fold[n] ? tolower(marker[n]) : marker[n]
        pattern = dash[n] ? "^[A-Za-z0-9._]*" : "^[A-Za-z0-9._-]*"
        pos = 1
        while ((at = index(substr(text, pos), key)) > 0) {
          at += pos - 1
          before = at > 1 ? substr(line, at - 1, 1) : ""
          wsl = (n == 1 && before ~ /[A-Za-z]/ && at > 6 && substr(text, at - 6, 5) == "/mnt/")
          if (before !~ /[A-Za-z0-9_.~-]/ || wsl) {
            if (!named[n]) return kind[n]
            rest = substr(line, at + length(key))
            sub(/^\\+/, "", rest)
            match(rest, pattern)
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
  ' "$1") || {
    first=$awk_failed
    return 1
  }
  if [ -n "$hit" ]; then
    first=$hit
    return 1
  fi
  return 0
}

first=""
scan_folder "$docs" 0 scan_file
for file in "$docs/../README.md" "$docs/../CHANGELOG.md"; do
  if [ -z "$first" ] && [ -f "$file" ]; then
    scan_file "$file"
  fi
done
report 8 "the docs, the README and the CHANGELOG hold no local machine path" "$first"

# 9. design.md has the headings "Core and setup" and "Extension points". A heading may start with a section number, with
# or without a dot after it. A line in fenced code is not a heading.
first=$(awk '
  /^```/ { fenced = !fenced; next }
  fenced { next }
  /^#+ ([0-9]+(\.[0-9]+)*\.? )?Core and setup[ \t]*$/ { core = 1 }
  /^#+ ([0-9]+(\.[0-9]+)*\.? )?Extension points[ \t]*$/ { points = 1 }
  END {
    if (!core) print "design.md has no heading \"Core and setup\""
    else if (!points) print "design.md has no heading \"Extension points\""
  }
' "$design") || first=$awk_failed
report 9 "design.md has the headings for core and setup and for extension points" "$first"

# 10. The core parts of the design and of the glossary hold no word of the software recipe list, and no word of git or
# tmux. The software recipe list is a copy of softwareWordList in src/recipes/software/words.ts. A unit test keeps the two
# equal, in the same order. A word also counts as a plural, a past form or an -ing form, in any letter case; git and tmux
# count only as the word itself. An all-capital word (PR, CI) counts only in capital letters. A word that starts with
# another word of the list (release check) is found by that word. A word inside a longer word (.gitignore) does not
# count, and a code span counts. The core parts are:
#   a. design.md, the section "Summary for Dean (one page)", down to the next heading of level 1 or 2;
#   b. design.md, the section "4.1 Concepts", down to the next heading of level 1 to 3;
#   c. design.md 4.2, the fenced lines under "**Core commands**", down to "**Software recipe commands**";
#   d. design.md 6, the table rows under "**Rules for every factory**", down to "**Rules of the software recipe**" or the
#      next heading;
#   e. glossary.md, the section "Words of every factory", down to the next heading of level 1 or 2.
# In the parts a, b and e, a line that starts with "Software recipe:" or "Engineering note:" (after an optional "- " or
# "> ") is not checked. The parts c and d have no such line. A line in fenced code is not a heading and ends no part; a
# fence starts only at column 0. Each part needs at least one line to check. The output names the first hit, or the part
# that is missing.
software_words="merge|pull request|release|release check|release scope|CI log|PR|CI"
first=$(awk -v software_words="$software_words" '
  function recipe_word(line,   low, word) {
    low = tolower(line)
    if (match(low, lower_re)) {
      word = substr(low, RSTART, RLENGTH)
      sub(/^[^a-z]+/, "", word)
      sub(/[^a-z]+$/, "", word)
      return word
    }
    if (match(line, abbr_re)) {
      word = substr(line, RSTART, RLENGTH)
      sub(/^[^A-Z]+/, "", word)
      sub(/[^A-Za-z]+$/, "", word)
      return word
    }
    return ""
  }
  function exempt(line) {
    return line ~ /^(- |> )?(Software recipe|Engineering note):/
  }
  # The expressions of the words come from software_words. A word of all capital letters is an abbreviation and counts in
  # capital letters only. The last word of a phrase also counts as a plural, a past form and an -ing form.
  BEGIN {
    split("Summary for Dean|4.1 Concepts|4.2 Core commands|6 Rules for every factory|Words of every factory", name, "[|]")
    count = split(software_words, listed, "[|]")
    for (i = 1; i <= count; i++) {
      if (listed[i] ~ /^[A-Z]+$/) {
        abbr_re = abbr_re (abbr_re == "" ? "" : "|") listed[i] "s?"
        continue
      }
      lowered = tolower(listed[i])
      covered = 0
      for (j = 1; j <= count; j++) {
        if (j != i && listed[j] !~ /^[A-Z]+$/ && index(lowered, tolower(listed[j]) " ") == 1) covered = 1
      }
      if (covered) continue
      pieces = split(lowered, piece, " ")
      last = piece[pieces]
      if (last ~ /e$/) piece[pieces] = substr(last, 1, length(last) - 1) "(e[sd]?|ing)"
      else piece[pieces] = last "(s|ed|ing)?"
      form = piece[1]
      for (k = 2; k <= pieces; k++) form = form " +" piece[k]
      lower_re = lower_re (lower_re == "" ? "" : "|") form
    }
    lower_re = "(^|[^a-z0-9_])(" lower_re "|git|tmux)($|[^a-z0-9_])"
    abbr_re = "(^|[^A-Za-z0-9_])(" abbr_re ")($|[^A-Za-z0-9_])"
  }
  # The files are design.md, then glossary.md. cur is the number of the part that is open (0: none).
  FNR == 1 {
    file = (FILENAME == ARGV[2]) ? "glossary.md" : "design.md"
    fence = 0; cur = 0; in42 = 0
  }
  /^```/ { fence = !fence; next }
  !fence && /^#+([ \t].*)?$/ {
    match($0, /^#+/)
    level = RLENGTH
    if (cur == 3 || cur == 4 || (cur == 1 && level <= 2) || (cur == 2 && level <= 3) || (cur == 5 && level <= 2)) cur = 0
    in42 = 0
    if (file == "glossary.md") {
      if ($0 ~ /^## Words of every factory[ \t]*$/) cur = 5
    } else if ($0 ~ /^## Summary for Dean \(one page\)[ \t]*$/) cur = 1
    else if ($0 ~ /^### 4\.1 Concepts[ \t]*$/) cur = 2
    else if ($0 ~ /^### 4\.2 /) in42 = 1
    if (cur) seen[cur] = 1
    next
  }
  !fence && in42 && /^\*\*Core commands\*\*/ { cur = 3; seen[3] = 1; next }
  !fence && cur == 3 && /^\*\*Software recipe commands\*\*/ { cur = 0; next }
  !fence && cur == 0 && file == "design.md" && /^\*\*Rules for every factory\*\*/ { cur = 4; seen[4] = 1; next }
  !fence && cur == 4 && /^\*\*Rules of the software recipe\*\*/ { cur = 0; next }
  cur == 0 || /^[ \t]*$/ { next }
  cur == 3 && !fence { next }
  cur == 4 && !/^[|]/ { next }
  (cur == 1 || cur == 2 || cur == 5) && exempt($0) { next }
  {
    lines[cur]++
    if (!hit) {
      word = recipe_word($0)
      if (word != "") {
        hit = 1
        printf "%s line %d: the core part \"%s\" holds the software recipe word \"%s\"\n", file, FNR, name[cur], word
      }
    }
  }
  END {
    if (hit) exit
    for (part = 1; part <= 5; part++) {
      where = (part == 5) ? "glossary.md" : "design.md"
      if (part == 3 && !seen[3]) print "design.md 4.2 has no core command table"
      else if (part == 3 && !lines[3]) print "design.md 4.2 has no fenced code under \"**Core commands**\""
      else if (!seen[part]) printf "%s has no core part \"%s\"\n", where, name[part]
      else if (!lines[part]) printf "%s holds no line to check in the core part \"%s\"\n", where, name[part]
      else continue
      exit
    }
  }
' "$design" "$glossary") || first=$awk_failed
report 10 "the core parts of the design and the glossary hold no word of the software recipe" "$first"

if [ "$failed" -ne 0 ]; then
  printf '%s of 10 checks failed\n' "$failed"
  exit 1
fi
printf 'all 10 checks passed\n'
