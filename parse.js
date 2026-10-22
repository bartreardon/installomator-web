// Shared parser for Installomator label fragments.
// Used by scripts/build-labels.mjs (Node) and by the page as a live fallback.

// A case header: `foo)` or `foo|bar)` or `foo|\` + newline + `bar)`.
const HEADER = /^[ \t]*((?:[\w.+-]+[ \t]*\|[ \t]*(?:\\\r?\n[ \t]*)?)*[\w.+-]+)\)[ \t]*$/m;

const FIELDS = [
  "name", "type", "downloadURL", "appNewVersion", "expectedTeamID", "packageID",
  "archiveName", "appName", "pkgName", "versionKey", "blockingProcesses",
  "updateTool", "updateToolArguments", "CLIInstaller", "CLIArguments",
  "installerTool", "targetDir", "curlOptions", "appCustomVersion",
];

function unquote(v) {
  v = v.trim();
  const m = v.match(/^"([^"$`]*)"$/) || v.match(/^'([^']*)'$/);
  return m ? m[1] : v;
}

/** Parse one fragment (a single case item). Returns null if no header. */
export function parseLabel(block, extra = {}) {
  const head = block.match(HEADER);
  if (!head) return null;
  const labels = head[1].split("|").map((s) => s.replace(/\\/g, "").trim()).filter(Boolean);

  // First assignment of each known field wins (labels often branch by arch).
  const fields = {};
  const re = /^[ \t]+([A-Za-z_]\w*)=(.*)$/gm;
  let m;
  while ((m = re.exec(block))) {
    const [, k, v] = m;
    if (FIELDS.includes(k) && !(k in fields)) fields[k] = v.trim();
  }

  const val = (k) => (fields[k] != null ? unquote(fields[k]) : null);
  const isLiteral = (s) => s != null && !/[$`]/.test(s);

  const downloadURL = val("downloadURL");
  let host = null;
  const urlish = (downloadURL || "").match(/https?:\/\/([^/"'\s$)]+)/);
  if (urlish) host = urlish[1].replace(/\\/g, "").toLowerCase();

  const gh = block.match(/(?:downloadURLFromGit|versionFromGit)\s+"?([\w.-]+)"?\s+"?([\w.-]+)"?/);
  const github = gh ? `${gh[1]}/${gh[2]}` : null;

  let source = "dynamic";
  if (github) source = "github";
  else if (/sparkle|appcast/i.test(block)) source = "sparkle";
  else if (isLiteral(downloadURL)) source = "static";

  let blocking = fields.blockingProcesses || null;
  if (blocking) {
    const arr = blocking.match(/^\(\s*(.*?)\s*\)$/);
    blocking = arr
      ? (arr[1].match(/"[^"]*"|'[^']*'|\S+/g) || []).map(unquote)
      : [unquote(blocking)];
  }

  const comments = block
    .split("\n")
    .map((l) => l.match(/^\s*#\s?(.*)$/))
    .filter(Boolean)
    .map((c) => c[1].trim())
    .filter((c) => c && !/^#+$/.test(c));

  // printlog "…" REQ is always printed: maintainers use it for "don't use this label" advisories.
  const advisories = [];
  for (const [, msg] of block.matchAll(/printlog\s+"((?:[^"\\]|\\.)*)"\s+REQ\b/g)) {
    const text = msg.replace(/^WARNING for ERROR:\s*/i, "").trim();
    const after = (text.match(/instead use\s+(.+?)(?:\s+as\b|\.|$)/i) || [])[1] || "";
    advisories.push({ text, instead: after.match(/[\w.-]+/g)?.filter((w) => !/^(and|or)$/i.test(w)) || [] });
  }

  // Hard requirements: messages the label prints right before refusing to run.
  const requires = new Set();
  const exitMsgs = [...block.matchAll(/(?:printlog|cleanupAndExit\s+\d+)\s+"((?:[^"\\]|\\.)*)"(?:\s+(ERROR))?/g)]
    .filter((m) => m[2] || /cleanupAndExit/.test(m[0]))
    .map((m) => m[1]);
  for (const msg of exitMsgs) {
    if (/\$/.test(msg)) continue; // conditional on runtime values (e.g. "macOS ${osVersion}")
    if (/(requires|only (?:compatible with|available)[^.]*)\s+(?:Apple Silicon|arm64)|Apple Silicon \(arm64\) Macs/i.test(msg)) requires.add("Apple silicon only");
    const earlier = msg.match(/macOS (\d+(?:\.\d+)?) and earlier/i);
    const later = msg.match(/requires\b[^.;]*?macOS (\d+(?:\.\d+)?) or later/i);
    if (earlier) requires.add(`macOS ${earlier[1]} or earlier`);
    else if (later) requires.add(`macOS ${later[1]}+`);
  }

  const name = val("name");
  return {
    label: labels[0],
    aliases: labels.slice(1),
    name: isLiteral(name) && name ? name : labels[0],
    type: val("type"),
    teamID: val("expectedTeamID"),
    packageID: isLiteral(val("packageID")) ? val("packageID") : null,
    appName: isLiteral(val("appName")) ? val("appName") : null,
    host,
    github,
    source,
    archSpecific: /\$\((?:\/usr\/bin\/)?arch\)|uname -m|\$arch\b/.test(block),
    updateTool: fields.updateTool != null,
    cli: fields.CLIInstaller != null,
    blockingProcesses: blocking,
    advisories,
    requires: [...requires],
    comments,
    fields,
    code: block.replace(/\s+$/, "") + "\n",
    ...extra,
  };
}

/**
 * Split the assembled Installomator.sh into label blocks (live fallback).
 * Uses the region between `case $label in` and the catch-all `*)`.
 */
export function parseAssembledScript(text) {
  const start = text.indexOf("\ncase $label in");
  const end = text.indexOf("\n*)", start);
  const body = text.slice(text.indexOf("\n", start + 1) + 1, end > 0 ? end : undefined);
  const lines = body.split("\n");
  const starts = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!/^ {0,4}[\w.+-]+(\|[\w.+-]*)*(\)|\|\\)\s*$/.test(l)) continue;
    // Real label headers are followed closely by an assignment, nested case arms usually aren't
    const next = lines.slice(i + 1, i + 6).join("\n");
    if (/^\s+(name|type|downloadURL)=/m.test(next) || /\|\\\s*$/.test(l)) {
      // skip continuation lines of a multi-line header
      if (starts.length && /\|\\\s*$/.test(lines[i - 1] || "")) continue;
      starts.push(i);
    }
  }
  const out = [];
  for (let s = 0; s < starts.length; s++) {
    const block = lines.slice(starts[s], starts[s + 1] ?? lines.length).join("\n");
    const parsed = parseLabel(block, { status: "active" });
    if (parsed) out.push(parsed);
  }
  return out;
}
