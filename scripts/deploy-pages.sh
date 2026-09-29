#!/usr/bin/env bash
# Build the password-protected site and publish it as the `gh-pages` branch.
#
#   SITE_PASSWORD='your long password' npm run deploy:pages
#
# The branch holds only generated files (the login page + ciphertext), never the source or the
# password, and is rewritten from scratch on every deploy. In the repo settings, set
# Pages -> Source: "Deploy from a branch" -> gh-pages / (root).
set -euo pipefail
cd "$(dirname "$0")/.."
: "${SITE_PASSWORD:?Set SITE_PASSWORD (12+ characters)}"

OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
node scripts/build-protected.js "$OUT"

REMOTE="$(git remote get-url origin)"
NAME="$(git config user.name || echo 'Handwriting Engine deploy')"
EMAIL="$(git config user.email || echo 'deploy@users.noreply.github.com')"

cd "$OUT"
git init -q -b gh-pages
git add -A
git -c user.name="$NAME" -c user.email="$EMAIL" commit -q -m "Deploy protected site"
git push --force "$REMOTE" gh-pages
echo "Published branch gh-pages."
