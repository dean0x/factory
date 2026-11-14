#!/bin/sh
# Review scope check: the review summary lists the six files of the setup and upgrade code.
# It uses POSIX shell with awk, and no other tool.
#
# Usage: sh scripts/check-review-scope.sh SUMMARY
# SUMMARY is the review summary, for example docs/reviews/fac-m2-review-summary.md.
# It must hold the section "Setup and upgrade code", and the section must list the six paths below.
#
# Exit code 0: the section lists every path. Exit code 1: the summary or the section is missing, or a path is not
# listed. The output names each path that is not listed. Exit code 2: no summary was given.

heading='Setup and upgrade code'
paths='src/commands/init.ts src/commands/upgrade.ts src/commands/doctor.ts src/upgrade/apply.ts src/upgrade/plan.ts src/upgrade/spec.ts'

if [ $# -ne 1 ]; then
  printf 'Usage: sh scripts/check-review-scope.sh SUMMARY\n' >&2
  exit 2
fi
summary=$1

if [ ! -f "$summary" ]; then
  printf 'FAIL the summary %s is missing\n' "$summary"
  exit 1
fi

# The section runs from its heading to the next heading of the same level or a higher one.
# A path counts as listed when the section holds it as a whole path, not as a part of a longer name.
missing=$(awk -v heading="$heading" -v wanted="$paths" '
  function whole(text, path,    at, before, after, rest) {
    rest = text
    while ((at = index(rest, path)) > 0) {
      before = (at == 1) ? " " : substr(rest, at - 1, 1)
      after = substr(rest, at + length(path), 1)
      if (after == "") after = " "
      if (before !~ /[A-Za-z0-9_.\/-]/ && after !~ /[A-Za-z0-9_\/-]/) {
        if (after != "." || substr(rest, at + length(path) + 1, 1) !~ /[A-Za-z0-9_]/) return 1
      }
      rest = substr(rest, at + length(path))
    }
    return 0
  }
  {
    if (match($0, /^#+ /)) {
      level = RLENGTH - 1
      title = substr($0, RLENGTH + 1)
      sub(/[ \t]+$/, "", title)
      if (inside && level <= sectionLevel) inside = 0
      if (!inside && !found && title == heading) { inside = 1; found = 1; sectionLevel = level; next }
    }
    if (inside) section = section $0 "\n"
  }
  END {
    if (!found) print "the section is missing"
    count = split(wanted, path, " ")
    for (n = 1; n <= count; n++) {
      if (!found || !whole(section, path[n])) print path[n]
    }
  }
' "$summary")

if [ -n "$missing" ]; then
  printf 'FAIL %s does not list these paths in the section "%s":\n' "$summary" "$heading"
  printf '%s\n' "$missing" | awk '{ print "     " $0 }'
  exit 1
fi
printf 'ok   %s lists all 6 paths in the section "%s"\n' "$summary" "$heading"
