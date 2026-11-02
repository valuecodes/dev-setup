#!/usr/bin/env node
// Read-only supply-chain diff scan for /vet-deps, /vet-all-deps and /ship-deps. Downloads two
// versions of an npm package or GitHub Action (nothing from them is ever run), scans both with
// the ast-grep rules in ~/.claude/vet-scan/rules, and prints what the new version adds.
//
//   node vet-scan.ts npm     <pkg> <old> <new>                  [--out <dir>] [--keep] [--no-cache]
//   node vet-scan.ts npm-new <pkg> <version>                    [--out <dir>] [--keep] [--no-cache]
//   node vet-scan.ts action  <owner>/<repo> <old_sha> <new_sha> [--out <dir>] [--keep] [--no-cache]
//   node vet-scan.ts dirs    <old_dir> <new_dir>                [--out <dir>]
//   node vet-scan.ts archive <old.tgz> <new.tgz>                [--out <dir>] [--keep]   (e.g. .crate files)
//   node vet-scan.ts show    <result.json> [--from <N>] [--hold]
//
// A finding is new when its (rule, file, whitespace-normalized match) occurs more often in the
// new version than in the old, so an added copy of an existing call is never masked. Rule
// severity sets the class: error = hold-candidate, warning = review. Changed files the rules
// cannot cover (other languages, binaries, shebang scripts, files over the size cap) are listed
// as unscanned. `status: clean` needs no findings, no unscanned files and no manifest change.
//
// Exit 0 when the scan completed (clean or not); 2 on any download, archive, limit or tool
// error, printed as `NOT SCANNED: <reason>`, so a failure is never read as clean.

import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, extname, join } from "node:path";

const CONFIG_DIR = join(homedir(), ".claude", "vet-scan");
const RULES_DIR = join(CONFIG_DIR, "rules");
const WORK_ROOT = join(tmpdir(), "vet-scan");
const SELF = "node ~/.claude/scripts/vet-scan.ts";

const LIMITS = {
  downloadMs: 60_000,
  tarballBytes: 50 * 1024 * 1024,
  unpackedBytes: 300 * 1024 * 1024,
  entries: 20_000,
  scanFileBytes: 5 * 1024 * 1024,
  astGrepMs: 120_000,
};
const REVIEW_PAGE = 50;
const HOLD_PER_GROUP = 10;
const CHUNK = 500;

// Extensions are matched case-sensitively: ast-grep only infers lowercase ones, so `.JS` is
// reported as unscanned rather than silently skipped. Must agree with buildConfig's globs.
const LANG_BY_EXT: Record<string, string> = {
  ".js": "typescript",
  ".cjs": "typescript",
  ".mjs": "typescript",
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".jsx": "tsx",
  ".tsx": "tsx",
  ".sh": "bash",
  ".bash": "bash",
  ".py": "python",
};
const MANIFESTS = new Set(["action.yml", "action.yaml"]);
const UNSCANNED_EXTS = new Set([
  ".ps1",
  ".psm1",
  ".bat",
  ".cmd",
  ".vbs",
  ".rb",
  ".go",
  ".pl",
  ".pm",
  ".php",
  ".lua",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".node",
  ".wasm",
  ".jar",
  ".class",
  ".zsh",
  ".fish",
  ".pyc",
  ".pyo",
  ".pyd",
  ".vue",
  ".svelte",
  ".astro",
  ".coffee",
]);
const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall", "prepare"];
const NO_IGNORE = [
  "hidden",
  "dot",
  "exclude",
  "global",
  "parent",
  "vcs",
].flatMap((k) => ["--no-ignore", k]);
// GNU tar -tv with LC_ALL=C: `-rw-r--r-- 0/0   1234 1985-10-26 08:15 package/index.js`
const TAR_LINE =
  /^(.)\S{9}\s+\S+\s+(\d+)\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})? (.+)$/;

