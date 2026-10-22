import { parseAssembledScript } from "./parse.js";

const REPO = "https://github.com/Installomator/Installomator";
const RAW_SCRIPT = "https://raw.githubusercontent.com/Installomator/Installomator/main/Installomator.sh";
const PAGE = 60;

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let DATA = { labels: [] };
let byLabel = new Map();
let results = [];
let shown = 0;

const FACETS = {
  status: { title: "Status", get: (l) => [l.status], labels: { active: "Active", disabled: "Disabled", broken: "Broken" } },
  type: { title: "Install type", get: (l) => [l.type || "other"] },
  source: { title: "Download source", get: (l) => [l.source], labels: { static: "Fixed URL", github: "GitHub releases", sparkle: "Sparkle feed", dynamic: "Scraped / scripted" } },
  feat: {
    title: "Features",
    get: (l) => [l.advisories.length && "advisory", l.requires.includes("Apple silicon only") && "asOnly", l.requires.some((r) => r.startsWith("macOS")) && "osReq", l.updateTool && "updateTool", l.archSpecific && "arch", l.blockingProcesses && "blocking", l.packageID && "packageID", l.cli && "cli", l.aliases.length && "aliases"].filter(Boolean),
    labels: { advisory: "Maintainer advisory", asOnly: "Apple silicon only", osReq: "macOS version limits", updateTool: "Uses vendor updater", arch: "Arch-specific download", blocking: "Blocking processes", packageID: "Has package ID", cli: "CLI installer", aliases: "Has aliases" },
  },
};

const state = { q: "", sort: "relevance", status: new Set(["active"]), type: new Set(), source: new Set(), feat: new Set() };

/* ---------- loading ---------- */
async function load() {
  try {
    const r = await fetch("data/labels.json", { cache: "no-cache" });
    if (!r.ok) throw new Error(r.status);
    DATA = await r.json();
    DATA.mode = "snapshot";
  } catch {
    // Live fallback: parse the assembled script straight from GitHub
    const r = await fetch(RAW_SCRIPT);
    const text = await r.text();
    const version = (text.match(/^VERSION="([^"]+)"/m) || [])[1];
    DATA = { labels: parseAssembledScript(text), version, generated: new Date().toISOString(), mode: "live" };
  }
  for (const l of DATA.labels) {
    l.advisories ||= []; l.requires ||= [];
    l._hay = [l.label, ...l.aliases, l.name, l.teamID, l.packageID, l.appName, l.host, l.github, l.type, ...l.requires].filter(Boolean).join(" ").toLowerCase();
    byLabel.set(l.label, l);
    for (const a of l.aliases) if (!byLabel.has(a)) byLabel.set(a, l);
  }
  const active = DATA.labels.filter((l) => l.status === "active").length;
  const when = DATA.generated ? new Date(DATA.generated).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "";
  $("#meta").innerHTML = `<b>${active.toLocaleString()}</b> active labels · v${esc(DATA.version || "?")} · ${DATA.mode === "live" ? "live from main" : "synced " + esc(when)}`;
}

/* ---------- query ---------- */
function parseQuery(q) {
  const terms = [], filters = [];
  for (const tok of q.toLowerCase().match(/\S+/g) || []) {
    const m = tok.match(/^(team|type|host|gh|pkg|status|label):(.+)$/);
    m ? filters.push([m[1], m[2]]) : terms.push(tok);
  }
  return { terms, filters };
}

function matchFilter(l, [k, v]) {
  const has = (s) => (s || "").toLowerCase().includes(v);
  switch (k) {
    case "team": return (l.teamID || "").toLowerCase() === v;
    case "type": return (l.type || "").toLowerCase() === v;
    case "host": return has(l.host) || (v.includes("github") && l.github);
    case "gh": return has(l.github);
    case "pkg": return has(l.packageID);
    case "status": return l.status === v;
    case "label": return l.label === v || l.aliases.includes(v);
  }
  return true;
}

function score(l, terms) {
  let s = 0;
  const name = l.name.toLowerCase();
  const all = [l.label, ...l.aliases];
  for (const t of terms) {
    if (!l._hay.includes(t)) return -1;
    if (all.includes(t)) s += 100;
    else if (all.some((a) => a.startsWith(t))) s += 60;
    else if (name.startsWith(t)) s += 50;
    else if (new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(name)) s += 40;
    else if (all.some((a) => a.includes(t))) s += 25;
    else s += 5;
  }
  // Labels the maintainers say not to use sink below their recommended alternative
  return l.advisories.length ? Math.max(1, s - 40) : s;
}

