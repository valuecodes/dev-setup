#!/usr/bin/env node
// PreToolUse hook: auto-approve a fixed set of exact command shapes. Anything else falls
// through to the normal permission rules and prompt.
//
// The command is split on `;`, `&&`, `||` and `|` (quote-aware) and approved only if every
// segment matches one of these forms:
//
//   pnpm -C <path>/.worktrees/<name> [--filter <pkg>] <lint|typecheck|build|format|...> [args]
//   git  -C <path>/.worktrees/<name> <status|diff|log|show> [args]
//   git  -C <path>/.worktrees/<name> add [args]   (no force / interactive flags)
//   git  -C <path>/.worktrees/<name> [-c commit.gpgsign=false] commit [-q] -m "<msg>" [-m "<msg>"]...
//   git [-C <repo>] <status|diff|log|show|rev-parse> [args]   (<repo>: see repoDir below)
//   git [-C <repo>] grep [-<flags>] '<pattern>' [-- <pathspec>...]
//   git [-C <repo>] branch --list <ref> | branch -vv | branch --show-current
//   git [-C <repo>] remote get-url <name>
//   git [-C <root>] worktree add .worktrees/<name> -b <branch> [<sha>] | worktree list
//   git [-C <repo>] fetch|ls-remote <https://github.com/o/r[.git] | https origin> [<ref>...]
//   gh <pr view|pr diff|pr checks|pr list|run view|run list|issue view|issue list|
//       release view|release list|repo view> [args]
//   cp -al [<path>/]node_modules <path>/.worktrees/<name>[/<path>]/node_modules
//   gh api <endpoint> [--paginate] [--slurp] [--jq '<expr>']            (GET only)
//   gh api graphql -f|-F key=value... [--paginate] [--jq '<expr>']      (no mutations, no @file)
//   grep -<flags> '<pattern>' <file>...      (files resolve to a path inside a .plans/ folder)
//   gitleaks dir --redact --no-banner <path> (path inside a .plans/ folder) | gitleaks version
//   ps ... | pgrep ... | readlink [-f] <path> | ss -ltnp | sleep <N> | echo ... | true
//   kill -- -<N>    (N is the process group of the live dev server recorded in .plans/dev.pid)
//
// A segment after `|` must be a filter: head/tail [-N], grep '<pattern>' (no files), wc,
// sort, uniq [-c], jq '<filter>'. `2>&1` is allowed anywhere. Two whole-command forms are
// matched literally: the settings.json validity check, and the dev-server start
//   setsid nohup pnpm -C <path>/.worktrees/<name> --filter <pkg> dev > [<cwd>/].plans/dev[/<name>].log 2>&1 &
// (the log's real parent must be <cwd>/.plans or <cwd>/.plans/dev, and not a symlink).

import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

type Word = { raw: string; text: string; plain: boolean };
type Segment = { words: Word[]; piped: boolean };
type Ctx = { cwd: string };

const SEG = "[A-Za-z0-9._-]+";
const WORKTREE = `(?:(?:/|\\./)?(?:${SEG}/)*)?\\.worktrees/${SEG}(?:/${SEG})*`;
const PNPM_FILTER = "[A-Za-z0-9@/._-]+";

// ---------------------------------------------------------------------------------------
// Whole-command literal forms

const DEV_SERVER = new RegExp(
  `^setsid nohup pnpm -C ${WORKTREE} --filter ${PNPM_FILTER} dev > ([A-Za-z0-9._/-]+) 2>&1 &$`
);
const DEV_LOG = new RegExp(`^\\.plans/dev(?:\\.log|/${SEG}\\.log)$`);

// The log must land in <cwd>/.plans or <cwd>/.plans/dev for real (no symlinked folder or
// symlinked log file pointing elsewhere).
function devServer(cmd: string, ctx: Ctx): string | false {
  const target = DEV_SERVER.exec(cmd)?.[1];
  if (!target) return false;
  const prefix = ctx.cwd.replace(/\/+$/, "") + "/";
  const rel = target.startsWith(prefix) ? target.slice(prefix.length) : target;
  if (!DEV_LOG.test(rel)) return false;
  try {
    const root = realpathSync(ctx.cwd);
    const parent = realpathSync(join(ctx.cwd, dirname(rel)));
    if (
      parent !== join(root, ".plans") &&
      parent !== join(root, ".plans", "dev")
    )
      return false;
    try {
      if (!lstatSync(join(ctx.cwd, rel)).isFile()) return false;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") return false;
    }
    return "dev server start in a worktree";
  } catch {
    return false;
  }
}
const SETTINGS_CHECK = `node -e 'JSON.parse(require("fs").readFileSync(process.env.HOME+"/.claude/settings.json","utf8")); console.log("valid")'`;

