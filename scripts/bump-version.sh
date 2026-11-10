#!/bin/sh
# Bump the asset version used in index.html and in every relative module import.
# GitHub Pages caches JS for ~10 minutes; a new specifier forces a fresh fetch.
#
#   scripts/bump-version.sh 20261110e
#
set -eu
version="${1:?usage: scripts/bump-version.sh <version>}"
cd "$(dirname "$0")/.."

perl -pi -e "s/\\?v=[0-9A-Za-z]+/?v=${version}/g" index.html
for file in js/*.js; do
  perl -pi -e "s{(from \"\\./[a-z-]+\\.js)(\\?v=[0-9A-Za-z]+)?\"}{\$1?v=${version}\"}g" "$file"
done

grep -n "?v=${version}" index.html
grep -rn "?v=${version}" js | head -20