function facetPass(l, skip = []) {
  for (const k of Object.keys(FACETS)) {
    if (skip.includes(k) || !state[k].size) continue;
    const vals = FACETS[k].get(l);
    if (k === "feat" ? ![...state.feat].every((f) => vals.includes(f)) : !vals.some((v) => state[k].has(v))) return false;
  }
  return true;
}

function run() {
  const { terms, filters } = parseQuery(state.q);
  // An explicit status: or label: filter in the query overrides the status facet
  const statusOverride = filters.some(([k]) => k === "status" || k === "label");
  const base = [];
  for (const l of DATA.labels) {
    if (!filters.every((f) => matchFilter(l, f))) continue;
    const s = terms.length ? score(l, terms) : 0;
    if (s < 0) continue;
    l._score = s;
    base.push(l);
  }
  const skipStatus = statusOverride ? "status" : null;
  results = base.filter((l) => facetPass(l, [skipStatus]));

  const sort = state.sort === "relevance" && !terms.length ? "name" : state.sort;
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.label.localeCompare(b.label);
  const cmp = {
    relevance: (a, b) => b._score - a._score || byName(a, b),
    name: byName,
    updated: (a, b) => (b.updated || "").localeCompare(a.updated || "") || byName(a, b),
    added: (a, b) => (b.added || "").localeCompare(a.added || "") || byName(a, b),
  }[sort];
  results.sort(cmp);

  renderFacets(base, skipStatus);
  renderResbar(terms, filters);
  $("#grid").innerHTML = "";
  shown = 0;
  more();
  writeURL();
}