// ---------------------------------------------------------------------------------------
// Tokenizer. Follows bash quoting: single quotes are literal; inside double quotes `$`,
// backtick and `\` still expand, so they are refused; outside quotes anything that could
// expand, redirect, background, group or glob is refused. Returns null to refuse.

const FORBIDDEN_UNQUOTED = "$`\\(){}<#*[]\n\r";

function parse(cmd: string): Segment[] | null {
  const segments: Segment[] = [];
  let words: Word[] = [];
  let piped = false;
  let raw = "";
  let text = "";
  let plain = true;
  let inWord = false;

  const endWord = () => {
    if (inWord) words.push({ raw, text, plain });
    raw = "";
    text = "";
    plain = true;
    inWord = false;
  };
  const endSegment = (nextPiped: boolean) => {
    endWord();
    if (words.length === 0) return false;
    segments.push({ words, piped });
    words = [];
    piped = nextPiped;
    return true;
  };

  for (let i = 0; i < cmd.length; i++) {
    const c = cmd.charAt(i);
    if (c === "'") {
      const end = cmd.indexOf("'", i + 1);
      if (end < 0) return null;
      raw += cmd.slice(i, end + 1);
      text += cmd.slice(i + 1, end);
      plain = false;
      inWord = true;
      i = end;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < cmd.length && cmd[j] !== '"'; j++)
        if ("$`\\".includes(cmd.charAt(j))) return null;
      if (j >= cmd.length) return null;
      raw += cmd.slice(i, j + 1);
      text += cmd.slice(i + 1, j);
      plain = false;
      inWord = true;
      i = j;
    } else if (c === " " || c === "\t") {
      endWord();
    } else if (c === ";") {
      if (!endSegment(false)) return null;
    } else if (c === "&") {
      if (cmd[i + 1] !== "&") return null;
      i++;
      if (!endSegment(false)) return null;
    } else if (c === "|") {
      const isOr = cmd[i + 1] === "|";
      if (isOr) i++;
      if (!endSegment(!isOr)) return null;
    } else if (c === ">") {
      // Only `2>&1`, with the `2` as its own word.
      const after = cmd[i + 3];
      const isStderrDup =
        inWord &&
        plain &&
        raw === "2" &&
        cmd.slice(i + 1, i + 3) === "&1" &&
        (after === undefined || " \t;|".includes(after));
      if (!isStderrDup) return null;
      raw = "";
      text = "";
      inWord = false;
      i += 2;
    } else if (FORBIDDEN_UNQUOTED.includes(c)) {
      return null;
    } else if (c === "~" && (!inWord || "=:".includes(raw.at(-1) ?? ""))) {
      return null; // tilde expansion: at word start or after = / : (HEAD~1 is fine)
    } else {
      raw += c;
      text += c;
      inWord = true;
    }
  }
  if (!endSegment(false)) return null;
  return segments;
}

// ---------------------------------------------------------------------------------------
// Helpers

const joined = (s: Segment) => s.words.map((w) => w.raw).join(" ");
const singleQuoted = (w?: Word) => !!w && /^'[^']*'$/.test(w.raw);
const plainMatch = (w: Word | undefined, re: RegExp) =>
  !!w && w.plain && re.test(w.text);
const PATH = /^[A-Za-z0-9._/-]+$/;

