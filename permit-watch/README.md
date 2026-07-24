# Petah Tikva permit watcher

This watcher checks these municipality requests every morning:

- `20240342`
- `20260298`

It opens the actual JavaScript application in Chromium, stores a normalized text snapshot for each request, and compares the new result with the previous snapshot. A GitHub issue is created only when visible content changes or when the checker cannot read the site.

## Schedule

The workflow runs daily at **08:17 Asia/Jerusalem**. The non-round minute reduces the chance of GitHub Actions congestion.

## First run

After the pull request is merged into the default branch:

1. Open **Actions → Petah Tikva permit watcher**.
2. Choose **Run workflow**.
3. The first successful run saves a baseline and does not send a change alert.
4. Run it once more with `force_notify` enabled to verify GitHub issue notifications.

## Browserbase fallback

The default mode uses free GitHub-hosted Chromium. If the municipality blocks GitHub's browser, add either or both repository secrets:

- `BROWSERBASE_API_KEY` — required
- `BROWSERBASE_PROJECT_ID` — optional; Browserbase can infer it from the API key

When the API key exists, the same watcher automatically uses a proxied Browserbase browser in the EU region. No code change is required.

## What is stored

- `state/request-<id>.json` — last successful normalized snapshot
- Workflow artifact — screenshots, machine-readable result, and the human-readable report
- GitHub issue — the exact added and removed visible lines when a change is detected

Failed or blocked pages do not replace the last successful snapshot.
