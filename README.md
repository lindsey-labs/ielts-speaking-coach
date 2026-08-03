# IELTS Speaking Coach

A GitHub-ready IELTS Speaking desktop app, Codex plugin, and local MCP workflow:

- launch ChatGPT Voice from a Windows or macOS desktop dashboard;
- send the saved IELTS examiner prompt and capture visible conversation text;
- import an IELTS question bank;
- choose Part 1, Part 2, Part 3, or a full mock;
- create a 7-day, 14-day, or 30-day plan;
- generate the same structured review after every session;
- freely continue the last question, move to the next question, or select any historical session;
- save recommended targets and retrain one selected target through transfer;
- automatically ask for a delimited structured review and save it locally;
- review history, recurring issues, vocabulary, optional targets, and progress in the dashboard.

## Privacy and question-bank content

Learner transcripts, recordings, reports, and login state stay on the local computer and are excluded from this repository. The repository ships only a small original sample question bank so the app can run after cloning. Bring your own licensed IELTS question bank through the import workflow; third-party or OCR-extracted commercial question banks are intentionally not included.

IELTS is a trademark of its respective owners. This independent project is not endorsed by or affiliated with the IELTS test partners. ChatGPT is a trademark of OpenAI; this project is not an official OpenAI product.

## Desktop app

Run locally:

```powershell
npm install
npm run desktop
```

The dashboard opens as a desktop window. Click **打开ChatGPT** once and sign in yourself. The login is kept in an Electron persistent browser partition. Then select an IELTS question and click **保存并一键启动Voice**. End Voice in ChatGPT when the practice is complete. The desktop bridge automatically generates and caches the review; click **同步复盘报告** to save it into the local learning record. If automatic generation does not start, click **补生成复盘报告** and then synchronize it.

After a requested review is saved, the desktop bridge immediately refreshes the latest report, practice history, issue archive, vocabulary archive, and optional retraining target without reloading the whole dashboard.

If the report already exists in the currently open ChatGPT conversation, click **同步复盘报告**. The desktop bridge reads that conversation directly and falls back to the clipboard only when necessary. Slightly malformed JSON is repaired when possible before validation and synchronization. The synchronization button never generates a new report; **补生成复盘报告** is the explicit recovery action.

The desktop bridge attempts to locate ChatGPT's current web controls. If ChatGPT changes its interface, the prompt remains available and the learner may need to click Voice manually until selectors are updated.

Build a Windows installer:

```powershell
npm run package:win
```

Build the macOS installers on a Mac:

```bash
npm run package:mac
```

The macOS build produces separate DMG and ZIP artifacts for Intel (`x64`) and
Apple silicon (`arm64`) Macs. A Windows `.exe` cannot run on macOS, and the
macOS artifacts must be built and tested on macOS. Public distribution also
requires Apple Developer ID signing and notarization; unsigned local builds may
be blocked by Gatekeeper.

## Upgrade page

The dashboard includes a highlighted **功能升级** entry below the training navigation.
Set the personal-site destination in `mcp/upgrade-page.json`:

```json
{
  "websiteUrl": "https://your-domain.example/ielts-speaking-coach"
}
```

Only HTTPS destinations are accepted. In the packaged desktop app, the page opens in
the learner's default browser so product copy, checkout, and delivery can be updated
without changing the local dashboard workflow.

The plugin now includes a local STDIO MCP server. It stores selections, reports,
history, and retraining targets on the learner's computer without a hosted
backend.

## Local MCP

Install dependencies once:

```powershell
npm install
```

Run the automated MCP smoke test:

```powershell
npm run test:mcp
```

The local MCP exposes:

- `initialize_ielts_workspace`
- `open_dashboard`
- `set_training_selection`
- `get_training_context`
- `save_session_review`
- `list_practice_history`
- `get_dashboard_data`

By default, learner data is stored under `%LOCALAPPDATA%\IELTS Speaking Coach`
on Windows and Electron's application data directory on macOS. Audio recording
is off by default. When the learner explicitly enables it, microphone-only
recordings are stored locally under the `recordings` folder and can be played or
deleted from the dashboard.

## Button-first practice

Ask Codex to `打开雅思口语仪表盘`. The `open_dashboard`
tool opens `http://127.0.0.1:43127` in the learner's browser. The learner
chooses a route, Part, exact question, length, and optional single goal. In the
desktop app, the learner starts and ends the complete workflow with buttons.

## Prototype boundary

The Skill and MCP do not add Voice by themselves. The optional desktop bridge controls the visible ChatGPT web interface and therefore depends on the learner's ChatGPT access and the current webpage structure. Audio is never stored unless the learner enables the local recording switch.

## Try the dashboard

Open `demo/dashboard.html` in a browser. It contains sample data and demonstrates:

1. choosing a Part and starting a Voice session;
2. reviewing a standardized report;
3. entering a one-target retraining session;
4. browsing history, issue status, and vocabulary records.

## Plugin structure

The installable skill is under `skills/ielts-speaking-coach/`. The plugin manifest is `.codex-plugin/plugin.json`.