// Resolve symlinks and require the real target to sit inside a `.plans/` folder under the
// session's cwd (not another project's drafts).
function inPlans(p: string, ctx: Ctx, allowDir = false): boolean {
  try {
    const real = realpathSync(isAbsolute(p) ? p : join(ctx.cwd, p));
    const root = realpathSync(ctx.cwd);
    if (!real.startsWith(root + sep)) return false;
    const st = statSync(real);
    if (!(st.isFile() || (allowDir && st.isDirectory()))) return false;
    return real
      .slice(root.length + 1)
      .split(sep)
      .includes(".plans");
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------
// Segment forms (first segment of a pipeline, or after ; && ||)

const PNPM_SCRIPTS =
  "lint|typecheck|build|format|format:check|test|secrets:scan|knip|rust:fmt|rust:check|rust:test";
const PNPM_ARG = "[A-Za-z0-9._/=:@,+-]+";
const PNPM = new RegExp(
  `^pnpm -C ${WORKTREE}(?: --filter ${PNPM_FILTER})? (?:${PNPM_SCRIPTS})(?: ${PNPM_ARG})*$`
);
const pnpmScript = (s: Segment) =>
  PNPM.test(joined(s)) && "pnpm script in a worktree";

const GIT_ARG = "[A-Za-z0-9._/=:@,+~^%-]+";
const GIT_READ = new RegExp(
  `^git -C ${WORKTREE} (?:status|diff|log|show)(?: ${GIT_ARG})*$`
);
// --output writes a file anywhere; --no-index lets diff read any file on disk; -O /
// --open-files-in-pager makes git grep run a command.
const GIT_READ_BLOCKED = /^(?:--(?:output|no-index|open-files-in-pager)|-O)/;
const gitRead = (s: Segment) =>
  GIT_READ.test(joined(s)) &&
  !s.words.some((w) => GIT_READ_BLOCKED.test(w.text)) &&
  "read-only git in a worktree";

const GIT_ADD = new RegExp(`^git -C ${WORKTREE} add(?: ${GIT_ARG})*$`);
// -f/--force stages ignored files (.env); -i/-p/-e open an interactive prompt or editor.
const GIT_ADD_BLOCKED =
  /^(?:--(?:force|interactive|patch|edit)|-[A-Za-z]*[fipe][A-Za-z]*)$/;
const gitAdd = (s: Segment) =>
  GIT_ADD.test(joined(s)) &&
  !s.words.some((w) => GIT_ADD_BLOCKED.test(w.text)) &&
  "git add in a worktree";

// Only -m messages in double quotes (the tokenizer already refused $, backtick and \ in
// them), and only the signing fallback as -c (any other -c could set core.hooksPath).
const GIT_COMMIT = new RegExp(
  `^git -C ${WORKTREE}(?: -c commit\\.gpgsign=false)? commit(?: -q| --quiet)?(?: -m "[^"\\n]*")+$`
);
const gitCommit = (s: Segment) =>
  GIT_COMMIT.test(joined(s)) && "local git commit in a worktree";

// The session's own repo: the cwd root (has .git), or one of its .worktrees/<name>, where
// .worktrees is a real folder and <name>/.git points into <cwd>/.git/worktrees/. Rules out
// nested foreign repos (their config could run code) and symlinks out of the project.
function repoDir(p: string, ctx: Ctx, rootOnly = false): boolean {
  try {
    const root = realpathSync(ctx.cwd);
    statSync(join(root, ".git"));
    const real = realpathSync(resolve(ctx.cwd, p));
    if (real === root) return true;
    if (rootOnly) return false;
    const wts = join(root, ".worktrees");
    if (realpathSync(wts) !== wts || dirname(real) !== wts) return false;
    const dotGit = join(real, ".git");
    if (!lstatSync(dotGit).isFile()) return false;
    const gitdir = /^gitdir: (.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1];
    if (!gitdir) return false;
    const target = realpathSync(resolve(real, gitdir.trim()));
    return target.startsWith(join(root, ".git", "worktrees") + sep);
  } catch {
    return false;
  }
}

// Splits `git [-C <dir>] <rest...>`; the dir (or the cwd) must pass repoDir.
function gitIn(
  s: Segment,
  ctx: Ctx,
  rootOnly = false
): { dir: string; rest: Word[] } | null {
  const w = s.words;
  if (w[0]?.raw !== "git") return null;
  if (w[1]?.raw === "-C") {
    const d = w[2];
    if (!plainMatch(d, PATH) || !repoDir(d!.text, ctx, rootOnly)) return null;
    return { dir: resolve(ctx.cwd, d!.text), rest: w.slice(3) };
  }
  return repoDir(".", ctx, rootOnly)
    ? { dir: ctx.cwd, rest: w.slice(1) }
    : null;
}

const GIT_WORD = new RegExp(`^${GIT_ARG}$`);
const gitWord = (w: Word) =>
  (plainMatch(w, GIT_WORD) || singleQuoted(w)) &&
  !GIT_READ_BLOCKED.test(w.text);
const REF = /^[A-Za-z0-9._/][A-Za-z0-9._/-]*$/;

function gitRepoRead(s: Segment, ctx: Ctx): string | false {
  const g = gitIn(s, ctx);
  if (!g) return false;
  const [sub, ...a] = g.rest;
  const r = a.map((w) => w.raw).join(" ");
  if (/^(?:status|diff|log|show|rev-parse)$/.test(sub?.raw ?? ""))
    return a.every(gitWord) && "read-only git in the session repo";
  if (sub?.raw === "grep") {
    let i = 0;
    while (plainMatch(a[i], /^-[nilwEFIc]+$/)) i++;
    const pattern = a[i];
    if (!pattern || !(singleQuoted(pattern) || plainMatch(pattern, REF)))
      return false;
    let rest = a.slice(i + 1);
    if (rest[0]?.raw === "--") rest = rest.slice(1);
    return (
      rest.every(
        (w) =>
          (w.plain || singleQuoted(w)) &&
          /^(?::!|:\^)?[A-Za-z0-9._-][A-Za-z0-9._/-]*$/.test(w.text)
      ) && "git grep in the session repo"
    );
  }
  if (sub?.raw === "branch")
    return (
      (/^(?:-vv|--show-current)$/.test(r) ||
        (a.length === 2 && a[0]?.raw === "--list" && plainMatch(a[1], REF))) &&
      "git branch listing"
    );
  if (sub?.raw === "remote")
    return (
      a.length === 2 &&
      a[0]?.raw === "get-url" &&
      plainMatch(a[1], REF) &&
      "git remote get-url"
    );
  return false;
}

// Only into <root>/.worktrees/<new name>, where .worktrees is a real folder (or absent).
function gitWorktreeAdd(s: Segment, ctx: Ctx): string | false {
  const g = gitIn(s, ctx, true);
  if (!g || g.rest[0]?.raw !== "worktree") return false;
  const r = g.rest
    .slice(1)
    .map((w) => w.raw)
    .join(" ");
  if (/^list(?: --porcelain)?$/.test(r)) return "git worktree list";
  const m = new RegExp(
    `^add \\.worktrees/(${SEG}) -b ([A-Za-z0-9._/][A-Za-z0-9._/-]*)(?: [0-9a-f]{7,40})?$`
  ).exec(r);
  if (!m || !g.rest.slice(1).every((w) => w.plain)) return false;
  try {
    const root = realpathSync(g.dir);
    const wts = join(root, ".worktrees");
    try {
      if (realpathSync(wts) !== wts) return false;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") return false;
    }
    try {
      lstatSync(join(wts, m[1]!));
      return false; // target exists
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") return false;
    }
    return "git worktree add under .worktrees/";
  } catch {
    return false;
  }
}

const GITHUB_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// Reads the repo's config (no hooks run). Any error refuses.
function gitConfig(dir: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", dir, "config", ...args], {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch (e) {
    // exit 1 = key not found
    return (e as { status?: number }).status === 1 ? "" : null;
  }
}

// No flags at all (shuts out --upload-pack), no +/: refspecs; the remote is a GitHub https
// URL, or origin whose configured URL is one. Refuses when url.*.insteadOf could rewrite it.
function gitFetch(s: Segment, ctx: Ctx): string | false {
  const g = gitIn(s, ctx);
  if (!g) return false;
  const [sub, remote, ...refs] = g.rest;
  if (!/^(?:fetch|ls-remote)$/.test(sub?.raw ?? "") || !remote?.plain)
    return false;
  if (!refs.every((w) => plainMatch(w, REF))) return false;
  let url = remote.text;
  if (url === "origin") {
    const got = gitConfig(g.dir, ["--get", "remote.origin.url"]);
    if (!got) return false;
    url = got;
  }
  if (!GITHUB_URL.test(url)) return false;
  const rewrites = gitConfig(g.dir, [
    "--get-regexp",
    "^url\\..*\\.(push)?insteadof$",
  ]);
  return rewrites === "" && "git fetch from GitHub over https";
}

const GH_READ =
  /^(?:pr (?:view|diff|checks|list)|run (?:view|list)|issue (?:view|list)|release (?:view|list)|repo view)$/;
function ghRead(s: Segment): string | false {
  const [cmd, a, b, ...rest] = s.words;
  if (cmd?.raw !== "gh" || !GH_READ.test(`${a?.raw} ${b?.raw}`)) return false;
  return (
    rest.every((w) => w.plain || singleQuoted(w) || /^"[^"]*"$/.test(w.raw)) &&
    "read-only gh"
  );
}

const CP_SEED = new RegExp(
  `^cp -al (?:(?:/|\\./)?(?:${SEG}/)*)?node_modules ${WORKTREE}/node_modules$`
);
const cpSeed = (s: Segment) =>
  CP_SEED.test(joined(s)) && "node_modules seeding into a worktree";

const ENDPOINT = /^[A-Za-z0-9][A-Za-z0-9/_.?=&%:,-]*$/;
const jqValue = (w?: Word) =>
  singleQuoted(w) || plainMatch(w, /^[.A-Za-z0-9_]+$/);

function ghApi(s: Segment): string | false {
  const w = s.words;
  if (w[0]?.raw !== "gh" || w[1]?.raw !== "api" || !w[2]) return false;
  if (w[2].raw === "graphql") return ghGraphql(w.slice(3));
  let endpoints = 0;
  for (let i = 2; i < w.length; i++) {
    const t = w[i];
    if (!t) return false;
    if (t.raw === "--paginate" || t.raw === "--slurp") continue;
    if (t.raw === "--jq" || t.raw === "-q") {
      if (!jqValue(w[++i])) return false;
      continue;
    }
    if ((t.plain || singleQuoted(t)) && ENDPOINT.test(t.text)) {
      endpoints++;
      continue;
    }
    return false; // -X, --method, -f, -F, --input, -H and anything else
  }
  return endpoints === 1 && "read-only gh api GET";
}

const FIELD_PLAIN = /^[A-Za-z_][A-Za-z0-9_]*=[A-Za-z0-9_.:/-]*$/;
const FIELD_QUOTED = /^[A-Za-z_][A-Za-z0-9_]*='[^']*'$/;

