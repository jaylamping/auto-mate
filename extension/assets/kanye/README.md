# Kanye portrait assets

Drop your image files here (`.jpg`, `.png`, `.webp`, etc.), then regenerate the manifest:

```bash
npm run assets:manifest
```

Commit both this folder **and** `extension/sidepanel/kanye-images.js`.

One random image from this folder appears in the top-right of the auto-mate side panel on every load/refresh.

**From your machine:** copy everything from your local assets folder into this directory, e.g.:

```powershell
Copy-Item "C:\Users\joeyl\OneDrive\Desktop\assets\*" "C:\code\auto-mate\extension\assets\kanye\"
cd C:\code\auto-mate
npm run assets:manifest
git add extension/assets/kanye extension/sidepanel/kanye-images.js
git commit -m "Add Kanye portrait assets"
git push
```
