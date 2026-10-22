#!/usr/bin/env node
// Build data/labels.json from an Installomator checkout.
// Usage: node scripts/build-labels.mjs <path-to-Installomator-clone> [out.json]
// For added/updated dates the clone needs history (a `--filter=blob:none` clone is enough).

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { parseLabel } from "../parse.js";

const repo = process.argv[2];
const out = process.argv[3] || new URL("../data/labels.json", import.meta.url).pathname;
if (!repo || !existsSync(join(repo, "fragments"))) {
  console.error("usage: build-labels.mjs <Installomator clone> [out.json]");
  process.exit(1);
}

const git = (...args) => {
  try { return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 1 << 28 }); }
  catch { return ""; }
};

// One pass over history: newest commit touching a path = updated, oldest = added.
const dates = {};
let when = null;
for (const line of git("log", "--format=@@%cI", "--name-only", "--", "fragments/labels", "fragments/disabled", "fragments/broken").split("\n")) {
  if (line.startsWith("@@")) when = line.slice(2, 12);
  else if (line.endsWith(".sh") && when) {
    const d = (dates[line] ||= { updated: when, added: when });
    d.added = when;
  }
}

const labels = [];
const problems = [];
for (const [dir, status] of [["labels", "active"], ["disabled", "disabled"], ["broken", "broken"]]) {
  const full = join(repo, "fragments", dir);
  if (!existsSync(full)) continue;
  for (const f of readdirSync(full).filter((f) => f.endsWith(".sh")).sort()) {
    const path = `fragments/${dir}/${f}`;
    const parsed = parseLabel(readFileSync(join(full, f), "utf8"), {
      status, path, ...(dates[path] || {}),
    });
    parsed ? labels.push(parsed) : problems.push(path);
  }
}

const data = {
  generated: new Date().toISOString(),
  commit: git("rev-parse", "HEAD").trim() || null,
  version: (() => { try { return readFileSync(join(repo, "fragments/version.sh"), "utf8").trim(); } catch { return null; } })(),
  count: labels.length,
  labels,
};

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(data));
console.log(`wrote ${labels.length} labels to ${out}` + (problems.length ? `; unparsed: ${problems.join(", ")}` : ""));