function ghGraphql(rest: Word[]): string | false {
  if (rest.some((w) => /mutation/i.test(w.text))) return false;
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (!t) return false;
    if (t.raw === "--paginate" || t.raw === "--slurp") continue;
    if (t.raw === "--jq" || t.raw === "-q") {
      if (!jqValue(rest[++i])) return false;
      continue;
    }
    if (["-f", "-F", "--raw-field", "--field"].includes(t.raw)) {
      const v = rest[++i];
      if (!v || !(FIELD_PLAIN.test(v.raw) || FIELD_QUOTED.test(v.raw)))
        return false;
      if (v.text.slice(v.text.indexOf("=") + 1).startsWith("@")) return false; // @file upload
      continue;
    }
    return false;
  }
  return "read-only gh api graphql query";
}

function grepPlans(s: Segment, ctx: Ctx): string | false {
  const w = s.words;
  if (w[0]?.raw !== "grep") return false;
  let i = 1;
  while (plainMatch(w[i], /^-[nEiwHc]+$/)) i++;
  if (!(singleQuoted(w[i]) || plainMatch(w[i], /^[A-Za-z0-9._:@-]+$/)))
    return false;
  const files = w.slice(i + 1);
  return (
    files.length > 0 &&
    files.every((f) => plainMatch(f, PATH) && inPlans(f.text, ctx)) &&
    "grep over .plans/ drafts"
  );
}

