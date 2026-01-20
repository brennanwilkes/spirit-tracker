#!/usr/bin/env bash
set -euo pipefail

MAIN_BRANCH="${MAIN_BRANCH:-main}"
DATA_BRANCH="${DATA_BRANCH:-data}"

FORCE=0
if [[ "${1:-}" == "--force" ]]; then
  FORCE=1
fi

if [[ -d .git ]]; then
  if [[ $FORCE -eq 1 ]]; then
    rm -rf .git
  else
    echo "ERROR: .git already exists. Remove it first or run: $0 --force" >&2
    exit 1
  fi
fi

git init -q
git branch -M "$MAIN_BRANCH"

mkdir -p data/db reports .worktrees viz/data

# Move existing DB snapshots (e.g. kwm__scotch__2b16b533.json) into data/db so
# they don't end up committed on the main branch.
shopt -s nullglob
for f in *__*__*.json; do
  mv -f "$f" data/db/
done
shopt -u nullglob

# Ensure expected runtime dirs exist (they are ignored on main).
mkdir -p data/db reports viz/data

# Move old root-level DB JSONs into data/db if present.
shopt -s nullglob
for f in *.json; do
  if [[ "$f" =~ __[0-9a-f]{8}\.json$ ]]; then
    mv -f "$f" "data/db/$f"
  fi
done
shopt -u nullglob

cat > .gitignore <<'GITIGNORE'
node_modules/
*.log

# Data & reports live on the data branch
/data/
/reports/

.worktrees/

# Generated viz artifacts live on the data branch
viz/data/

# Keep cron log out of git even on data branch
reports/cron.log
GITIGNORE

# Make sure scripts/tools are executable (best effort)
chmod +x bin/tracker.js 2>/dev/null || true
chmod +x scripts/*.sh 2>/dev/null || true
chmod +x tools/*.js 2>/dev/null || true

git add -A
if git diff --cached --quiet; then
  echo "Nothing to commit on $MAIN_BRANCH (did you already commit?)" >&2
else
  git commit -m "chore: initial code" -q
fi

# Create data branch, un-ignore data and reports (and viz/data).
if git show-ref --verify --quiet "refs/heads/$DATA_BRANCH"; then
  echo "Data branch already exists: $DATA_BRANCH" >&2
else
  git checkout -b "$DATA_BRANCH" -q

  cat > .gitignore <<'GITIGNORE'
node_modules/
*.log

# Keep cron log out of git
reports/cron.log
GITIGNORE

  git add .gitignore
  git commit -m "chore: enable tracking of data + reports + viz on data branch" -q

  git checkout "$MAIN_BRANCH" -q
fi

echo "Repo setup complete. Main=$MAIN_BRANCH Data=$DATA_BRANCH"