/* ---------- rendering ---------- */
function hue(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360; }
function tile(l) {
  const ch = (l.name.match(/[A-Za-z0-9]/) || ["?"])[0].toUpperCase();
  return `<div class="mono-tile" style="background:hsl(${hue(l.teamID || l.label)} 45% 42%)" aria-hidden="true">${esc(ch)}</div>`;
}
function hl(text, terms) {
  let out = esc(text);
  for (const t of terms) if (t.length > 1) out = out.replace(new RegExp(`(${esc(t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "ig"), "<mark>$1</mark>");
  return out;
}
function rel(d) {
  if (!d) return "";
  const days = Math.round((Date.now() - new Date(d)) / 864e5);
  if (days < 1) return "today";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.round(days / 30)}mo ago`;
  return `${(days / 365).toFixed(1).replace(/\.0$/, "")}y ago`;
}

function card(l, terms) {
  const status = l.status !== "active" ? `<span class="badge ${l.status}">${l.status}</span>` : "";
  const where = l.github ? `github · ${l.github}` : l.host || (l.source === "sparkle" ? "sparkle feed" : "");
  const adv = l.advisories[0];
  const advice = adv
    ? `<div class="advice"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M12 3 2 21h20L12 3z"/><path d="M12 10v5M12 18v.01"/></svg><span>${adv.instead.length ? `Not recommended. Use <b>${adv.instead.map(esc).join("</b> or <b>")}</b>` : esc(adv.text)}</span></div>`
    : "";
  const reqs = l.requires.map((r) => `<span class="badge req">${esc(r)}</span>`).join("");
  return `<button class="card${adv ? " warn" : ""}" data-label="${esc(l.label)}">
    ${tile(l)}
    <div class="title">${hl(l.name, terms)}</div>
    <div class="lbl">${hl(l.label, terms)}${l.aliases.length ? ` <span style="color:var(--ink-3)">+${l.aliases.length}</span>` : ""}</div>
    ${advice}
    <div class="foot">${status}${reqs}<span class="badge">${esc(l.type || "?")}</span><span class="host">${esc(where)}</span>${l.updated ? `<span class="date" title="Updated ${esc(l.updated)}">${rel(l.updated)}</span>` : ""}</div>
  </button>`;
}

function more() {
  const grid = $("#grid");
  if (!results.length) { grid.innerHTML = `<div class="empty">No labels match. Try a shorter search or clear the filters.</div>`; return; }
  const { terms } = parseQuery(state.q);
  grid.insertAdjacentHTML("beforeend", results.slice(shown, shown + PAGE).map((l) => card(l, terms)).join(""));
  shown += PAGE;
}

function renderFacets(base, skipStatus) {
  let html = "";
  for (const [k, f] of Object.entries(FACETS)) {
    const counts = new Map();
    for (const l of base) if (facetPass(l, [k, skipStatus])) for (const v of f.get(l)) counts.set(v, (counts.get(v) || 0) + 1);
    const keys = f.labels ? Object.keys(f.labels) : [...counts.keys()].sort((a, b) => (counts.get(b) || 0) - (counts.get(a) || 0));
    html += `<h3>${f.title}</h3>` + keys.map((v) => {
      const n = counts.get(v) || 0;
      return `<label class="facet${n ? "" : " zero"}"><input type="checkbox" data-facet="${k}" value="${esc(v)}" ${state[k].has(v) ? "checked" : ""}> ${esc(f.labels?.[v] || v)}<span class="n">${n}</span></label>`;
    }).join("");
  }
  html += `<button class="clear" id="clearAll" type="button">Reset filters</button>`;
  $("#facets").innerHTML = html;
}

function renderResbar(terms, filters) {
  const chips = filters.map(([k, v]) => `<button class="chip" data-rm="${esc(k + ":" + v)}">${esc(k)}:${esc(v)} ✕</button>`).join("");
  $("#resbar").innerHTML = `<span><b>${results.length.toLocaleString()}</b> label${results.length === 1 ? "" : "s"}</span><span class="chips">${chips}</span>`;
}

/* ---------- detail ---------- */
function highlightBash(src) {
  const re = /(^|[\s;(])(#[^\n]*)|("(?:[^"\\]|\\.)*"|'[^']*')|(\$\{[^}]*\}|\$\(|\$[\w@#?]+)|\b(if|then|else|elif|fi|case|esac|in|for|do|done|while|function|return|local)\b|^([ \t]*)([A-Za-z_]\w*)(?==)/gm;
  let out = "", last = 0, m;
  while ((m = re.exec(src))) {
    out += esc(src.slice(last, m.index));
    if (m[2]) out += esc(m[1]) + `<span class="c">${esc(m[2])}</span>`;
    else if (m[3]) out += `<span class="s">${esc(m[3]).replace(/(\$\{[^}]*\}|\$[\w@#?]+)/g, '<span class="v">$1</span>')}</span>`;
    else if (m[4]) out += `<span class="v">${esc(m[4])}</span>`;
    else if (m[5]) out += `<span class="k">${m[5]}</span>`;
    else if (m[7]) out += esc(m[6]) + `<span class="a">${esc(m[7])}</span>`;
    last = re.lastIndex;
  }
  return out + esc(src.slice(last));
}

// Turn other label names mentioned in a message into links
function linkLabels(text, self) {
  return esc(text).replace(/\b[\w-]+\b/g, (w) => (w !== self.label && byLabel.has(w) && /[a-z]/.test(w) && w.length > 3 && /pkg|_|\d/.test(w)
    ? `<button class="linkbtn mono" type="button" data-open="${w}">${w}</button>` : w));
}

const copyRow = (text, label = "Copy") => `<div class="copyrow"><code>${esc(text)}</code><button type="button" data-copy="${esc(text)}">${label}</button></div>`;

function openDetail(name, push = true) {
  const l = byLabel.get(name);
  if (!l) return;
  const file = l.path ? `${REPO}/blob/main/${l.path}` : `${REPO}/search?q=${encodeURIComponent(`path:fragments "${l.label})"`)}&type=code`;
  const hist = l.path ? `${REPO}/commits/main/${l.path}` : null;
  const siblings = l.teamID ? DATA.labels.filter((x) => x.teamID === l.teamID && x !== l && x.status === "active") : [];
  const dl = l.github
    ? `GitHub releases: <a href="https://github.com/${esc(l.github)}/releases" target="_blank" rel="noopener">${esc(l.github)}</a>`
    : l.source === "static" ? `<a href="${esc(l.fields.downloadURL?.replace(/^"|"$/g, ""))}" rel="noopener nofollow" target="_blank">${esc(l.host)}</a> <span style="color:var(--ink-3)">(fixed URL)</span>`
    : l.source === "sparkle" ? `Sparkle appcast${l.host ? " · " + esc(l.host) : ""}`
    : `Worked out at runtime${l.host ? " · " + esc(l.host) : ""}`;
  const fact = (k, v) => (v ? `<dt>${k}</dt><dd>${v}</dd>` : "");
  const statusNote = l.status !== "active"
    ? `<div class="badge ${l.status}" style="padding:8px 12px;font-family:var(--sans);font-size:14px">This label is <b>${l.status}</b>${l.status === "disabled" ? ". It isn't in the released Installomator.sh." : " and only exists for testing."}</div>` : "";

  $("#detail").innerHTML = `<div class="sheet" role="document">
    <div class="sheet-head">${tile(l)}<div><h2>${esc(l.name)}</h2><div class="sub mono">${esc(l.label)}${l.aliases.length ? " · " + l.aliases.map(esc).join(" · ") : ""}</div></div><button class="close" type="button" data-close aria-label="Close">✕</button></div>
    <div class="sheet-body">
      ${statusNote}
      ${l.advisories.map((a) => `<div class="callout"><div class="callout-title">Maintainer advisory</div><p>${linkLabels(a.text, l)}</p>${a.instead.filter((x) => byLabel.has(x)).length ? `<div class="related">Use instead: ${a.instead.filter((x) => byLabel.has(x)).map((x) => `<button type="button" data-open="${esc(x)}">${esc(x)}</button>`).join("")}</div>` : ""}</div>`).join("")}
      <div class="stack"><h4>Use it</h4>
        ${copyRow(l.label, "Copy label")}
        ${copyRow(`sudo /usr/local/Installomator/Installomator.sh ${l.label} NOTIFY=silent`)}
        ${copyRow(`sudo /usr/local/Installomator/Installomator.sh ${l.label} DEBUG=1`, "Copy test")}
      </div>
      <div><h4>Details</h4><dl class="facts">
        ${fact("Install type", `<code>${esc(l.type || "—")}</code>`)}
        ${fact("Requires", l.requires.length && l.requires.map((r) => `<span class="badge req">${esc(r)}</span>`).join(" "))}
        ${fact("Team ID", l.teamID ? `<button class="linkbtn mono" data-q="team:${esc(l.teamID)}">${esc(l.teamID)}</button>` : "")}
        ${fact("Package ID", l.packageID && `<code>${esc(l.packageID)}</code>`)}
        ${fact("App name", l.appName && esc(l.appName))}
        ${fact("Download", dl)}
        ${fact("Version check", l.fields.appNewVersion ? (l.github ? "Latest GitHub release" : l.source === "sparkle" ? "Sparkle feed" : "Checked before download") : "Compared after download")}
        ${fact("Blocking", l.blockingProcesses && l.blockingProcesses.map((p) => `<code>${esc(p)}</code>`).join(", "))}
        ${fact("Vendor updater", l.updateTool && `<code>${esc(l.fields.updateTool.replace(/^"|"$/g, ""))}</code>`)}
        ${fact("Architecture", l.archSpecific && "Separate Intel and Apple silicon downloads")}
        ${fact("Added", l.added && `${esc(l.added)} <span style="color:var(--ink-3)">(${rel(l.added)})</span>`)}
        ${fact("Updated", l.updated && `${esc(l.updated)} <span style="color:var(--ink-3)">(${rel(l.updated)})</span>`)}
        ${fact("Fragment", l.path && `<code>${esc(l.path)}</code>`)}
      </dl></div>
      ${l.comments.length ? `<div><h4>Notes in the label</h4><ul class="notes">${l.comments.map((c) => `<li>${esc(c)}</li>`).join("")}</ul></div>` : ""}
      <div><h4>Label source</h4><pre class="code"><code>${highlightBash(l.code)}</code></pre></div>
      <div class="actions">
        <a class="btn primary" href="${file}" target="_blank" rel="noopener">View on GitHub</a>
        ${hist ? `<a class="btn" href="${hist}" target="_blank" rel="noopener">History</a>` : ""}
        <a class="btn" href="${REPO}/issues?q=${encodeURIComponent(l.label)}" target="_blank" rel="noopener">Related issues</a>
        <button class="btn" type="button" data-copy="${esc(l.code)}">Copy source</button>
      </div>
      ${siblings.length ? `<div><h4>More from this developer (${siblings.length})</h4><div class="related">${siblings.slice(0, 40).map((s) => `<button type="button" data-open="${esc(s.label)}" title="${esc(s.name)}">${esc(s.label)}</button>`).join("")}</div></div>` : ""}
    </div></div>`;
  const dlg = $("#detail");
  if (!dlg.open) dlg.showModal();
  dlg.querySelector(".sheet").scrollTop = 0;
  document.title = `${l.name} (${l.label}) · Installomator Labels`;
  if (push) history.pushState(null, "", `#${encodeURIComponent(l.label)}`);
}

function closeDetail(push = true) {
  const dlg = $("#detail");
  if (dlg.open) dlg.close();
  document.title = "Installomator Labels";
  if (push && location.hash) history.pushState(null, "", location.pathname + location.search);
}

/* ---------- URL state ---------- */
function writeURL() {
  const p = new URLSearchParams();
  if (state.q) p.set("q", state.q);
  if (state.sort !== "relevance") p.set("sort", state.sort);
  for (const k of Object.keys(FACETS)) {
    const v = [...state[k]].join(",");
    if (k === "status" ? v !== "active" : v) p.set(k, v || "none");
  }
  const s = p.toString();
  history.replaceState(null, "", (s ? "?" + s : location.pathname) + location.hash);
}
function readURL() {
  const p = new URLSearchParams(location.search);
  state.q = p.get("q") || "";
  state.sort = p.get("sort") || "relevance";
  for (const k of Object.keys(FACETS)) {
    const v = p.get(k);
    state[k] = new Set(v == null ? (k === "status" ? ["active"] : []) : v === "none" ? [] : v.split(","));
  }
  $("#q").value = state.q;
  $("#sort").value = state.sort;
}

/* ---------- events ---------- */
function setQuery(q) { state.q = q; $("#q").value = q; run(); }

let t;
$("#q").addEventListener("input", (e) => { clearTimeout(t); t = setTimeout(() => { state.q = e.target.value.trim(); run(); }, 90); });
$("#q").addEventListener("keydown", (e) => { if (e.key === "Enter" && results[0]) openDetail(results[0].label); });
$("#sort").addEventListener("change", (e) => { state.sort = e.target.value; run(); });
$("#filtersToggle").addEventListener("click", () => $("#facets").classList.toggle("open"));

document.addEventListener("change", (e) => {
  const f = e.target.dataset?.facet;
  if (!f) return;
  e.target.checked ? state[f].add(e.target.value) : state[f].delete(e.target.value);
  run();
});

document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-label],[data-open],[data-copy],[data-q],[data-rm],[data-close],#clearAll");
  if (!el) { if (e.target === $("#detail")) closeDetail(); return; }
  if (el.dataset.label) openDetail(el.dataset.label);
  else if (el.dataset.open) openDetail(el.dataset.open);
  else if (el.dataset.q != null) { closeDetail(); setQuery(el.dataset.q); }
  else if (el.dataset.rm) setQuery(state.q.split(/\s+/).filter((x) => x.toLowerCase() !== el.dataset.rm).join(" "));
  else if (el.dataset.close != null) closeDetail();
  else if (el.id === "clearAll") { state.status = new Set(["active"]); for (const k of ["type", "source", "feat"]) state[k].clear(); run(); }
  else if (el.dataset.copy != null) {
    try { await navigator.clipboard.writeText(el.dataset.copy); } catch {
      const ta = Object.assign(document.createElement("textarea"), { value: el.dataset.copy }); document.body.append(ta); ta.select(); document.execCommand("copy"); ta.remove();
    }
    const old = el.textContent; el.textContent = "Copied"; el.classList.add("done");
    setTimeout(() => { el.textContent = old; el.classList.remove("done"); }, 1200);
  }
});

$("#detail").addEventListener("cancel", (e) => { e.preventDefault(); closeDetail(); });
window.addEventListener("popstate", () => { const h = decodeURIComponent(location.hash.slice(1)); h ? openDetail(h, false) : closeDetail(false); });
document.addEventListener("keydown", (e) => {
  if (e.key === "/" && document.activeElement !== $("#q") && !$("#detail").open) { e.preventDefault(); $("#q").focus(); $("#q").select(); }
});

new IntersectionObserver((es) => { if (es[0].isIntersecting && shown < results.length) more(); }, { rootMargin: "800px" }).observe($("#sentinel"));

/* ---------- boot ---------- */
readURL();
load().then(() => {
  run();
  const h = decodeURIComponent(location.hash.slice(1));
  if (h) openDetail(h, false);
}).catch((err) => {
  $("#grid").innerHTML = `<div class="empty">Couldn't load label data (${esc(err.message)}).</div>`;
});
