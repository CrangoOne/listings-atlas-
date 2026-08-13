# Push this site to GitHub Pages (no special tools)

Use **Git Bash** (installed with Git for Windows), not PowerShell.

```bash
git clone https://github.com/CrangoOne/Cursor.git
cd Cursor
git fetch origin cursor/listings-atlas-pages-pack-1a84
git checkout cursor/listings-atlas-pages-pack-1a84

# Option A — helper script
bash scripts/push-listings-atlas-public.sh

# Option B — manual (if the script still fails)
rm -rf /tmp/listings-atlas-push
git clone https://github.com/CrangoOne/listings-atlas-.git /tmp/listings-atlas-push
cd /tmp/listings-atlas-push
git checkout -B main
rm -rf assets data index.html README.md
cp -R "$OLDPWD/listings-atlas-public/." .
git add -A
git commit -m "Update Listings Atlas Pages site"
git push -u origin main
```

Then open:
https://github.com/CrangoOne/listings-atlas-/settings/pages  
→ Deploy from a branch → **main** / **(root)** → Save  

Site: https://crangoone.github.io/listings-atlas-/