function gitleaks(s: Segment, ctx: Ctx): string | false {
  const j = joined(s);
  if (j === "gitleaks version") return "gitleaks version";
  const path = /^gitleaks dir --redact --no-banner ([A-Za-z0-9._/-]+)$/.exec(
    j
  )?.[1];
  return (
    !!path && inPlans(path, ctx, true) && "gitleaks scan of .plans/ drafts"
  );
}

function inspect(s: Segment): string | false {
  const [cmd, ...a] = s.words;
  if (!cmd) return false;
  const j = joined(s);
  if (cmd.raw === "ps" && a.every((w) => plainMatch(w, /^[A-Za-z0-9,=-]+$/)))
    return "ps";
  if (
    cmd.raw === "pgrep" &&
    a.every((w) => singleQuoted(w) || plainMatch(w, /^[A-Za-z0-9._-]+$/))
  )
    return "pgrep";
  if (/^readlink (?:-f )?[A-Za-z0-9._/-]+$/.test(j)) return "readlink";
  if (j === "ss -ltnp") return "ss -ltnp";
  if (/^sleep \d+(?:\.\d+)?$/.test(j)) return "sleep";
  if (cmd.raw === "echo" || j === "true") return "echo";
  return false;
}

// kill -- -<N> only for the dev server: .plans/dev.pid names a live process that is in
// process group N and runs from inside <cwd>/.worktrees/. Rules out stale or reused PIDs.
function killDevServer(s: Segment, ctx: Ctx): string | false {
  const m = /^kill -- -(\d+)$/.exec(joined(s));
  if (!m) return false;
  try {
    const pid = readFileSync(join(ctx.cwd, ".plans", "dev.pid"), "utf8").trim();
    if (!/^\d+$/.test(pid)) return false;
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" "); // state ppid pgrp ...
    if (fields[2] !== m[1]) return false;
    const worktrees = realpathSync(join(ctx.cwd, ".worktrees"));
    const procCwd = realpathSync(`/proc/${pid}/cwd`);
    return (
      procCwd.startsWith(worktrees + sep) && "stop the recorded dev server"
    );
  } catch {
    return false;
  }
}