type Cls = "hold-candidate" | "review";
type Finding = {
  cls: Cls;
  rule: string;
  file: string;
  line: number;
  text: string;
  message: string;
};
type Group = {
  cls: Cls;
  rule: string;
  file: string;
  added: number;
  listed: number;
};
type Note = { file: string; note: string; diff?: string };
type Result = {
  label: string;
  status: "clean" | "flagged";
  files: { changed: number; added: number; removed: number; scanned: number };
  manifest: Note[];
  unscanned: Note[];
  info: Note[];
  groups: Group[];
  hold: Finding[];
  review: Finding[];
};
type Entry = { size: number; mode: number; sha: string; special: boolean };
type RawMatch = {
  ruleId: string;
  severity: string;
  file: string;
  text: string;
  message: string;
  range: { start: { line: number } };
};

class ScanError extends Error {}

function run(
  cmd: string,
  args: string[],
  opts: SpawnSyncOptions & { ok?: number[] } = {}
) {
  const { ok = [0], ...rest } = opts;
  const r = spawnSync(cmd, args, {
    maxBuffer: 64 * 1024 * 1024,
    ...rest,
    encoding: "buffer",
  });
  if (r.error)
    throw new ScanError(`${cmd} ${args[0] ?? ""}: ${r.error.message}`);
  if (r.status === null || !ok.includes(r.status)) {
    const err = r.stderr.toString().trim().slice(0, 300);
    throw new ScanError(
      `${cmd} ${args[0] ?? ""} exited ${r.status ?? r.signal}: ${err}`
    );
  }
  return { stdout: r.stdout, stderr: r.stderr.toString(), status: r.status };
}

const sha256 = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
// Finding identity ignores formatting: whitespace next to punctuation is dropped too, so
// `fetch( u.url )` and `fetch(u.url)` are the same finding.
const canon = (s: string) => norm(s).replace(/ ?([^\w\s$]) ?/g, "$1");
const short = (s: string, n = 120) => {
  const t = norm(s);
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// ---- downloads ---------------------------------------------------------------------------

async function fetchNpm(
  pkg: string,
  version: string,
  file: string
): Promise<void> {
  const { stdout } = run(
    "npm",
    ["view", `${pkg}@${version}`, "dist", "--json"],
    {
      cwd: tmpdir(),
      timeout: LIMITS.downloadMs,
    }
  );
  const text = stdout.toString().trim();
  if (!text) throw new ScanError(`npm has no ${pkg}@${version}`);
  const dist = JSON.parse(text) as {
    tarball?: string;
    integrity?: string;
    shasum?: string;
    unpackedSize?: number;
    fileCount?: number;
  };
  if (Array.isArray(dist) || !dist.tarball?.startsWith("https://")) {
    throw new ScanError(`unexpected npm dist for ${pkg}@${version}`);
  }
  if ((dist.unpackedSize ?? 0) > LIMITS.unpackedBytes)
    throw new ScanError(
      `${pkg}@${version} unpacks to ${dist.unpackedSize} bytes`
    );
  if ((dist.fileCount ?? 0) > LIMITS.entries)
    throw new ScanError(`${pkg}@${version} has ${dist.fileCount} files`);

  const res = await fetch(dist.tarball, {
    signal: AbortSignal.timeout(LIMITS.downloadMs),
  });
  if (!res.ok || !res.body)
    throw new ScanError(
      `download of ${pkg}@${version} failed: HTTP ${res.status}`
    );
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > LIMITS.tarballBytes)
      throw new ScanError(
        `${pkg}@${version} tarball is over ${LIMITS.tarballBytes} bytes`
      );
    chunks.push(Buffer.from(chunk));
  }
  const buf = Buffer.concat(chunks);

  const sri = dist.integrity?.split(/\s+/).find((s) => s.startsWith("sha512-"));
  if (sri) {
    if (createHash("sha512").update(buf).digest("base64") !== sri.slice(7)) {
      throw new ScanError(
        `${pkg}@${version} tarball does not match its integrity`
      );
    }
  } else if (dist.shasum) {
    if (createHash("sha1").update(buf).digest("hex") !== dist.shasum) {
      throw new ScanError(
        `${pkg}@${version} tarball does not match its shasum`
      );
    }
  } else {
    throw new ScanError(`${pkg}@${version} has no integrity to check`);
  }
  writeFileSync(file, buf);
}

