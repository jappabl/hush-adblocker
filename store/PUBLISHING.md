# Publishing Hush

Everything here is ready except the steps that need your accounts.

## 1. Pick the final name
"Hush" collides with Hush Nag Blocker (a popular Safari blocker). Pick a distinct name, then change it in
`extension/manifest.json` ("name"), `store/listing.md`, and the promo tile text in `store/make-assets.mjs`
(re-run `node store/make-assets.mjs`).

## 2. Put the privacy policy online
The store needs a public URL. Easiest: create a public GitHub Gist (or a GitHub repo page) with the text of
`store/privacy-policy.md`, after filling in your contact email.

## 3. Build the upload
    npm run build      # fresh filter lists
    npm test           # 26 checks, all should pass
    npm run package    # -> dist/hush-<version>.zip

## 4. Chrome Web Store (Chrome, Brave, Arc, Opera…)
1. Register at https://chrome.google.com/webstore/devconsole with your Google account ($5 one-time fee).
2. "New item" → upload `dist/hush-<version>.zip`.
3. Store listing: paste from `store/listing.md`; upload the icon (`extension/icons/128.png`), the three
   screenshots in `store/screenshots/`, and `store/promo-440x280.png` as the small promo tile.
4. Privacy practices: paste from `store/permissions.md`; add the privacy policy URL from step 2.
5. Distribution: Public, all regions. Submit for review (typically a few days; broad host access can take longer).

## 5. Microsoft Edge Add-ons (free)
Register at https://partner.microsoft.com/dashboard/microsoftedge (free), upload the same zip, reuse the same text and images.

## Updates
Bump "version" in `extension/manifest.json`, then repeat step 3 and upload the new zip in the dashboard.
Filter lists don't need store updates: installed copies refresh them every 12 hours.
