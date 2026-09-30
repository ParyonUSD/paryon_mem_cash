#!/usr/bin/env bash
# Checks that a commit's source compiles to what upstream published to npm.
#
# Usage: scripts/verify-recovery.sh <npm version> [<git ref>]
#   scripts/verify-recovery.sh 0.0.9 HEAD
#
# Versions 0.0.7 to 0.0.9 of @mem-cash/* were published without their source, and this fork
# recovered it from the published builds. Compiling the recovered source with upstream's own
# toolchain (yarn --frozen-lockfile, tsc -b) and comparing every emitted file with the npm tarball
# is what shows the recovery is faithful. The ref is built in a throwaway worktree, from scratch,
# so an incremental build or a stale dist cannot hide a difference.
#
# Exits non-zero when any emitted .js, .d.ts or .map, or any package.json or README, differs. The
# published electrum package carries memCash.* files that no source has produced since 0.0.6;
# they are listed as published-only and do not fail the check.
#
# It works on refs from before the restructure into one package (bf21c89 and earlier), which still
# have the five packages and upstream's yarn toolchain; later commits no longer compile to the
# @mem-cash/* tarballs by design.
set -euo pipefail

version=${1:?usage: verify-recovery.sh <npm version> [<git ref>]}
ref=${2:-HEAD}
repo=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
work=$(mktemp -d)
trap 'git -C "$repo" worktree remove --force "$work/src" >/dev/null 2>&1 || true; rm -rf "$work"' EXIT

git -C "$repo" worktree add --detach "$work/src" "$ref" >/dev/null 2>&1
(cd "$work/src" && yarn install --frozen-lockfile --silent && npx tsc -b)

status=0
for p in types storage validation core electrum; do
	mkdir -p "$work/pub/$p"
	(cd "$work/pub/$p" && npm pack --silent "@mem-cash/$p@$version" >/dev/null && tar xzf ./*.tgz)
	pub=$work/pub/$p/package
	built=$work/src/packages/$p
	identical=0
	differ=""
	orphans=""
	for f in $(cd "$pub/dist" && find . -type f | sort); do
		if [ ! -e "$built/dist/$f" ]; then
			orphans="$orphans ${f#./}"
		elif cmp -s "$pub/dist/$f" "$built/dist/$f"; then
			identical=$((identical + 1))
		else
			differ="$differ ${f#./}"
		fi
	done
	extra=$(comm -13 <(cd "$pub/dist" && find . -type f | sort) <(cd "$built/dist" && find . -type f | sort) | tr '\n' ' ')
	for f in package.json README.md; do
		cmp -s "$pub/$f" "$built/$f" || differ="$differ $f"
	done
	echo "$p@$version: $identical dist files identical; differing:${differ:- none}; built only: ${extra:-none}; published only:${orphans:- none}"
	if [ -n "$differ" ] || [ -n "$extra" ]; then status=1; fi
done
exit $status
