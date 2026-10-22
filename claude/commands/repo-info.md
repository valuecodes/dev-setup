---
description: Work out what this repo is about, grill the user on audience and pitch, then draft the GitHub Description, Website and Topics to paste into "Edit repository details" (nothing is written to GitHub)
argument-hint: "[hint about audience or focus]"
disable-model-invocation: true
allowed-tools: Read, Write, Edit, Glob, Grep, Task, AskUserQuestion, Bash(gh:*), Bash(git:*), Bash(ls:*), Bash(mkdir:*), Bash(cat:*), Bash(head:*), Bash(grep:*), Bash(wc:*)
---

Draft the three fields of GitHub's **Edit repository details** form (Description, Website, Topics) for the current repo: explore the code to find out what it is → ask the user the few decisions that are theirs → write the draft to a local file → check it for anything sensitive → print the values to paste.

**This command never writes to GitHub.** Updating those fields needs the _Administration: Read and write_ repository permission, which also allows deleting the repo, changing visibility, branch protection, collaborators, webhooks and deploy keys. The token intentionally lacks it. Do not run `gh repo edit`, do not print a `gh repo edit` command, and do not suggest adding the permission. The user pastes the values into the form.

**Hard rules** (inherited from `~/.claude/commands/ship-feature.md`): emit `gh`/`git` commands that start with the tool name, with literal values inlined, no `$(…)`, no leading `VAR=` assignments; change files only with the Edit and Write tools.

Arguments: `$ARGUMENTS` — an optional hint about the audience or what to emphasise.

## Phase 0 — Pre-flight (read-only)

1. `gh auth status` must succeed, else STOP (`gh auth login`). Reading repository details only needs Metadata: Read.
2. `gh repo view --json owner,name,visibility,description,homepageUrl,repositoryTopics` → print the current values under **Current** so the user sees what the draft replaces (empty fields print as `(empty)`).
3. `mkdir -p <repo-root>/.plans`; if `git -C <repo-root> check-ignore .plans` does not match, append `.plans/` to `<repo-root>/.git/info/exclude` (local only, never committed).

## Phase 1 — Explore (facts are yours to find, never the user's)

One Explore subagent reads, as far as each exists: `README.md`, `AGENTS.md`, the root `package.json`, every workspace `package.json` (`name`, `description`), `apps/*` and `packages/*` at the top level, `LICENSE`, `.plans/*/plan.md` and `.plans/*/epic.md` (the product direction often lives there before the code does), and the Phase 0 output. It returns:

- one paragraph **what this repo is** (product, not tooling);
- the **audience** the code implies (end users, contributors, both);
- the **stack**, 3–6 nouns (for example Tauri 2, React, TypeScript, Turborepo, Ollama);
- **URL candidates** found in the repo (README links, a `homepage` field), each with where it was found;
- anything that is **not public-safe** to mention: employer or internal names, people, emails, internal hostnames. These never reach the draft.

Keep the findings; they feed the questions and the draft.

## Phase 2 — Grill (at most two rounds)

Number the questions and give a recommended answer for each, worded so that "yes" accepts your recommendation. Put them to the user with `AskUserQuestion` (at most 4 questions per call, the recommended option first and marked `(Recommended)`, one line of reasoning in each option description).

**Round 1**, always:

1. **Audience** — who should find this repo (end users, contributors, both). Recommend what Phase 1 implies.
2. **Pitch angle** — describe _what it is_ (product noun first) or _what it is for_ (problem first). Recommend one, with a draft sentence as the option description.
3. **Website** — one of: a URL found in Phase 1, leave empty, or the user supplies one. Recommend "leave empty" when nothing was found.
4. **Topic emphasis** — problem domain first, stack first, or balanced. Recommend balanced with the domain topics first.

**Round 2** only if an answer opens a new question (a supplied URL that changes the pitch, an audience that changes the wording). Otherwise skip it.

**Close.** Write one sentence of shared understanding and confirm it with one `AskUserQuestion` (`Draft from this?`: `Yes (Recommended)` / `Not yet`). Do not write the draft before the yes.

## Phase 3 — Draft (local file)

Write `<repo-root>/.plans/repo-info.md` with the Write tool:

```
## Description
<one sentence>

## Website
<URL or (leave empty)>

## Topics
<one topic per line>
```

Rules for the content:

- **Description**: at most 350 characters, one sentence, plain words, product noun early, no emoji, no "A repo for" / "This repository", no trailing marketing. Check the length with `wc -m` on the line (`grep -A1 '^## Description' <repo-root>/.plans/repo-info.md | tail -n 1 | wc -m`) and print the count.
- **Website**: a full `https://` URL or the literal `(leave empty)`. Never an internal or employer URL.
- **Topics**: lowercase, letters, digits and hyphens only (`^[a-z0-9-]{1,50}$`), at most 20, most specific first. Prefer topics that already exist on GitHub (for example `tauri`, `desktop-app`, `local-first`, `privacy`, `ollama`, `llm`, `typescript`, `react`, `turborepo`) over invented ones. Check every line with `grep -vE '^[a-z0-9-]{1,50}$'` over the topic lines and fix any that print.
- No employer or person names, no emails, no internal hostnames or paths anywhere in the file.

## Phase 4 — Sensitive-content check

The repo may be public, and the fields are world-readable once pasted. Run one grep over the draft: `grep -nEi '[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|/home/|C:\\Users|([0-9]{1,3}\.){3}[0-9]{1,3}|https?://|passwd|password|secret|token|api[_-]?key|bearer|BEGIN .*PRIVATE KEY' <repo-root>/.plans/repo-info.md`. Drop hits that are `127.0.0.1`, `https://github.com/` or the Website URL the user chose in Phase 2, and list the rest as `line: text`. Each remaining hit is edited out of the file, or the user explicitly accepts it in Phase 5.

## Phase 5 — Present

Print the three values in one copy-friendly block, each under its form label, then the description character count, the topic count, and any accepted Phase 4 hits:

```
Description (<n>/350)
<text>

Website
<URL or leave empty>

Topics (<n>/20)
<topic> <topic> <topic> …
```

End with: `Paste these into Settings → Edit repository details (needs Administration permission, which the token intentionally lacks). Draft saved at .plans/repo-info.md.`

Then one `AskUserQuestion` (`Anything to change?`: `Done (Recommended)` / `Edit`). On Edit, apply the change to the file with Edit, re-run Phase 3's checks and Phase 4, and reprint.
