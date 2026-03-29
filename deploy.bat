@echo off
echo --- Pushing updates to GitHub ---
git add .
git commit -m "Update Chat ID system and fix Python bot tokens"
git push origin main
echo --- Done! Render will start deploying soon. ---
pause
