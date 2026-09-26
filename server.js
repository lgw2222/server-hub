// Server Hub: install, run and update your local server apps from their GitHub Pages sites.
// Install this once. Every app after that is just a URL.

const express = require("express");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, execFile } = require("child_process");

const PORT = process.env.HUB_PORT || 4000;
const ROOT = __dirname;
const APPS_DIR = path.join(ROOT, "apps");
const STATE_FILE = path.join(ROOT, "apps.json");
const CFG_FILE = path.join(ROOT, "hub-config.json");
const SHARED_MODULES = path.join(ROOT, "node_modules");

fs.mkdirSync(APPS_DIR, { recursive: true });

const readJson = (p, fallback) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; } };
const writeJson = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2));

let apps = readJson(STATE_FILE, []);
let cfg = readJson(CFG_FILE, { selfUrl: "" });
const saveApps = () => writeJson(STATE_FILE, apps);

// ---------- running processes ----------
const procs = new Map(); // slug -> { child, log: [], startedAt, crashed }
const logLine = (slug, line) => {
  const p = procs.get(slug);
  if (!p) return;
  p.log.push(`${new Date().toLocaleTimeString()}  ${line}`);
  if (p.log.length > 300) p.log.splice(0, p.log.length - 300);
};

function startApp(app) {
  if (procs.get(app.slug)?.child) return;
  const dir = path.join(APPS_DIR, app.slug);
  const entry = path.join(dir, app.entry);
  if (!fs.existsSync(entry)) throw new Error(`${app.entry} is missing. Try Update.`);
  const child = spawn(process.execPath, [app.entry], {
    cwd: dir,
    env: { ...process.env, PORT: String(app.port), NODE_PATH: SHARED_MODULES },
  });
  const rec = { child, log: [], startedAt: Date.now() };
  procs.set(app.slug, rec);
  child.stdout.on("data", (d) => String(d).split("\n").filter(Boolean).forEach((l) => logLine(app.slug, l)));
  child.stderr.on("data", (d) => String(d).split("\n").filter(Boolean).forEach((l) => logLine(app.slug, l)));
  child.on("exit", (code) => {
    logLine(app.slug, `— stopped (exit ${code})`);
    const r = procs.get(app.slug);
    if (r) r.child = null;
    // exit code 7 means the app updated itself and wants to come back
    if (code === 7) setTimeout(() => { try { startApp(app); } catch {} }, 500);
  });
  logLine(app.slug, `— started on port ${app.port}`);
}

function stopApp(slug) {
  const rec = procs.get(slug);
  if (!rec?.child) return;
  const child = rec.child;
  rec.child = null;
  if (process.platform === "win32") execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => {});
  else child.kill("SIGTERM");
}

const isRunning = (slug) => Boolean(procs.get(slug)?.child);

// ---------- fetching an app from its Pages site ----------
async function getText(url, timeout = 20000) {
  const bust = url + (url.includes("?") ? "&" : "?") + "t=" + Date.now();
  let r;
  try { r = await fetch(bust, { signal: AbortSignal.timeout(timeout) }); }
  catch { throw new Error(`Couldn't reach ${url}. Check the address and your internet.`); }
  if (!r.ok) throw new Error(`${url} returned ${r.status}. GitHub Pages can take a minute after an upload.`);
  return r.text();
}

async function readManifest(baseUrl) {
  const base = baseUrl.replace(/\/+$/, "");
  const text = await getText(`${base}/app.json`);
  let m;
  try { m = JSON.parse(text); } catch { throw new Error("app.json at that address isn't valid JSON. Is the address right?"); }
  if (!m.entry || !Array.isArray(m.files) || !m.files.length) throw new Error("app.json needs a name, an entry and a files list.");
  if (m.files.some((f) => f.includes("..") || path.isAbsolute(f))) throw new Error("app.json contains an unsafe file path.");
  if (!m.files.includes(m.entry)) throw new Error(`app.json lists ${m.entry} as the entry but doesn't include it in files.`);
  m.slug = String(m.slug || m.name || "app").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");
  m.keep = Array.isArray(m.keep) ? m.keep : [];
  m.base = base;
  return m;
}

// download every file in the manifest, then remove local files it no longer lists
async function syncFiles(app, manifest) {
  const dir = path.join(APPS_DIR, app.slug);
  fs.mkdirSync(dir, { recursive: true });
  const downloaded = [];
  for (const rel of manifest.files) {
    const text = await getText(`${manifest.base}/${rel}`);
    downloaded.push({ rel, text });
  }
  const changed = [];
  for (const f of downloaded) {
    const dest = path.join(dir, f.rel);
    let cur = "";
    try { cur = fs.readFileSync(dest, "utf8"); } catch {}
    if (cur.trim() === f.text.trim()) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (cur) {
      const bak = path.join(dir, "backup", f.rel);
      fs.mkdirSync(path.dirname(bak), { recursive: true });
      fs.writeFileSync(bak, cur);
    }
    fs.writeFileSync(dest, f.text);
    changed.push(f.rel);
  }
  // clean up files the app dropped, never touching data files or backups
  const protectedPaths = new Set([...manifest.files, ...manifest.keep]);
  const removed = [];
  const walk = (d, prefix = "") => {
    for (const name of fs.readdirSync(d)) {
      if (name === "backup" || name === "node_modules") continue;
      const full = path.join(d, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (fs.statSync(full).isDirectory()) { walk(full, rel); if (!fs.readdirSync(full).length) fs.rmdirSync(full); }
      else if (!protectedPaths.has(rel)) { fs.unlinkSync(full); removed.push(rel); }
    }
  };
  walk(dir);
  return { changed, removed };
}

function nextPort(preferred) {
  const used = new Set(apps.map((a) => a.port));
  let p = Number(preferred) || 3001;
  while (used.has(p) || p === Number(PORT)) p++;
  return p;
}

// ---------- routes ----------
const app = express();
app.use(express.json());
app.use(express.static(path.join(ROOT, "public")));
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => res.status(500).json({ error: e.message }));
const lanIp = () => (Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal) || {}).address || "localhost";

