#!/usr/bin/env bash
# Make the fixture of a FAC-M1 node (schema 1): test/fixtures/node-0.1.0/.
# There is no 0.1.0 tag, so the script builds the CLI from the commit of FAC-M1 in a throw-away folder,
# runs "init" with it, and copies the node without its state repository (.factory/.git).
# Run it by hand. The tests use the committed fixture and need no network.
# The real HOME, the real git config and the real npm cache are never touched.
# It needs the installed packages of this repository: npm ci
set -euo pipefail

# The last commit of FAC-M1 (the commit that has the 0.1.0 CLI).
m1_commit="4849465858839f057cd8328c069d1425fa62a9b0"

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
base="${FACTORY_TMP:-${TMPDIR:-/tmp}}"
dest="$root/test/fixtures/node-0.1.0"
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

command -v node >/dev/null 2>&1 || fail "node is not on PATH"
command -v git >/dev/null 2>&1 || fail "git is not on PATH"
[ -d "$root/node_modules" ] || fail "node_modules is missing. Run: npm ci"
git -C "$root" cat-file -e "$m1_commit^{commit}" 2>/dev/null || fail "the commit $m1_commit is not in this repository"

tmp="$(mktemp -d "${base%/}/factory-m1-fixture.XXXXXX")"

# Everything below runs in the throw-away folder.
export HOME="$tmp/home"
export XDG_CONFIG_HOME="$HOME/.config"
export GIT_CONFIG_GLOBAL="$HOME/.gitconfig"
export GIT_CONFIG_NOSYSTEM=1
export GH_CONFIG_DIR="$HOME/gh"
export NO_COLOR=1
unset GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN ANTHROPIC_BASE_URL
mkdir -p "$HOME" "$tmp/source" "$tmp/work"
git config --file "$GIT_CONFIG_GLOBAL" user.name "Test Owner"
git config --file "$GIT_CONFIG_GLOBAL" user.email "test.owner@example.com"
git config --file "$GIT_CONFIG_GLOBAL" init.defaultBranch main

step "build the CLI of $m1_commit"
git -C "$root" archive "$m1_commit" | tar -x -C "$tmp/source"
ln -s "$root/node_modules" "$tmp/source/node_modules"
build() { (cd "$tmp/source" && node build.mjs); }
logged build build
[ -f "$tmp/source/dist/factory.js" ] || fail "the build made no dist/factory.js"
(cd "$tmp/source" && node dist/factory.js version >"$tmp/version.txt") || fail "the built CLI does not run"
step "version: $(cat "$tmp/version.txt")"

step "make the project and the node"
git init -q -b main "$tmp/work/web"
git -C "$tmp/work/web" commit -q --allow-empty -m "init"
logged init node "$tmp/source/dist/factory.js" init \
  --home "$tmp/work/node" --name demo --owner-name "Test Owner" --project "$tmp/work/web"
[ -f "$tmp/work/node/factory.yaml" ] || fail "init made no factory.yaml"

step "copy the node to $dest"
rm -rf "$dest"
mkdir -p "$dest"
cp -R "$tmp/work/node/." "$dest/"
rm -rf "$dest/.factory/.git"

# The fixture must not hold a path of this machine.
if grep -rIl -e "$tmp" -e "$root" "$dest" >/dev/null 2>&1; then
  grep -rIl -e "$tmp" -e "$root" "$dest" >&2 || true
  fail "the fixture holds a path of this machine"
fi

step "done"
find "$dest" -type f | sed "s|^$dest/||" | sort
