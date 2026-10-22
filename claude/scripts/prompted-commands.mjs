#!/usr/bin/env node
// Read-only report of permission prompts, from the Claude Code transcripts under
// ~/.claude/projects (including subagent sidechains). Used by /permission-review.
//
//   node prompted-commands.mjs shapes    [--since <ISO>|--days <N>]   grouped, ranked
//   node prompted-commands.mjs list      [--since <ISO>|--days <N>]   one TSV row per prompt
//   node prompted-commands.mjs decisions <regex> [--since <ISO>|--days <N>]
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

const args = process.argv.slice(2);
const mode = args[0] ?? "shapes";
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const since =
  opt("--since") ?? new Date(Date.now() - Number(opt("--days") ?? 7) * 864e5).toISOString();
const pattern = mode === "decisions" ? new RegExp(args[1]) : null;
const root = join(homedir(), ".claude/projects");

function* jsonlFiles(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* jsonlFiles(p);
    else if (name.endsWith(".jsonl") && st.mtime.toISOString() >= since) yield p;
  }
}

const describe = (name, input = {}) =>
  name === "Bash"
    ? input.command ?? ""
    : input.file_path ?? input.path ?? input.url ?? input.pattern ?? JSON.stringify(input).slice(0, 200);

// Collapse the parts that vary between runs so the same command shape groups together.
const normalize = (s) =>
  s
    .replace(/\/tmp\/claude-[^\s'"]*/g, "<scratch>")
    .replace(/\/home\/juha\/code\/[^\s/'"]+/g, "<repo>")
    .replace(/\.worktrees\/[^\s/'"]+/g, ".worktrees/<wt>")
    .replace(/\/(pulls|issues|comments|reviews|milestones|runs|alerts)\/\d+/g, "/$1/N")
    .replace(/\b\d{3,}\b/g, "N")
    .replace(/\s+/g, " ")
    .trim();

const shapeOf = (tool, text) => {
  if (tool !== "Bash") return `${tool} ${normalize(text).replace(/\/[^/]*$/, "/…")}`;
  return normalize(text).split(" ").slice(0, 4).join(" ");
};

const rows = [];
for (const file of jsonlFiles(root)) {
  const project = file.slice(root.length + 1).split("/")[0].replace(/^-home-juha-code-/, "");
  const uses = new Map();
  for await (const line of createInterface({ input: createReadStream(file) })) {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    for (const c of Array.isArray(o.message?.content) ? o.message.content : []) {
      if (c.type === "tool_use") uses.set(c.id, { name: c.name, input: c.input });
      if (c.type !== "tool_result" || (o.timestamp ?? "") < since) continue;
      const use = uses.get(c.tool_use_id);
      if (!use) continue;
      const text = describe(use.name, use.input);
      const source = o.permissionDecision?.source ?? "-";
      const reasonType = o.permissionDecision?.reasonType ?? "-";
      const body = typeof c.content === "string" ? c.content : JSON.stringify(c.content ?? "");
      const rejected = /doesn.t want to proceed/.test(body);
      if (pattern) {
        if (use.name === "Bash" && pattern.test(text))
          rows.push([o.timestamp, project, rejected ? "rejected" : source, reasonType, text]);
        continue;
      }
      if (source !== "user_temporary" && !rejected) continue;
      rows.push([o.timestamp, project, rejected ? "rejected" : "approved", use.name, text]);
    }
  }
}
rows.sort((a, b) => a[0].localeCompare(b[0]));
const clean = (x) => String(x).replace(/\s+/g, " ");

if (mode === "list" || mode === "decisions") {
  for (const r of rows) console.log([r[0].slice(0, 16), ...r.slice(1)].map(clean).join("\t"));
} else {
  const groups = new Map();
  for (const [ts, project, outcome, tool, text] of rows) {
    const key = shapeOf(tool, text);
    const g = groups.get(key) ?? { count: 0, approved: 0, rejected: 0, projects: new Set(), last: "", example: "" };
    g.count++;
    g[outcome]++;
    g.projects.add(project);
    if (ts >= g.last) [g.last, g.example] = [ts, text];
    groups.set(key, g);
  }
  console.log(`prompts since ${since}: ${rows.length} (${rows.filter((r) => r[2] === "rejected").length} rejected)`);
  console.log(["count", "approved", "rejected", "last", "projects", "shape", "latest example"].join("\t"));
  for (const [key, g] of [...groups].sort((a, b) => b[1].count - a[1].count))
    console.log(
      [g.count, g.approved, g.rejected, g.last.slice(0, 16), [...g.projects].join(","), key, clean(g.example).slice(0, 300)].join("\t"),
    );
}