app.get("/api/apps", (req, res) => res.json({
  host: lanIp(),
  selfUrl: cfg.selfUrl,
  apps: apps.map((a) => ({ ...a, running: isRunning(a.slug), url: `http://${lanIp()}:${a.port}` })),
}));

app.post("/api/apps", wrap(async (req, res) => {
  const url = String(req.body.url || "").trim();
  if (!/^https?:\/\//.test(url)) return res.status(400).json({ error: "Enter the app's address, starting with https://" });
  const m = await readManifest(url);
  if (apps.some((a) => a.slug === m.slug)) throw new Error(`${m.name || m.slug} is already installed. Use Update instead.`);
  const app_ = { slug: m.slug, name: m.name || m.slug, url: m.base, entry: m.entry, port: nextPort(m.port), autostart: true };
  const result = await syncFiles(app_, m);
  apps.push(app_); saveApps();
  startApp(app_);
  res.json({ app: app_, ...result });
}));

app.post("/api/apps/:slug/update", wrap(async (req, res) => {
  const a = apps.find((x) => x.slug === req.params.slug);
  if (!a) return res.status(404).json({ error: "Not installed" });
  const m = await readManifest(a.url);
  const was = isRunning(a.slug);
  const result = await syncFiles(a, m);
  a.entry = m.entry; a.name = m.name || a.name; saveApps();
  if (!result.changed.length && !result.removed.length) return res.json({ updated: false, message: "Already up to date" });
  if (was) { stopApp(a.slug); setTimeout(() => { try { startApp(a); } catch {} }, 700); }
  res.json({ updated: true, ...result, restarted: was });
}));

app.post("/api/apps/:slug/:action", wrap(async (req, res) => {
  const a = apps.find((x) => x.slug === req.params.slug);
  if (!a) return res.status(404).json({ error: "Not installed" });
  const act = req.params.action;
  if (act === "start") startApp(a);
  else if (act === "stop") stopApp(a.slug);
  else if (act === "restart") { stopApp(a.slug); await new Promise((r) => setTimeout(r, 700)); startApp(a); }
  else if (act === "autostart") { a.autostart = !a.autostart; saveApps(); }
  else return res.status(400).json({ error: "Unknown action" });
  res.json({ ok: true, running: isRunning(a.slug), autostart: a.autostart });
}));

app.get("/api/apps/:slug/log", (req, res) => {
  const rec = procs.get(req.params.slug);
  res.json({ log: rec ? rec.log.slice(-120) : [], running: isRunning(req.params.slug) });
});

app.delete("/api/apps/:slug", wrap(async (req, res) => {
  const a = apps.find((x) => x.slug === req.params.slug);
  if (!a) return res.status(404).json({ error: "Not installed" });
  stopApp(a.slug);
  await new Promise((r) => setTimeout(r, 400));
  if (req.query.files === "true") fs.rmSync(path.join(APPS_DIR, a.slug), { recursive: true, force: true });
  apps = apps.filter((x) => x.slug !== a.slug); saveApps();
  res.json({ ok: true });
}));

// Server Hub updating itself, from its own Pages site
app.post("/api/self", wrap(async (req, res) => {
  const url = String(req.body.selfUrl ?? cfg.selfUrl ?? "").trim().replace(/\/+$/, "");
  if (req.body.selfUrl !== undefined) {
    if (url && !/^https?:\/\//.test(url)) return res.status(400).json({ error: "The address must start with https://" });
    cfg.selfUrl = url; writeJson(CFG_FILE, cfg);
    if (!req.body.update) return res.json(cfg);
  }
  if (!cfg.selfUrl) throw new Error("Add Server Hub's own address first.");
  const m = await readManifest(cfg.selfUrl);
  const changed = [];
  for (const rel of m.files) {
    const text = await getText(`${m.base}/${rel}`);
    const dest = path.join(ROOT, rel);
    let cur = "";
    try { cur = fs.readFileSync(dest, "utf8"); } catch {}
    if (cur.trim() === text.trim()) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (cur) { const bak = path.join(ROOT, "backup", rel); fs.mkdirSync(path.dirname(bak), { recursive: true }); fs.writeFileSync(bak, cur); }
    fs.writeFileSync(dest, text);
    changed.push(rel);
  }
  if (!changed.length) return res.json({ updated: false, message: "Server Hub is already up to date" });
  res.json({ updated: true, files: changed, restarting: true });
  console.log("\n  Server Hub updated:", changed.join(", "), "- restarting\n");
  for (const a of apps) stopApp(a.slug);
  setTimeout(() => process.exit(7), 600); // start.bat relaunches on exit code 7
}));

// ---------- start ----------
app.listen(PORT, "0.0.0.0", () => {
  console.log("\n  Server Hub is running");
  console.log(`  On this PC:    http://localhost:${PORT}`);
  console.log(`  On your phone: http://${lanIp()}:${PORT}`);
  console.log("\n  Keep this window open. Your apps run inside it.\n");
  for (const a of apps.filter((x) => x.autostart)) { try { startApp(a); } catch (e) { console.log(`  ${a.name}: ${e.message}`); } }
});

const bye = () => { for (const a of apps) stopApp(a.slug); process.exit(0); };
process.on("SIGINT", bye);
process.on("SIGTERM", bye);
