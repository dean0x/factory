#!/usr/bin/env bash
# Install check: install the program from the git commit of this checkout, as a developer does, and check the installed program.
# The flow: push the commit of HEAD into a throw-away bare repo, run npm install --global on its git+file URL (the prepare
# script builds dist/factory.js), then compare the installed dist/factory.js with the build of this checkout.
# It runs the install scripts of the packages from the npm registry, so it needs the network.
# The real HOME, the real XDG state folder, the real tmux server, the real npm prefix and the real npm cache are never written.
# The source repo is never written. A local tree that differs from HEAD fails the compare by intent.
# Keep the isolation block equal to scripts/exit-check.sh. A unit test keeps them equal.
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

tmp="$(mktemp -d "${base%/}/factory-install-check.XXXXXX")"
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
unset GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN ANTHROPIC_BASE_URL TMUX FACTORY_HOME FACTORY_SESSION SSH_AUTH_SOCK ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
mkdir -p "$HOME" "$XDG_STATE_HOME" "$TMUX_TMPDIR" "$npm_config_prefix"
printf 'registry=https://registry.npmjs.org/\n' >"$npm_config_userconfig"
: >"$npm_config_globalconfig"
git config --file "$GIT_CONFIG_GLOBAL" user.name "Test Owner"
git config --file "$GIT_CONFIG_GLOBAL" user.email "test.owner@example.com"
git config --file "$GIT_CONFIG_GLOBAL" init.defaultBranch main
export PATH="$npm_config_prefix/bin:$PATH"

# The commit id comes from HEAD of this checkout, never from an environment value or an argument.
sha="$(git -C "$root" rev-parse HEAD)"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || fail "the commit id of HEAD is not 40 lower-case hex characters: $sha"

step "source repo"
# The copied isolation sets init.defaultBranch main, so the HEAD of the new bare repo would point to an unborn branch,
# and the clone of npm compares the wanted commit with the HEAD line of the repo. The symbolic-ref line fixes that.
# A command that runs in "logged" ignores set -e, so the steps are joined with && and the first failure ends the function.
make_source() {
  git init -q --bare "$tmp/source.git" &&
    git --git-dir="$tmp/source.git" config receive.shallowUpdate true &&
    git -c core.hooksPath=/dev/null -C "$root" push -q "$tmp/source.git" "$sha:refs/heads/install-proof" &&
    git --git-dir="$tmp/source.git" symbolic-ref HEAD refs/heads/install-proof
}
logged source make_source

step "install from git"
logged install npm install --global --no-audit --no-fund "git+file://$tmp/source.git#$sha"

step "installed program"
found="$(command -v factory || true)"
[ "$found" = "$npm_config_prefix/bin/factory" ] || fail "factory on PATH is '$found', expected $npm_config_prefix/bin/factory"
installed_js="$npm_config_prefix/lib/node_modules/@dean0x/factory/dist/factory.js"
[ -f "$installed_js" ] || fail "the installed package has no dist/factory.js"
[ -x "$installed_js" ] || fail "the installed dist/factory.js is not executable"
cmp -s "$installed_js" "$root/dist/factory.js" || fail "the installed dist/factory.js differs from dist/factory.js of the source tree. Build from a clean tree with: npm run build"
installed="$(factory version)"
[ "$installed" = "$version" ] || fail "factory version prints $installed, expected $version"
logged help factory --help
printf 'installed factory %s from commit %s\n' "$installed" "$sha"

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

printf 'install check passed\n'
