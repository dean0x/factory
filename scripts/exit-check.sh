#!/usr/bin/env bash
# Exit check: pack the CLI, install the tarball in a throw-away HOME, then run init and doctor.
# The real HOME, the real npm prefix and the real npm cache are never written.
# It needs a build first: npm run build
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
real_home="${HOME:-}"
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
unset GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN ANTHROPIC_BASE_URL
mkdir -p "$HOME" "$npm_config_prefix" "$tmp/pack"
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
mkdir -p "$tmp/web"
git -C "$tmp/web" init -q
logged init factory init --home "$tmp/node" --name demo --owner-name "Test Owner" --project "$tmp/web"
tail -n 3 "$tmp/init.log"

step "doctor"
logged doctor factory doctor --home "$tmp/node"
tail -n 1 "$tmp/doctor.log"

step "deny list"
[ -n "$(find "$tmp/node" -path '*/.git' -prune -o -type f -print | head -n 1)" ] || fail "init wrote no file"
scan() {
  local label="$1" pattern="$2" code=0
  grep -rEiq --exclude-dir=.git -e "$pattern" "$tmp/node" || code=$?
  if [ "$code" -eq 0 ]; then
    fail "a generated file holds $label"
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
printf 'no generated file holds a name from the deny list\n'

# A read-only look at the real folders. A change here is a warning: another program may have written it.
touched=""
for dir in "$real_home/.npm" "$real_prefix/bin" "$real_prefix/lib/node_modules"; do
  if [ -d "$dir" ] && [ -n "$(find "$dir" -maxdepth 3 -newer "$marker" -print 2>/dev/null | head -n 1 || true)" ]; then
    touched="$touched $dir"
  fi
done
if [ -n "$touched" ]; then
  printf 'WARN: these real folders changed during the check:%s\n' "$touched"
fi

printf 'exit check passed\n'
