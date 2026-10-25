# Anvil - Tester Guide

Anvil is your testing app. You open one pull request (PR), Anvil checks what a machine can check reliably, gives you
a short list of things only a person can judge, and at the end writes the report for you. You press one button to
send it.

You never need to type commands after the first setup. Everything happens in Claude Code (two words) and in the
Anvil window.

---

## 1. One-time setup (about 5 minutes)

You need: **Git**, the **GitHub CLI** (`gh`), **Node.js 20+**, **Chrome or Edge**, and **Claude Code**.
Your project may need more to run its app (for example PHP or Python) - the project's README says what.

1. Sign in to GitHub in a terminal: `gh auth login` (GitHub.com, HTTPS, browser).
2. Install the Anvil skill into Claude Code - this copies one instruction file, it runs no code:

   **Windows (PowerShell)**
   ```powershell
   New-Item -ItemType Directory -Force "$HOME\.claude\skills\anvil" | Out-Null
   Invoke-WebRequest https://raw.githubusercontent.com/yoriichiee/anvil/main/skill/anvil/SKILL.md -OutFile "$HOME\.claude\skills\anvil\SKILL.md"
   ```
   **macOS / Linux**
   ```bash
   mkdir -p ~/.claude/skills/anvil
   curl -fsSL https://raw.githubusercontent.com/yoriichiee/anvil/main/skill/anvil/SKILL.md -o ~/.claude/skills/anvil/SKILL.md
   ```
3. Open Claude Code and say: **`download anvil`**. Claude downloads Anvil into `~/.anvil` and installs what it needs.

That's it. To get a newer version later, say **`update anvil`**.

## 2. Testing a PR

1. Open Claude Code in your project's folder (or anywhere - Claude will find it).
2. Say **`start anvil`**. Claude finds the PR assigned to you for testing (if there are several, it asks which one;
   you can also say `start anvil 42`), gets the code, starts the app, writes the test plan for this PR, and opens
   Anvil in Chrome.
3. Work in Anvil (below). When you are finished, say **`stop anvil`**.

If something is not set up (the app not starting, a missing tool), Anvil shows a coloured dot at the top right - click
it for the fix in plain words, or ask Claude.

## 3. The Anvil window

### The ribbon (top row)
| Tool | What it does |
|---|---|
| Role | See the app as another user (for example admin, member, guest) on the same page |
| Page | Jump to any page; the list shows the pages this PR changed |
| ← ⟳ | Back and reload inside the app |
| Phone · Tablet · Laptop · Fit | Show the app at 390, 820 or 1440 px wide; ⟲ rotates |
| Screenshot | Exact picture of what you see (Chrome asks once to share the tab - allow it) |
| Attach | Screenshot and attach it to the check you are on |
| ⚠ number | Errors seen while you tested (console, page, failed requests) - click for the list |
| ☑ | Open / close your checklist |
| Dashboard | Overview, automatic checks, screenshots, tools, and Complete |

### Test view
The app being tested runs inside Anvil, below the ribbon. Anvil notices the pages you visit and any errors, so the
report can mention them. It only sees the app inside Anvil - nothing else on your computer.

### Your checks (the drawer on the right)
Each check tells you **why it matters**, the **steps**, and **what good looks like**. Answer with
**Works**, **Broken** or **Not sure**, add a note if useful (needed for Broken), and attach a screenshot.
**Next check** opens the right page as the right user at the right size for you.

Two kinds of checks:
- **Checks written for this PR** - what the task asked for, what the developer added, and what matters most for this
  part of the product.
- **Page looks** - for **every page the PR adds or changes, one check on laptop and one on phone**, for each user
  type that can open it. Look at the whole page, try every button, link and form, scroll to the end.

### Automatic checks
These start by themselves and only report facts:
- the project's tests (a failed test is re-run once; "Passed on retry" = flaky, "Broken on main too" = not this PR's fault)
- the build, and the PR's CI status on GitHub
- every changed page loads for each allowed user on phone and laptop, without errors or failed requests
- the phone layout has no sideways scrolling
- basic accessibility (images without descriptions, unnamed buttons and links, unlabeled fields)
- users who must not see something are refused (for example a guest asking for admin data)
- a switched-off feature really is off

**Live:** the run panel shows what is running right now, a live log, and the newest screenshot.
**Stop** stops the run (finished results are kept); **Run remaining** continues later.
**Check it myself:** if you doubt an automatic result, open it, look yourself, and mark it **Pass** or **Fail** with a
note. The report shows it as "checked by hand" and also shows what the automatic check said.

### Tools
Screenshot any page as any user and size, compare phone/tablet/laptop side by side, copy sign-in links, and reset the
demo data (puts the app's sample data back the way it started).

## 4. Finishing and sending the report

1. **Complete testing** unlocks when the automatic checks have finished (or you stopped them) and every check has an
   answer. It tells you exactly what is left.
2. You get the **summary**: a score out of 5 for *works as asked, user access, phone, laptop, stability*, the counts,
   and anything **not checked**. Add **your own star rating** and a **note to the developer**.
3. The big button:
   - **Send for final review** (green) - nothing blocking was found.
   - **Send back to developer** (amber) - something must be fixed first. Anvil decides this from the results, not
     from opinion: a broken required feature, a user seeing what they should not, a failing test or build.
4. You see the **full report before it is sent** and can edit it. Confirm to post it on the PR on GitHub.
   - The report is written by Claude from the real results only; it cannot add results that did not happen.
   - A "send back" report includes a **fix brief** the developer's Claude can read and work through (`/fix-pr`).
5. After sending, Anvil gives you:
   - a **short chat note** (rating, decision, link to the report) - Copy, then paste it in your team chat;
   - **screens.png** - one image with the screenshots; drag it into the GitHub comment and the chat.

## 5. Good habits

- Use the demo/sample data only. Never test with real people's data, passwords or keys.
- Write notes a developer can act on: what you did, what you expected, what happened.
- "Not sure" is fine - say why in the note. Guessing "Works" is not.
- If an automatic check looks wrong, use **Check it myself** instead of ignoring it.
- Test as every user type the check mentions, on both phone and laptop.

## 6. Trouble?

| Problem | What to do |
|---|---|
| Anvil says the app is not running | Click the red dot - it shows the start command - or ask Claude "start the app" |
| The app inside Anvil is blank | Press ⟳ in the ribbon; if it stays blank, the app may be down (see above) |
| Screenshot asks to share | Allow "this tab"; Chrome asks once per session. Refused? Anvil takes a clean capture instead |
| Complete stays locked | It lists what is left: an unanswered check, or checks still running |
| Send failed | Check you are signed in (`gh auth status`) and try again - parts already posted are not posted twice |
| Anything else | Ask Claude in the same window: "why did check R-r2 fail?" - it can read Anvil's results |

## 7. Try it without a project

The repo includes **Acme Notes**, a small demo app with four deliberate bugs. See `examples/acme-notes/README.md`
to run Anvil against it and watch it find them.
