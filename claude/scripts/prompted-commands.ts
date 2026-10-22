#!/usr/bin/env node
// Read-only report of permission prompts, from the Claude Code transcripts under
// ~/.claude/projects (including subagent sidechains). Used by /permission-review.
//
//   node prompted-commands.ts shapes    [--since <ISO>|--days <N>]   grouped, ranked
//   node prompted-commands.ts list      [--since <ISO>|--days <N>]   one TSV row per prompt
//   node prompted-commands.ts decisions <regex> [--since <ISO>|--days <N>]
//        every Bash call matching <regex> with how it was decided (did a rule/hook work?)
//
// A prompt is a tool_result whose permissionDecision.source is "user_temporary" (the user
// approved at a prompt) or whose content says the user rejected it. Other sources are
// automatic: "user_permanent"/rule = a user-settings rule, "config" = project rule, mode,
// classifier or compound split, "hook" = a PreToolUse hook.

import { createReadStream, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

// The transcript fields this report reads; everything else is ignored.
type ToolInput = {
  command?: string;
  file_path?: string;
  path?: string;
  url?: string;
  pattern?: string;
};
type ContentBlock = {
  type?: string;
  id?: string;
  name?: string;
  input?: ToolInput;
  tool_use_id?: string;
  content?: unknown;
};
type TranscriptLine = {
  timestamp?: string;
  message?: { content?: unknown };
  permissionDecision?: { source?: string; reasonType?: string };
};
// [timestamp, project, outcome, tool or reasonType, text]
type Row = [string, string, string, string, string];

const args = process.argv.slice(2);
const mode = args[0] ?? "shapes";
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const since =
  opt("--since") ??
  new Date(Date.now() - Number(opt("--days") ?? 7) * 864e5).toISOString();
const pattern = mode === "decisions" ? new RegExp(args[1] ?? "") : null;
const root = join(homedir(), ".claude/projects");

// Repos live under ~/code. A project's transcript folder is its absolute path with every
// non-alphanumeric character turned into `-` (~/code/app -> -home-<user>-code-app).
const codeDir = join(homedir(), "code");
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const repoPath = new RegExp(`${escapeRe(codeDir)}/[^\\s/'"]+`, "g");
const projectPrefix = new RegExp(
  `^${escapeRe(codeDir.replace(/[^A-Za-z0-9]/g, "-"))}-`
);

function* jsonlFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* jsonlFiles(p);
    else if (name.endsWith(".jsonl") && st.mtime.toISOString() >= since)
      yield p;
  }
}

const describe = (name: string, input: ToolInput = {}) =>
  name === "Bash"
    ? (input.command ?? "")
    : (input.file_path ??
      input.path ??
      input.url ??
      input.pattern ??
      JSON.stringify(input).slice(0, 200));

// Collapse the parts that vary between runs so the same command shape groups together.
const normalize = (s: string) =>
  s
    .replace(/\/tmp\/claude-[^\s'"]*/g, "<scratch>")
    .replace(repoPath, "<repo>")
    .replace(/\.worktrees\/[^\s/'"]+/g, ".worktrees/<wt>")
    .replace(
      /\/(pulls|issues|comments|reviews|milestones|runs|alerts)\/\d+/g,
      "/$1/N"
    )
    .replace(/\b\d{3,}\b/g, "N")
    .replace(/\s+/g, " ")
    .trim();

const shapeOf = (tool: string, text: string) => {
  if (tool !== "Bash")
    return `${tool} ${normalize(text).replace(/\/[^/]*$/, "/…")}`;
  return normalize(text).split(" ").slice(0, 4).join(" ");
};

const rows: Row[] = [];
for (const file of jsonlFiles(root)) {
  const project = (file.slice(root.length + 1).split("/")[0] ?? "").replace(
    projectPrefix,
    ""
  );
  const uses = new Map<string, { name: string; input?: ToolInput }>();
  for await (const line of createInterface({ input: createReadStream(file) })) {
    let o: TranscriptLine;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const content = o.message?.content;
    const blocks: ContentBlock[] = Array.isArray(content) ? content : [];
    for (const c of blocks) {
      if (c.type === "tool_use" && c.id && c.name)
        uses.set(c.id, { name: c.name, input: c.input });
      const timestamp = o.timestamp ?? "";
      if (c.type !== "tool_result" || timestamp < since) continue;
      const use = c.tool_use_id ? uses.get(c.tool_use_id) : undefined;
      if (!use) continue;
      const text = describe(use.name, use.input);
      const source = o.permissionDecision?.source ?? "-";
      const reasonType = o.permissionDecision?.reasonType ?? "-";
      const body =
        typeof c.content === "string"
          ? c.content
          : JSON.stringify(c.content ?? "");
      const rejected = /doesn.t want to proceed/.test(body);
      if (pattern) {
        if (use.name === "Bash" && pattern.test(text))
          rows.push([
            timestamp,
            project,
            rejected ? "rejected" : source,
            reasonType,
            text,
          ]);
        continue;
      }
      if (source !== "user_temporary" && !rejected) continue;
      rows.push([
        timestamp,
        project,
        rejected ? "rejected" : "approved",
        use.name,
        text,
      ]);
    }
  }
}
rows.sort((a, b) => a[0].localeCompare(b[0]));
const clean = (x: unknown) => String(x).replace(/\s+/g, " ");

if (mode === "list" || mode === "decisions") {
  for (const r of rows)
    console.log([r[0].slice(0, 16), ...r.slice(1)].map(clean).join("\t"));
} else {
  type Group = {
    count: number;
    approved: number;
    rejected: number;
    projects: Set<string>;
    last: string;
    example: string;
  };
  const groups = new Map<string, Group>();
  for (const [ts, project, outcome, tool, text] of rows) {
    const key = shapeOf(tool, text);
    const g = groups.get(key) ?? {
      count: 0,
      approved: 0,
      rejected: 0,
      projects: new Set(),
      last: "",
      example: "",
    };
    g.count++;
    if (outcome === "rejected") g.rejected++;
    else g.approved++;
    g.projects.add(project);
    if (ts >= g.last) [g.last, g.example] = [ts, text];
    groups.set(key, g);
  }
  console.log(
    `prompts since ${since}: ${rows.length} (${rows.filter((r) => r[2] === "rejected").length} rejected)`
  );
  console.log(
    [
      "count",
      "approved",
      "rejected",
      "last",
      "projects",
      "shape",
      "latest example",
    ].join("\t")
  );
  for (const [key, g] of [...groups].sort((a, b) => b[1].count - a[1].count))
    console.log(
      [
        g.count,
        g.approved,
        g.rejected,
        g.last.slice(0, 16),
        [...g.projects].join(","),
        key,
        clean(g.example).slice(0, 300),
      ].join("\t")
    );
}
