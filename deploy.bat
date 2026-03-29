@echo off
echo --- Preparation: Cleaning up and Adding files ---
git add .
git add --all
git commit -m "Final Fix: Porting Bot to Node.js cleanly"
echo --- Pushing to GitHub Main ---
git push origin main --force
echo --- Done! Please check Render Dashboard now ---
pause