function fetchAction(nwo: string, sha: string, file: string): void {
  const { stdout } = run("gh", ["api", `repos/${nwo}/tarball/${sha}`], {
    timeout: LIMITS.downloadMs,
    maxBuffer: LIMITS.tarballBytes,
  });
  writeFileSync(file, stdout);
}

// List first, extract only when every entry is a regular file or directory under one top-level
// directory, with no absolute or `..` path, within the entry and size caps.
function extract(archive: string, dest: string): void {
  const { stdout } = run("tar", ["-tvzf", archive], {
    timeout: LIMITS.downloadMs,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, LC_ALL: "C" },
  });
  const lines = stdout.toString().split("\n").filter(Boolean);
  if (lines.length > LIMITS.entries)
    throw new ScanError(`archive has ${lines.length} entries`);
  let total = 0;
  let top: string | undefined;
  for (const line of lines) {
    const m = TAR_LINE.exec(line);
    if (!m) throw new ScanError(`unreadable archive entry: ${short(line)}`);
    const [, type, size, path = ""] = m;
    if (type !== "-" && type !== "d")
      throw new ScanError(
        `archive has a non-regular entry (${type}): ${short(path)}`
      );
    const parts = path.replace(/\/$/, "").split("/");
    if (
      path.startsWith("/") ||
      parts.some((p) => p === ".." || p === "." || p === "")
    ) {
      throw new ScanError(`archive has an unsafe path: ${short(path)}`);
    }
    if (top === undefined) top = parts[0];
    else if (parts[0] !== top)
      throw new ScanError("archive has more than one top-level directory");
    total += Number(size);
    if (total > LIMITS.unpackedBytes)
      throw new ScanError(
        `archive unpacks to over ${LIMITS.unpackedBytes} bytes`
      );
  }
  mkdirSync(dest, { recursive: true });
  run(
    "tar",
    [
      "-xzf",
      archive,
      "-C",
      dest,
      "--strip-components=1",
      "--no-same-owner",
      "--no-same-permissions",
    ],
    {
      timeout: LIMITS.downloadMs,
    }
  );
}

// ---- inventory ---------------------------------------------------------------------------

function walk(root: string): Map<string, Entry> {
  const out = new Map<string, Entry>();
  const visit = (dir: string, rel: string) => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, d.name);
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) visit(full, r);
      else if (d.isFile()) {
        const st = statSync(full);
        out.set(r, {
          size: st.size,
          mode: st.mode,
          sha: sha256(readFileSync(full)),
          special: false,
        });
      } else {
        const sha = d.isSymbolicLink()
          ? `symlink:${readlinkSync(full)}`
          : "special";
        out.set(r, { size: 0, mode: 0, sha, special: true });
      }
    }
  };
  visit(root, "");
  return out;
}

function head(file: string, n: number): Buffer {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(n);
    return buf.subarray(0, readSync(fd, buf, 0, n, 0));
  } finally {
    closeSync(fd);
  }
}

function isNativeBinary(h: Buffer): boolean {
  const hex = h.subarray(0, 4).toString("hex");
  return (
    hex === "7f454c46" || // ELF
    hex === "0061736d" || // wasm
    ["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe"].includes(
      hex
    ) || // Mach-O, fat
    hex.startsWith("4d5a") // PE
  );
}

