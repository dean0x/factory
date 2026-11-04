#!/usr/bin/env bash
# Exit check: pack the CLI, install the tarball in a throw-away HOME, make a node for a git repo, and check it.
# The flow: init --yes inside the repo "web" makes "web-factory"; start --dry-run and doctor must exit 0;
# the generated files and the --help text of every command must hold no name from the deny list and no old word.
# The real HOME, the real XDG state folder, the real tmux server, the real npm prefix and the real npm cache are never written.
# It needs a build first: npm run build
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
real_home="${HOME:-}"
real_state="${XDG_STATE_HOME:-$real_home/.local/state}"
base="${FACTORY_TMP:-${TMPDIR:-/tmp}}"
tmp=""

cleanup() {
  if [ -n "$tmp" ] && [ -d "$tmp" ]; then
    rm -rf "$tmp"
  fi
}
trap cleanup EXIT

step() { printf '== %s\n' "$*"; }
fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

# Run a command. Its output goes to a log file, and the log is shown only when the command fails.
logged() {
  local name="$1"
  shift
  if ! "$@" >"$tmp/$name.log" 2>&1; then
    cat "$tmp/$name.log" >&2
    fail "$name failed"
  fi
}

[ -f "$root/dist/factory.js" ] || fail "dist/factory.js is missing. Run: npm run build"
command -v node >/dev/null 2>&1 || fail "node is not on PATH"
command -v npm >/dev/null 2>&1 || fail "npm is not on PATH"
command -v git >/dev/null 2>&1 || fail "git is not on PATH"

version="$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$root/package.json")"
[ -n "$version" ] || fail "cannot read the version from package.json"

tmp="$(mktemp -d "${base%/}/factory-exit-check.XXXXXX")"
marker="$tmp/marker"
: >"$marker"
real_prefix="$(dirname "$(dirname "$(command -v node)")")"

# Everything below runs in the throw-away folder.
export HOME="$tmp/home"
export XDG_CONFIG_HOME="$HOME/.config"
export XDG_STATE_HOME="$tmp/state"
export TMUX_TMPDIR="$tmp/tmux"
export GIT_CONFIG_GLOBAL="$HOME/.gitconfig"
export GIT_CONFIG_NOSYSTEM=1
export GH_CONFIG_DIR="$HOME/gh"
export npm_config_prefix="$tmp/prefix"
export npm_config_cache="$tmp/npm-cache"
export npm_config_userconfig="$tmp/npmrc"
export npm_config_globalconfig="$tmp/npmrc-global"
export npm_config_update_notifier=false
export npm_config_audit=false
export npm_config_fund=false
export NO_COLOR=1
unset GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN ANTHROPIC_BASE_URL TMUX FACTORY_HOME FACTORY_SESSION
mkdir -p "$HOME" "$XDG_STATE_HOME" "$TMUX_TMPDIR" "$npm_config_prefix" "$tmp/pack" "$tmp/help"
: >"$npm_config_userconfig"
: >"$npm_config_globalconfig"
git config --file "$GIT_CONFIG_GLOBAL" user.name "Test Owner"
git config --file "$GIT_CONFIG_GLOBAL" user.email "test.owner@example.com"
git config --file "$GIT_CONFIG_GLOBAL" init.defaultBranch main
export PATH="$npm_config_prefix/bin:$PATH"

step "docs check"
logged docs sh "$root/scripts/check-intent-docs.sh"
tail -n 1 "$tmp/docs.log"

step "pack"
pack() { (cd "$root" && npm pack --silent --ignore-scripts --pack-destination "$tmp/pack"); }
logged pack pack
tarball="$(find "$tmp/pack" -name '*.tgz' -print | head -n 1)"
[ -n "$tarball" ] || fail "npm pack made no tarball"

step "install from the tarball"
logged install npm install --global --offline --ignore-scripts --no-audit --no-fund "$tarball"
command -v factory >/dev/null 2>&1 || fail "factory is not on PATH after the install"
installed="$(factory version)"
[ "$installed" = "$version" ] || fail "factory version prints $installed, expected $version"
printf 'installed factory %s\n' "$installed"

step "init"
web="$tmp/web"
home="$tmp/web-factory"
mkdir -p "$web"
git -C "$web" init -q
init_in_web() { (cd "$web" && factory init --yes --owner-name "Test Owner"); }
logged init init_in_web
head -n 1 "$tmp/init.log"
[ -f "$home/factory.yaml" ] || fail "init made no factory.yaml in $home"
grep -Fq 'path: "web"' "$home/factory.yaml" || fail "the repo web is not a project of the node"
[ -n "$(find "$XDG_STATE_HOME" -type f -print | head -n 1)" ] || fail "init wrote no home index in the state folder"

step "start --dry-run"
logged start factory start --dry-run --home "$home"
head -n 1 "$tmp/start.log"

step "doctor"
logged doctor factory doctor --home "$home"
tail -n 1 "$tmp/doctor.log"

