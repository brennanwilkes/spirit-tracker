rm -rf .git .worktrees
rm -rf data/db reports
bash scripts/repo_setup.sh --force

git remote add origin git@github.com:brennanwilkes/spirit-tracker.git
git push -u origin main --force
git push -u origin data --force