function classify(
  root: string,
  rel: string,
  e: Entry
): { lang?: string; unscanned?: string } {
  if (e.special) return { unscanned: "symlink or special file" };
  const ext = extname(rel);
  const base = basename(rel);
  const lang = MANIFESTS.has(base) ? "yaml" : LANG_BY_EXT[ext];
  if (lang) {
    if (e.size > LIMITS.scanFileBytes)
      return { unscanned: `over ${LIMITS.scanFileBytes / 1024 / 1024} MB` };
    return { lang };
  }
  const lower = ext.toLowerCase();
  if (LANG_BY_EXT[lower] || MANIFESTS.has(base.toLowerCase()))
    return { unscanned: `extension case (${ext})` };
  if (UNSCANNED_EXTS.has(lower)) return { unscanned: `${lower} not scanned` };
  const h = head(join(root, rel), 4);
  if (isNativeBinary(h)) return { unscanned: "native binary" };
  if (h.subarray(0, 2).toString() === "#!")
    return { unscanned: "script with a shebang" };
  if (e.mode & 0o111) return { unscanned: "executable bit set" };
  return {};
}

// ---- manifests ---------------------------------------------------------------------------

function readPackageJson(root: string | null): Record<string, any> | undefined {
  if (!root || !existsSync(join(root, "package.json"))) return undefined;
  try {
    return JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  } catch {
    throw new ScanError(`package.json in ${root} is not valid JSON`);
  }
}

function npmManifest(
  oldRoot: string | null,
  newRoot: string,
  oldMap: Map<string, Entry>,
  newMap: Map<string, Entry>
): Note[] {
  const n = readPackageJson(newRoot);
  if (!n) return [];
  const o = readPackageJson(oldRoot);
  const fmt = (v: unknown) =>
    v === undefined ? "(none)" : short(JSON.stringify(v), 200);
  const notes: Note[] = [];
  for (const key of INSTALL_SCRIPTS) {
    const before = o?.scripts?.[key];
    const after = n.scripts?.[key];
    if (before !== after)
      notes.push({
        file: "package.json",
        note: `scripts.${key}: ${fmt(before)} → ${fmt(after)}`,
      });
  }
  // A new package always has main/exports; only bin and install hooks matter there.
  for (const key of o ? ["bin", "main", "exports"] : ["bin"]) {
    if (JSON.stringify(o?.[key]) !== JSON.stringify(n[key])) {
      notes.push({
        file: "package.json",
        note: `${key}: ${fmt(o?.[key])} → ${fmt(n[key])}`,
      });
    }
  }
  const gyp = newMap.get("binding.gyp");
  if (gyp && oldMap.get("binding.gyp")?.sha !== gyp.sha) {
    notes.push({
      file: "binding.gyp",
      note: "added or changed: npm runs node-gyp rebuild on install",
    });
  }
  return notes;
}

function actionManifests(
  oldRoot: string | null,
  newRoot: string,
  oldMap: Map<string, Entry>,
  newMap: Map<string, Entry>
): Note[] {
  const paths = new Set(
    [...oldMap.keys(), ...newMap.keys()].filter((p) =>
      MANIFESTS.has(basename(p).toLowerCase())
    )
  );
  const notes: Note[] = [];
  for (const rel of [...paths].sort()) {
    if (oldMap.get(rel)?.sha === newMap.get(rel)?.sha) continue;
    const before =
      oldRoot && oldMap.has(rel) ? join(oldRoot, rel) : "/dev/null";
    const after = newMap.has(rel) ? join(newRoot, rel) : "/dev/null";
    const { stdout } = run(
      "diff",
      ["-u", "--label", `old/${rel}`, "--label", `new/${rel}`, before, after],
      { ok: [0, 1] }
    );
    const state = !oldMap.has(rel)
      ? "added"
      : !newMap.has(rel)
        ? "removed"
        : "changed";
    notes.push({
      file: rel,
      note: `action manifest ${state}`,
      diff: stdout.toString(),
    });
  }
  return notes;
}

// ---- ast-grep ----------------------------------------------------------------------------