# The help texts: the top-level help, the help of each command that it lists, and the help words.
step "help texts"
save_help() {
  local name="$1"
  shift
  factory "$@" >"$tmp/help/$name.txt" 2>&1 </dev/null || fail "factory $* failed"
}
save_help factory --help
awk '/^Commands:/ { inside = 1; next } inside && NF == 0 { exit } inside { print $1 }' "$tmp/help/factory.txt" >"$tmp/commands.txt"
[ -s "$tmp/commands.txt" ] || fail "the help of factory lists no command"
while IFS= read -r command; do
  if [ "$command" = "help" ]; then
    save_help help help
    save_help help-words help words
  else
    save_help "$command" "$command" --help
  fi
done <"$tmp/commands.txt"
printf '%s help texts saved\n' "$(find "$tmp/help" -type f | wc -l | tr -d ' ')"

step "deny list"
[ -n "$(find "$home" -path '*/.git' -prune -o -type f -print | head -n 1)" ] || fail "init wrote no file"
# Search the files that init wrote and the help texts. A match fails the check.
# The patterns match test/helpers/deny-list.ts. Keep both lists equal.
# The mode is "any" (any case) or "exact" (the case of the pattern).
scan() {
  local label="$1" pattern="$2" mode="${3:-any}" option="-Ei" code=0
  if [ "$mode" = "exact" ]; then
    option="-E"
  fi
  grep -r "$option" -q --exclude-dir=.git -e "$pattern" "$home" "$tmp/help" || code=$?
  if [ "$code" -eq 0 ]; then
    fail "a generated file or a help text holds $label"
  elif [ "$code" -ne 1 ]; then
    fail "the search for $label failed"
  fi
}
scan "an owner name" 'dean'
scan "a user folder" '/Users/'
scan "a workspace name" 'sandbox'
scan "a workflow tool name" 'devflow'
scan "a proxy product name" 'subswitch'
scan "a machine size" '(^|[^[:alnum:]_])[0-9]+ ?(GB|MB|TB|CPUs?|cores?)([^[:alnum:]_]|$)'
scan "a session id" '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
scan "a date" '20[0-9]{2}-[0-9]{2}-[0-9]{2}'
# The triage words of one workflow tool. Their case counts: the lower-case words stay allowed.
scan "a workflow triage word" '(^|[^[:alnum:]_])(FIX_NOW|ESCALATED|CHANGES REQUESTED)([^[:alnum:]_]|$)' exact
# The eight words that were replaced, as whole words, also in the plural, the past tense or an -ing form.
# The list and the endings are the same as in test/helpers/old-words.ts, and a unit test keeps them equal.
old_word_list="lane pack brief cell andon staging inspect ship"
old_endings="s|es|ed|ing|ped|ping"
old_alternatives="$(printf '%s' "$old_word_list" | tr ' ' '|')"
old_words="(^|[^[:alnum:]_])(${old_alternatives})(${old_endings})?([^[:alnum:]_]|\$)"
scan "an old word" "$old_words"
# The words of the scanned rows of the plain-words table, as whole words. The list is the same as JARGON_ERE in
# test/helpers/plain-words.ts, and a unit test keeps them equal.
jargon_words="changeovers?|work orders?|heartbeats?|bench windows?|outbox(es)?|adapters?|home index(es)?|registered roots?|state markers?|root rules?|allow[ -]lists?|owner records?|owner channels?|core blocks?|trust steps?|permission[ -]skip lists?|token-like values?"
jargon_pattern="(^|[^[:alnum:]_])(${jargon_words})([^[:alnum:]_]|\$)"
scan "a jargon word" "$jargon_pattern"
printf 'no generated file and no help text holds a name from the deny list, an old word or a jargon word\n'

# The npm page shows the package.json of the package. The installed copy holds no old word.
package_json="$npm_config_prefix/lib/node_modules/@dean0x/factory/package.json"
[ -f "$package_json" ] || fail "the installed package has no package.json"
code=0
grep -Eiq -e "$old_words" "$package_json" || code=$?
if [ "$code" -eq 0 ]; then
  fail "the package.json of the package holds an old word"
elif [ "$code" -ne 1 ]; then
  fail "the search of the package.json of the package failed"
fi
printf 'the package.json of the package holds no old word\n'

# A read-only look at the real folders. A change here is a warning: another program may have written it.
touched=""
for dir in "$real_home/.npm" "$real_prefix/bin" "$real_prefix/lib/node_modules" "$real_state/factory"; do
  if [ -d "$dir" ] && [ -n "$(find "$dir" -maxdepth 3 -newer "$marker" -print 2>/dev/null | head -n 1 || true)" ]; then
    touched="$touched $dir"
  fi
done
if [ -n "$touched" ]; then
  printf 'WARN: these real folders changed during the check:%s\n' "$touched"
fi

printf 'exit check passed\n'
