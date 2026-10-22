# Installomator Labels

A searchable catalog of every [Installomator](https://github.com/Installomator/Installomator) label, built from the
[`fragments/`](https://github.com/Installomator/Installomator/tree/main/fragments) folder.

No framework and no dependencies. It's a static page (`index.html` + `app.js`) and one parser (`parse.js`) shared by the
browser and the build script.

## How the data gets in

- **Daily snapshot (default).** `.github/workflows/pages.yml` checks out Installomator every day, runs
  `scripts/build-labels.mjs`, and deploys the page plus `data/labels.json` to GitHub Pages. The snapshot covers
  active, disabled and broken labels, plus added/updated dates from git history and the fragment file path.
- **Live fallback.** If `data/labels.json` isn't there, the page fetches the assembled `Installomator.sh` from
  `main` on raw.githubusercontent.com and parses the labels in the browser. That gives you active labels only, with
  no dates, and is a little behind the fragments until upstream reassembles the script.

## Run locally

```sh
git clone --filter=blob:none https://github.com/Installomator/Installomator.git installomator
node scripts/build-labels.mjs installomator      # writes data/labels.json (~20s)
python3 -m http.server 8000                     # open http://localhost:8000
```

Skip the first two lines to try the live fallback instead.

## Deploy

Push to GitHub, then go to **Settings → Pages → Source: GitHub Actions**. The workflow runs on every push, daily at
03:17 UTC, and on demand from the Actions tab.


## Search syntax

Plain words match the app name, label, aliases, team ID, package ID, download host and GitHub repo. Filters:
`team:UBF8T346G9`, `type:pkg`, `host:dl.google.com`, `gh:microsoft`, `pkg:com.adobe`, `status:disabled`,
`label:firefoxpkg`. Press `/` to focus search and `Enter` to open the top result. Every view is a shareable URL, and
`#label` opens a label directly.

## Parser notes

- A label is the case header, not the filename: 56 fragments are named differently from the label they define
  (e.g. `dialog.sh` defines `swiftdialog`). Multi-line alias headers (`chatgpt|\` / `codex)`) are supported.
- Download source is classified as GitHub (`downloadURLFromGit`/`versionFromGit`), Sparkle (appcast), fixed URL, or
  scripted.
- The first assignment of each field wins, so arch-branching labels show their first branch. The full source is
  always shown underneath.