const SEGMENT_FORMS: ((s: Segment, ctx: Ctx) => string | false)[] = [
  pnpmScript,
  gitRead,
  gitAdd,
  gitCommit,
  gitRepoRead,
  gitWorktreeAdd,
  gitFetch,
  cpSeed,
  ghApi,
  ghRead,
  grepPlans,
  gitleaks,
  inspect,
  killDevServer,
];

// ---------------------------------------------------------------------------------------
// Pipe filters (segments after `|`): they only transform stdin.

function isFilter(s: Segment): boolean {
  const [cmd, ...a] = s.words;
  if (!cmd) return false;
  const r = a.map((w) => w.raw);
  switch (cmd.raw) {
    case "head":
    case "tail":
      return (
        r.length === 0 ||
        (r.length === 1 && /^-\d+$/.test(r[0] ?? "")) ||
        (r.length === 2 && r[0] === "-n" && /^\d+$/.test(r[1] ?? ""))
      );
    case "grep": {
      let i = 0;
      while (plainMatch(a[i], /^-[EFivwxcnoq]+$/)) i++;
      const pattern = a[i];
      const okPattern =
        !!pattern &&
        (!pattern.plain || /^[A-Za-z0-9._:=@,/+-]+$/.test(pattern.text));
      return okPattern && i === a.length - 1;
    }
    case "wc":
      return r.every((x) => ["-l", "-c", "-w"].includes(x));
    case "sort":
      return r.every((x) => /^-[rnu]+$/.test(x));
    case "uniq":
      return r.length === 0 || (r.length === 1 && r[0] === "-c");
    case "jq": {
      const flags = a.slice(0, -1);
      return (
        singleQuoted(a.at(-1)) &&
        flags.every((w) => ["-r", "-c", "-e"].includes(w.raw))
      );
    }
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------------------

function decide(command: string, ctx: Ctx): string | false {
  const cmd = command.trim();
  if (cmd.split(/[\s/]/).includes("..")) return false;
  if (cmd === SETTINGS_CHECK) return "settings.json validity check";
  if (DEV_SERVER.test(cmd)) return devServer(cmd, ctx);
  const segments = parse(cmd);
  if (!segments) return false;
  const reasons: string[] = [];
  for (const s of segments) {
    if (s.piped) {
      if (!isFilter(s)) return false;
      continue;
    }
    const reason = SEGMENT_FORMS.map((f) => f(s, ctx)).find(Boolean);
    if (!reason) return false;
    reasons.push(reason);
  }
  return [...new Set(reasons)].join("; ");
}

let input = "";
for await (const chunk of process.stdin) input += chunk;

type HookInput = { cwd?: unknown; tool_input?: { command?: unknown } } | null;
let parsed: HookInput = null;
try {
  parsed = JSON.parse(input) as HookInput;
} catch {
  process.exit(0);
}
const command = parsed?.tool_input?.command;
if (typeof command !== "string") process.exit(0);
const cwd = typeof parsed?.cwd === "string" ? parsed.cwd : process.cwd();

const reason = decide(command as string, { cwd });
if (reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: reason,
      },
    })
  );
}
