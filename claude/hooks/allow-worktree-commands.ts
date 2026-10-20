#!/usr/bin/env node
// PreToolUse hook: auto-approve a few exact command shapes that run inside a
// `.worktrees/<name>` checkout. Anything else falls through to normal permissions.
//
//   pnpm -C <path>/.worktrees/<name> <lint|typecheck|build|format|...> [args]
//   git  -C <path>/.worktrees/<name> <status|diff|log|show> [args]
//   git  -C <path>/.worktrees/<name> add [args]   (no force / interactive flags)
//   git  -C <path>/.worktrees/<name> [-c commit.gpgsign=false] commit -m "<msg>" [-m "<msg>"]...

const SEG = "[A-Za-z0-9._-]+";
const WORKTREE = `(?:(?:/|\\./)?(?:${SEG}/)*)?\\.worktrees/${SEG}(?:/${SEG})*`;

const PNPM_SCRIPTS = "lint|typecheck|build|format|format:check|test|secrets:scan|knip";
const PNPM_ARG = "[A-Za-z0-9._/=:@,+-]+";
const PNPM = new RegExp(`^pnpm -C ${WORKTREE} (?:${PNPM_SCRIPTS})(?: ${PNPM_ARG})*$`);

const GIT_SUBCOMMANDS = "status|diff|log|show";
const GIT_ARG = "[A-Za-z0-9._/=:@,+~^%-]+";
const GIT = new RegExp(`^git -C ${WORKTREE} (?:${GIT_SUBCOMMANDS})(?: ${GIT_ARG})*$`);
// --output writes a file anywhere; --no-index lets diff read any file on disk.
const GIT_BLOCKED = /^--(?:output|no-index)/;

const GIT_ADD = new RegExp(`^git -C ${WORKTREE} add(?: ${GIT_ARG})*$`);
// -f/--force stages ignored files (.env); -i/-p/-e open an interactive prompt or editor.
const GIT_ADD_BLOCKED = /^(?:--(?:force|interactive|patch|edit)|-[A-Za-z]*[fipe][A-Za-z]*)$/;

// Only -m messages in double quotes with no $, backtick, backslash or quote inside, and
// only the signing fallback as -c (any other -c could point core.hooksPath at a script).
const MSG = String.raw`"[^"$\x60\\\n]*"`;
const GIT_COMMIT = new RegExp(
  `^git -C ${WORKTREE}(?: -c commit\\.gpgsign=false)? commit(?: -m ${MSG})+$`,
);

let input = "";
for await (const chunk of process.stdin) input += chunk;

type HookInput = { tool_input?: { command?: unknown } } | null;

let command: unknown;
try {
  command = (JSON.parse(input) as HookInput)?.tool_input?.command;
} catch {
  process.exit(0);
}

if (typeof command !== "string") process.exit(0);
const cmd = command.trim();
const tokens = cmd.split(" ");
if (cmd.split(/[\s/]/).includes("..")) process.exit(0);

let reason: string;
if (PNPM.test(cmd)) {
  reason = "pnpm script in a .worktrees/ checkout";
} else if (GIT.test(cmd) && !tokens.some((t) => GIT_BLOCKED.test(t))) {
  reason = "read-only git command in a .worktrees/ checkout";
} else if (GIT_ADD.test(cmd) && !tokens.some((t) => GIT_ADD_BLOCKED.test(t))) {
  reason = "git add in a .worktrees/ checkout";
} else if (GIT_COMMIT.test(cmd)) {
  reason = "local git commit in a .worktrees/ checkout";
} else {
  process.exit(0);
}

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: reason,
    },
  }),
);