function astGrepVersion(): string {
  return run("ast-grep", ["--version"], { timeout: 10_000 })
    .stdout.toString()
    .trim();
}

// Tree-sitter's TypeScript grammar cannot read JSX, so each TypeScript rule gets a Tsx copy
// (`<id>--tsx`) for .tsx/.jsx; findings report the rule id without the suffix.
function buildConfig(work: string): string {
  const dir = join(work, "cfg");
  const tsxDir = join(dir, "tsx-rules");
  mkdirSync(tsxDir, { recursive: true });
  for (const name of readdirSync(RULES_DIR).filter((f) => f.endsWith(".yml"))) {
    const text = readFileSync(join(RULES_DIR, name), "utf8");
    if (!/^language: TypeScript$/m.test(text)) continue;
    const tsx = text
      .replace(/^id: (.+)$/m, "id: $1--tsx")
      .replace(/^language: TypeScript$/m, "language: Tsx");
    writeFileSync(join(tsxDir, name), tsx);
  }
  // JSON is valid YAML.
  const config = {
    ruleDirs: [RULES_DIR, tsxDir],
    languageGlobs: { typescript: ["*.js", "*.cjs", "*.mjs"], tsx: ["*.jsx"] },
  };
  const file = join(dir, "sgconfig.yml");
  writeFileSync(file, JSON.stringify(config, null, 2));
  return file;
}

function rulesHash(): string {
  const parts = readdirSync(RULES_DIR)
    .sort()
    .map((f) => `${f}\0${readFileSync(join(RULES_DIR, f), "utf8")}`);
  parts.push(readFileSync(import.meta.filename, "utf8"));
  return sha256(parts.join("\0"));
}

function astGrep(config: string, root: string, files: string[]): Finding[] {
  const out: Finding[] = [];
  const deadline = Date.now() + LIMITS.astGrepMs;
  for (let i = 0; i < files.length; i += CHUNK) {
    const chunk = files.slice(i, i + CHUNK);
    const remaining = deadline - Date.now();
    if (remaining <= 0)
      throw new ScanError(`ast-grep took over ${LIMITS.astGrepMs / 1000} s`);
    // Exit 1 means error-severity findings, not a failure.
    const { stdout, stderr } = run(
      "ast-grep",
      [
        "scan",
        "--config",
        config,
        "--json=stream",
        "--inspect",
        "summary",
        ...NO_IGNORE,
        "--",
        ...chunk,
      ],
      {
        cwd: root,
        timeout: remaining,
        maxBuffer: 512 * 1024 * 1024,
        ok: [0, 1],
      }
    );
    const scanned = /scannedFileCount=(\d+)/.exec(stderr);
    if (!scanned)
      throw new ScanError(
        `ast-grep printed no scan summary: ${short(stderr, 300)}`
      );
    if (Number(scanned[1]) !== chunk.length) {
      throw new ScanError(
        `ast-grep scanned ${scanned[1]} of ${chunk.length} files in ${root}`
      );
    }
    for (const line of stdout.toString().split("\n")) {
      if (!line.trim()) continue;
      const m = JSON.parse(line) as RawMatch;
      out.push({
        cls: m.severity === "error" ? "hold-candidate" : "review",
        rule: m.ruleId.replace(/--tsx$/, ""),
        file: m.file.replace(/^\.\//, ""),
        line: m.range.start.line + 1,
        text: m.text,
        message: m.message,
      });
    }
  }
  return out;
}

// ---- compare -----------------------------------------------------------------------------

function compare(
  label: string,
  oldRoot: string | null,
  newRoot: string,
  config: string
): Result {
  const oldMap = oldRoot ? walk(oldRoot) : new Map<string, Entry>();
  const newMap = walk(newRoot);
  const changed = [...newMap]
    .filter(([rel, e]) => oldMap.get(rel)?.sha !== e.sha)
    .map(([rel]) => rel)
    .sort();
  const removed = [...oldMap.keys()].filter((r) => !newMap.has(r)).length;

  const unscanned: Note[] = [];
  const info: Note[] = [];
  const scan: string[] = [];
  for (const rel of changed) {
    const e = newMap.get(rel)!;
    const c = classify(newRoot, rel, e);
    if (c.unscanned) unscanned.push({ file: rel, note: c.unscanned });
    if (!c.lang) continue;
    scan.push(rel);
    if (e.size > 1024 * 1024)
      info.push({ file: rel, note: `${(e.size / 1024 / 1024).toFixed(1)} MB` });
    if (c.lang === "typescript") {
      const text = readFileSync(join(newRoot, rel), "utf8");
      const lines = text.split("\n").length;
      if (text.length / lines > 500)
        info.push({
          file: rel,
          note: `minified (avg line ${Math.round(text.length / lines)} chars)`,
        });
    }
  }

  const manifest = [
    ...npmManifest(oldRoot, newRoot, oldMap, newMap),
    ...actionManifests(oldRoot, newRoot, oldMap, newMap),
  ];

  const newFindings = scan.length ? astGrep(config, newRoot, scan) : [];
  const oldScan = scan.filter((r) => oldMap.has(r) && !oldMap.get(r)!.special);
  const oldFindings =
    oldRoot && oldScan.length ? astGrep(config, oldRoot, oldScan) : [];

  const key = (f: Finding) => `${f.rule}\0${f.file}\0${canon(f.text)}`;
  const oldCount = new Map<string, number>();
  for (const f of oldFindings)
    oldCount.set(key(f), (oldCount.get(key(f)) ?? 0) + 1);
  const byKey = new Map<string, Finding[]>();
  for (const f of newFindings)
    byKey.set(key(f), [...(byKey.get(key(f)) ?? []), f]);

  const groups = new Map<string, Group>();
  const hold: Finding[] = [];
  const review: Finding[] = [];
  for (const [k, list] of byKey) {
    const added = list.length - (oldCount.get(k) ?? 0);
    if (added <= 0) continue;
    const f = list[0];
    if (!f) continue;
    const gk = `${f.cls}\0${f.rule}\0${f.file}`;
    const g = groups.get(gk) ?? {
      cls: f.cls,
      rule: f.rule,
      file: f.file,
      added: 0,
      listed: 0,
    };
    g.added += added;
    g.listed += list.length;
    groups.set(gk, g);
    (f.cls === "hold-candidate" ? hold : review).push(...list);
  }
  const order = (a: Finding, b: Finding) =>
    a.rule.localeCompare(b.rule) ||
    a.file.localeCompare(b.file) ||
    a.line - b.line;
  hold.sort(order);
  review.sort(order);
  const sortedGroups = [...groups.values()].sort(
    (a, b) =>
      (a.cls === b.cls ? 0 : a.cls === "hold-candidate" ? -1 : 1) ||
      a.rule.localeCompare(b.rule) ||
      a.file.localeCompare(b.file)
  );

  const clean =
    !hold.length && !review.length && !unscanned.length && !manifest.length;
  return {
    label,
    status: clean ? "clean" : "flagged",
    files: {
      changed: changed.length,
      added: changed.filter((r) => !oldMap.has(r)).length,
      removed,
      scanned: scan.length,
    },
    manifest,
    unscanned,
    info,
    groups: sortedGroups,
    hold,
    review,
  };
}

// ---- output ------------------------------------------------------------------------------

const findingLine = (f: Finding) =>
  `  ${f.rule}  ${f.file}:${f.line}  ${short(f.text)}`;

function printReview(r: Result, path: string, from: number): void {
  const page = r.review.slice(from, from + REVIEW_PAGE);
  if (!page.length) {
    console.log(`review findings: none from ${from}`);
    return;
  }
  console.log(
    `review findings ${from + 1}–${from + page.length} of ${r.review.length}:`
  );
  for (const f of page) console.log(findingLine(f));
  const rest = r.review.length - from - page.length;
  if (rest > 0) {
    console.log(
      `TRUNCATED: ${rest} more review findings — page with: ${SELF} show ${path} --from ${from + page.length}`
    );
  }
}

function report(r: Result, path: string, cached: boolean): void {
  const f = r.files;
  console.log(`vet-scan: ${r.label}${cached ? " (cached)" : ""}`);
  console.log(
    `files: ${f.changed} changed (${f.added} added), ${f.removed} removed · ${f.scanned} scanned · ${r.unscanned.length} unscanned`
  );
  console.log(`status: ${r.status}`);
  if (r.manifest.length) {
    console.log("manifest:");
    for (const m of r.manifest) {
      console.log(`  ${m.file}  ${m.note}`);
      if (m.diff) console.log(m.diff.replace(/^/gm, "    ").trimEnd());
    }
  }
  if (r.unscanned.length) {
    console.log("unscanned (read these by hand):");
    for (const u of r.unscanned) console.log(`  ${u.file}  ${u.note}`);
  }
  if (r.info.length) {
    console.log("info:");
    for (const i of r.info) console.log(`  ${i.file}  ${i.note}`);
  }
  if (r.groups.length) {
    console.log(
      "new findings by rule and file (+added over the old version / occurrences listed):"
    );
    for (const g of r.groups)
      console.log(`  ${g.cls}  ${g.rule}  ${g.file}  +${g.added}/${g.listed}`);
  }
  if (r.hold.length) {
    console.log("hold-candidates:");
    for (const g of r.groups.filter((g) => g.cls === "hold-candidate")) {
      const list = r.hold.filter((h) => h.rule === g.rule && h.file === g.file);
      for (const h of list.slice(0, HOLD_PER_GROUP))
        console.log(findingLine(h));
      if (list.length > HOLD_PER_GROUP) {
        console.log(
          `  … ${list.length - HOLD_PER_GROUP} more ${g.rule} in ${g.file} — ${SELF} show ${path} --hold`
        );
      }
    }
  }
  if (r.review.length) printReview(r, path, 0);
  console.log(`result: ${path}`);
}

// ---- commands ----------------------------------------------------------------------------

type Flags = {
  out?: string;
  keep: boolean;
  noCache: boolean;
  from: number;
  hold: boolean;
};

function parseArgs(argv: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = { keep: false, noCache: false, from: 0, hold: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--out") flags.out = argv[++i];
    else if (a === "--from") flags.from = Number(argv[++i]);
    else if (a === "--keep") flags.keep = true;
    else if (a === "--no-cache") flags.noCache = true;
    else if (a === "--hold") flags.hold = true;
    else if (a.startsWith("--")) throw new ScanError(`unknown flag ${a}`);
    else positional.push(a);
  }
  if (!Number.isInteger(flags.from) || flags.from < 0)
    throw new ScanError("--from takes a non-negative integer");
  return { positional, flags };
}

const PKG = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const NWO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA = /^[0-9a-f]{40}$/;

function usage(): never {
  throw new ScanError(
    "usage: vet-scan.ts npm <pkg> <old> <new> | npm-new <pkg> <v> | action <owner>/<repo> <old_sha> <new_sha> | dirs <old> <new> | show <json> [--from N] [--hold]"
  );
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);
  // Each command checks the count first, so the unused ones stay "" and are dropped from p.
  let [a = "", b = "", c = ""] = positional;

  if (cmd === "show") {
    if (positional.length !== 1) usage();
    const r = JSON.parse(readFileSync(a, "utf8")) as Result;
    if (flags.hold) {
      console.log(`hold-candidates: ${r.hold.length}`);
      for (const h of r.hold) console.log(findingLine(h));
    } else printReview(r, a, flags.from);
    return;
  }

  let label: string;
  let cacheable = true;
  if (cmd === "npm") {
    if (
      positional.length !== 3 ||
      !PKG.test(a) ||
      !VERSION.test(b) ||
      !VERSION.test(c)
    )
      usage();
    label = `npm ${a} ${b} → ${c}`;
  } else if (cmd === "npm-new") {
    if (positional.length !== 2 || !PKG.test(a) || !VERSION.test(b)) usage();
    label = `npm ${a}@${b} (new package, every finding counts)`;
  } else if (cmd === "action") {
    if (positional.length !== 3 || !NWO.test(a) || !SHA.test(b) || !SHA.test(c))
      usage();
    label = `action ${a} ${b.slice(0, 12)} → ${c.slice(0, 12)}`;
  } else if (cmd === "dirs") {
    if (positional.length !== 2) usage();
    a = realpathSync(a);
    b = realpathSync(b);
    label = `dirs ${a} → ${b}`;
    cacheable = false;
  } else if (cmd === "archive") {
    if (positional.length !== 2) usage();
    a = realpathSync(a);
    b = realpathSync(b);
    label = `archive ${basename(a)} → ${basename(b)}`;
    cacheable = false;
  } else usage();
  const p = [a, b, c].slice(0, positional.length);

  const full = `${cmd}-${p.join("-")}`.replace(/[^A-Za-z0-9._-]+/g, "_");
  const slug =
    full.length > 120
      ? `${full.slice(0, 110)}-${sha256(full).slice(0, 8)}`
      : full;
  const outDir = flags.out
    ? join(flags.out, "vet-scan")
    : join(WORK_ROOT, "results");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${slug}.json`);

  const cacheKey = cacheable
    ? sha256(JSON.stringify([cmd, ...p, astGrepVersion(), rulesHash()]))
    : "";
  const cachePath = join(WORK_ROOT, "cache", `${cacheKey}.json`);
  if (cacheable && !flags.noCache && existsSync(cachePath)) {
    const r = JSON.parse(readFileSync(cachePath, "utf8")) as Result;
    writeFileSync(outPath, JSON.stringify(r, null, 2));
    report(r, outPath, true);
    return;
  }

  mkdirSync(WORK_ROOT, { recursive: true });
  const work = mkdtempSync(join(WORK_ROOT, "run-"));
  try {
    const config = buildConfig(work);
    let oldRoot: string | null = null;
    let newRoot: string;
    if (cmd === "npm" || cmd === "npm-new") {
      const versions = cmd === "npm" ? [b, c] : [b];
      for (const [i, v] of versions.entries()) {
        const tgz = join(work, `${i}.tgz`);
        await fetchNpm(a, v, tgz);
        extract(tgz, join(work, `v${i}`));
      }
      oldRoot = versions.length === 2 ? join(work, "v0") : null;
      newRoot = join(work, `v${versions.length - 1}`);
    } else if (cmd === "action") {
      for (const [i, sha] of [b, c].entries()) {
        const tgz = join(work, `${i}.tgz`);
        fetchAction(a, sha, tgz);
        extract(tgz, join(work, `v${i}`));
      }
      [oldRoot, newRoot] = [join(work, "v0"), join(work, "v1")];
    } else if (cmd === "archive") {
      extract(a, join(work, "v0"));
      extract(b, join(work, "v1"));
      [oldRoot, newRoot] = [join(work, "v0"), join(work, "v1")];
    } else {
      [oldRoot, newRoot] = [a, b];
    }

    const r = compare(label, oldRoot, newRoot, config);
    writeFileSync(outPath, JSON.stringify(r, null, 2));
    if (cacheable) {
      mkdirSync(join(WORK_ROOT, "cache"), { recursive: true });
      writeFileSync(cachePath, JSON.stringify(r));
    }
    report(r, outPath, false);
  } finally {
    if (flags.keep) console.log(`kept: ${work}`);
    else rmSync(work, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (e) {
  console.log(`NOT SCANNED: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 2;
}
