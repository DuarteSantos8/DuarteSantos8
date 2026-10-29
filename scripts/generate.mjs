#!/usr/bin/env node
// Regenerates every SVG in ../assets for the DuarteSantos8 profile README.
//
//   node scripts/generate.mjs            fetch live numbers, write assets/*.svg + assets/data.json
//   node scripts/generate.mjs --offline  reuse assets/data.json, only re-render
//
// Sources (all read-only):
//   GitHub      via the `gh` CLI (already logged in on the box), public data only
//   Discord     public invite endpoint (member + online count)
//   Uptime Kuma Socket.IO login with the credentials in $KUMA_ENV (default /etc/kuma-api.env).
//               Needs `socket.io-client` resolvable, e.g. NODE_PATH=/root/homelab/hq/node_modules.
//   Host        /proc on the machine this runs on (uptime, RAM)
//
// Nothing secret ever ends up in the output: only public hostnames from PUBLIC_APPS are drawn,
// and Kuma URL/user/password are never logged. If a source fails, the last good value from
// assets/data.json is kept, so a flaky night never paints the whole rack red.
//
// No npm dependencies. Node >= 20.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ASSETS = path.join(ROOT, 'assets');
const FONTS = path.join(HERE, 'fonts');
const DATA_FILE = path.join(ASSETS, 'data.json');
const OFFLINE = process.argv.includes('--offline');

const USER = 'DuarteSantos8';
const GYM_REPO = 'DuarteSantos8/openGym';
const DISCORD_INVITE = 'e62jY6fwVb';

// Only these hostnames may appear in the rack. Matched against the Kuma monitor's
// URL host (and path for the API keyword check). Anything VPN-only stays out.
const PUBLIC_APPS = [
  { label: 'portfolio', host: 'duarte-santos.ch', name: /portfolio/i },
  { label: 'gym app', host: 'gym.duarte-santos.ch', name: /frontend/i },
  { label: 'gym api', host: 'gym.duarte-santos.ch', name: /api/i },
  { label: 'opengym.ch', host: 'opengym.ch' },
  { label: 'gym staging', host: 'gym-test.duarte-santos.ch', name: /staging/i },
  { label: 'mathe game', host: 'mathe.duarte-santos.ch' },
];
// Infrastructure units: shown with a generic label only, never a name/IP from Kuma.
const INFRA = { vm: /^docker vm$/i, pi: /^pi infra$/i, pve: /^proxmox ui$/i };

const log = (...a) => console.log('[profile]', ...a);

// ---------------------------------------------------------------- data

function gh(pathAndQuery, jq, paginate = false) {
  const args = ['api', pathAndQuery];
  if (paginate) args.push('--paginate');
  if (jq) args.push('--jq', jq);
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 }).trim();
}
const ghCount = (q) => Number(gh(`search/issues?per_page=1&q=${encodeURIComponent(q)}`, '.total_count'));

function sumLines(s) { return s.split('\n').filter(Boolean).reduce((a, b) => a + Number(b), 0); }

async function fetchOpenGym() {
  const repo = JSON.parse(gh(`repos/${GYM_REPO}`, '{stars:.stargazers_count,forks:.forks_count}'));
  const contributors = sumLines(gh(`repos/${GYM_REPO}/contributors?anon=1&per_page=100`, 'length', true));
  const apk = sumLines(gh(`repos/${GYM_REPO}/releases?per_page=100`,
    '[.[].assets[] | select(.name|endswith(".apk")) | .download_count] | add // 0', true));
  const release = gh(`repos/${GYM_REPO}/releases/latest`, '.tag_name');
  return { ...repo, contributors, apk, release };
}

async function fetchDiscord() {
  const r = await fetch(`https://discord.com/api/invites/${DISCORD_INVITE}?with_counts=true`,
    { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`discord ${r.status}`);
  const j = await r.json();
  return { members: j.approximate_member_count, online: j.approximate_presence_count };
}

async function fetchWeek() {
  const since = new Date(Date.now() - 7 * 864e5);
  const d = since.toISOString().slice(0, 10);
  const commits = Number(gh(`search/commits?per_page=1&q=${encodeURIComponent(`author:${USER} author-date:>=${d}`)}`, '.total_count'));
  return {
    from: d,
    to: new Date().toISOString().slice(0, 10),
    commits,
    prsShipped: ghCount(`is:pr author:${USER} is:merged merged:>=${d}`),
    prsMergedForOthers: ghCount(`is:pr user:${USER} is:merged merged:>=${d} -author:${USER}`),
    prsReviewed: ghCount(`is:pr reviewed-by:${USER} -author:${USER} updated:>=${d}`),
    issuesClosed: ghCount(`is:issue user:${USER} is:closed closed:>=${d}`),
    threadsCommented: ghCount(`commenter:${USER} updated:>=${d}`),
  };
}

function readEnvFile(p) {
  const out = {};
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#') || !s.includes('=')) continue;
    const i = s.indexOf('=');
    out[s.slice(0, i)] = s.slice(i + 1).replace(/^["']|["']$/g, '');
  }
  return out;
}

async function fetchKuma() {
  const env = readEnvFile(process.env.KUMA_ENV || '/etc/kuma-api.env');
  if (!env.KUMA_URL || !env.KUMA_USER) throw new Error('kuma env incomplete');
  const { io } = require('socket.io-client');
  const st = { monitors: {}, hb: {}, up: {} };
  await new Promise((resolve, reject) => {
    const s = io(env.KUMA_URL, { transports: ['websocket'], reconnection: false, timeout: 10000 });
    const fail = (msg) => { clearTimeout(hard); s.close(); reject(new Error(msg)); };
    const hard = setTimeout(() => fail('kuma timeout'), 20000);
    s.on('connect_error', () => fail('kuma unreachable'));
    s.on('connect', () => {
      s.emit('login', { username: env.KUMA_USER, password: env.KUMA_PASSWORD, token: '' }, (res) => {
        if (!res || !res.ok) return fail('kuma login rejected');
        // Kuma pushes monitorList, heartbeatList and uptime right after login.
        setTimeout(() => { clearTimeout(hard); s.close(); resolve(); }, 6000);
      });
    });
    s.on('monitorList', (l) => { st.monitors = l || {}; });
    s.on('heartbeatList', (id, l) => { st.hb[id] = l || []; });
    s.on('uptime', (id, period, v) => { (st.up[id] ||= {})[period] = v; });
  });

  const STATUS = { 0: 'down', 1: 'up', 2: 'pending', 3: 'maintenance' };
  const list = Object.values(st.monitors).filter((m) => m.active).map((m) => {
    const hbs = st.hb[m.id] || [];
    const last = hbs[hbs.length - 1];
    let host = null, p = '';
    try { const u = new URL(m.url); host = u.hostname; p = u.pathname; } catch {}
    return { name: m.name, type: m.type, host, path: p, status: last ? STATUS[last.status] || 'unknown' : 'unknown',
             up24: st.up[m.id]?.[24] ?? null };
  });
  if (!list.length) throw new Error('kuma returned no monitors');

  const apps = PUBLIC_APPS.map((a) => {
    const m = list.find((x) => x.host === a.host && (!a.name || a.name.test(x.name)));
    return { label: a.label, status: m ? m.status : 'unknown' };
  });
  const infra = {};
  for (const [k, re] of Object.entries(INFRA)) infra[k] = list.find((x) => re.test(x.name))?.status || 'unknown';
  // Push monitors (cron heartbeats) are bookkeeping, not services; leave them out of the count.
  const services = list.filter((x) => x.type !== 'push');
  const withUp = services.filter((x) => x.up24 != null);
  return {
    apps, infra,
    total: services.length,
    green: services.filter((x) => x.status === 'up' || x.status === 'maintenance').length,
    uptime24: withUp.length ? withUp.reduce((s, x) => s + x.up24, 0) / withUp.length : null,
  };
}

function fetchHost() {
  const secs = Number(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
  const memKb = Number(/MemTotal:\s+(\d+)/.exec(fs.readFileSync('/proc/meminfo', 'utf8'))[1]);
  const load = fs.readFileSync('/proc/loadavg', 'utf8').split(' ')[0];
  return { uptimeSecs: Math.round(secs), ramGb: Math.ceil(memKb / 1024 / 1024), load: Number(load) };
}

async function collect() {
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch {}
  if (OFFLINE) { log('offline: re-rendering from data.json'); return prev; }
  const data = { ...prev, generatedAt: new Date().toISOString() };
  const steps = { gym: fetchOpenGym, discord: fetchDiscord, week: fetchWeek, kuma: fetchKuma, host: fetchHost };
  for (const [key, fn] of Object.entries(steps)) {
    try { data[key] = await fn(); log(`${key}: ok`); }
    catch (e) { log(`${key}: FAILED (${e.message.split('\n')[0]}), keeping last value`); }
  }
  return data;
}

// ---------------------------------------------------------------- helpers

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fontCache = {};
function fontFace(family, file, weight) {
  fontCache[file] ||= fs.readFileSync(path.join(FONTS, file)).toString('base64');
  return `@font-face{font-family:'${family}';font-weight:${weight};font-style:normal;font-display:swap;src:url(data:font/woff2;base64,${fontCache[file]}) format('woff2');}`;
}
const INTER = `'P Inter',Inter,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`;
const MONO = `'P Mono','JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace`;
function fonts(list) {
  const map = { i400: ['P Inter', 'inter-400.woff2', 400], i600: ['P Inter', 'inter-600.woff2', 600],
    i700: ['P Inter', 'inter-700.woff2', 700], i800: ['P Inter', 'inter-800.woff2', 800],
    m400: ['P Mono', 'jbmono-400.woff2', 400], m500: ['P Mono', 'jbmono-500.woff2', 500],
    m700: ['P Mono', 'jbmono-700.woff2', 700] };
  return list.map((k) => fontFace(...map[k])).join('');
}
function compact(n) {
  if (n == null || Number.isNaN(n)) return '–';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e4) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return n.toLocaleString('en-US');
}
function fmtUptime(secs) {
  if (!secs) return 'a while';
  const d = Math.floor(secs / 86400), h = Math.floor((secs % 86400) / 3600), m = Math.floor((secs % 3600) / 60);
  return d ? `${d} day${d === 1 ? '' : 's'}, ${h}:${String(m).padStart(2, '0')}` : `${h}:${String(m).padStart(2, '0')}`;
}
const fmtDate = (iso) => (iso || new Date().toISOString()).slice(0, 10);
function svgOpen(w, h, label, extraCss = '') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}"><title>${esc(label)}</title><style>${extraCss}</style>`;
}
function write(name, svg) {
  fs.writeFileSync(path.join(ASSETS, name), svg);
  const kb = Buffer.byteLength(svg) / 1024;
  log(`${name.padEnd(28)} ${kb.toFixed(0).padStart(4)} KB${kb > 200 ? '  <-- over budget' : ''}`);
}

const THEMES = {
  dark: {
    page: '#0d1117', surface: '#151b23', surface2: '#0f141b', border: '#30363d', text: '#e6edf3', muted: '#9198a1',
    faint: '#3d444d', accent: '#a3e635', accentText: '#a3e635', blue: '#79c0ff', violet: '#d2a8ff', orange: '#ffa657',
    red: '#f85149', green: '#3fb950', termBg: '#0b0f14', termBar: '#161b22',
  },
  light: {
    page: '#ffffff', surface: '#f6f8fa', surface2: '#ffffff', border: '#d1d9e0', text: '#1f2328', muted: '#59636e',
    faint: '#d1d9e0', accent: '#65a30d', accentText: '#3f6212', blue: '#0550ae', violet: '#8250df', orange: '#bc4c00',
    red: '#cf222e', green: '#1a7f37', termBg: '#fbfcfd', termBar: '#eef1f4',
  },
};

// Discrete SMIL animation that loops with the whole timeline (period T seconds).
function discrete(attr, frames, T, extra = '') {
  // frames: [[time, value], ...] starting at t=0
  const kt = frames.map(([t]) => Math.min(t / T, 1).toFixed(5)).join(';');
  const vals = frames.map(([, v]) => v).join(';');
  return `<animate attributeName="${attr}" dur="${T}s" repeatCount="indefinite" calcMode="discrete" keyTimes="${kt}" values="${vals}" ${extra}/>`;
}

// ---------------------------------------------------------------- 1. terminal header

function terminal(data, th) {
  const W = 1000, FS = 16, CW = FS * 0.6, LH = 27, X0 = 28, Y0 = 82;
  const prompt = [['duarte', th.green], ['@', th.muted], ['homelab', th.blue], [':', th.muted], ['~', th.violet], ['$ ', th.muted]];
  const PL = prompt.reduce((n, [s]) => n + s.length, 0);
  const k = data.kuma || {}, h = data.host || {};
  const upBits = [`up ${fmtUptime(h.uptimeSecs)}`];
  if (k.total) upBits.push(`${k.green}/${k.total} checks green`);
  if (k.uptime24 != null) upBits.push(`${(k.uptime24 * 100).toFixed(1)}% last 24h`);
  if (h.ramGb) upBits.push(`${h.ramGb} GB RAM`);
  upBits.push('1 smart plug on standby');
  const script = [
    { cmd: 'whoami', out: [[['Duarte Santos', th.text, 700], [', app dev apprentice @ Sunrise, Switzerland', th.text]]] },
    { cmd: 'ls projects/', out: [[['openGym/', th.accentText, 700], ['  AgentDeck/', th.blue, 700], ['  attitude/', th.blue, 700], ['  homelab/', th.blue, 700], ['  client-work/', th.blue, 700]]] },
    { cmd: 'uptime', out: [[[' ' + upBits.join(', '), th.muted]]] },
    { cmd: 'cat motto.txt', out: [[['Ship it, host it myself, fix it on the train to school.', th.orange]]] },
    { cmd: null },
  ];
  const rows = script.reduce((n, s) => n + 1 + (s.out ? s.out.length : 0), 0);
  const H = Y0 + rows * LH + 6;
  const T = 26; // seconds per loop
  let t = 0.8, row = 0, body = '', cursorX = [[0, X0 + PL * CW]], cursorY = [[0, Y0 - FS + 3]];
  const lineY = (r) => Y0 + r * LH;
  const spans = (segs) => segs.map(([s, c, w]) => `<tspan fill="${c}"${w ? ` font-weight="${w}"` : ''}>${esc(s)}</tspan>`).join('');

  script.forEach((step, si) => {
    const y = lineY(row);
    const appear = si === 0 ? 0 : t;
    // prompt line
    body += `<g opacity="1">${si ? discrete('opacity', [[0, 0], [appear, 1]], T) : ''}<text x="${X0}" y="${y}" xml:space="preserve">${spans(prompt)}</text>`;
    cursorX.push([appear, X0 + PL * CW]); cursorY.push([appear, y - FS + 3]);
    if (step.cmd) {
      const n = step.cmd.length, start = appear + 0.45, dt = 0.085;
      const id = `c${si}`;
      const frames = [[0, 0]];
      for (let i = 1; i <= n; i++) frames.push([start + i * dt, (i * CW).toFixed(1)]);
      body += `<clipPath id="${id}"><rect x="${X0 + PL * CW}" y="${y - FS - 4}" height="${LH}" width="${(n * CW).toFixed(1)}">${discrete('width', frames, T)}</rect></clipPath>`;
      body += `<text x="${X0 + PL * CW}" y="${y}" fill="${th.text}" clip-path="url(#${id})" xml:space="preserve">${esc(step.cmd)}</text>`;
      for (let i = 1; i <= n; i++) cursorX.push([start + i * dt, X0 + (PL + i) * CW]);
      t = start + n * dt + 0.45;
    }
    body += '</g>';
    row++;
    for (const out of step.out || []) {
      body += `<text x="${X0}" y="${lineY(row)}" xml:space="preserve" opacity="1">${discrete('opacity', [[0, 0], [t, 1]], T)}${spans(out)}</text>`;
      row++;
      t += 0.12;
    }
    t += 0.9;
  });
  if (t > T - 6) throw new Error(`terminal timeline too long (${t.toFixed(1)}s)`);
  // Cursor: discrete x/y track through the whole loop, blinking on its own.
  const sortByT = (a) => a.sort((p, q) => p[0] - q[0]);
  const lastY = cursorY[cursorY.length - 1][1];
  const lastX = cursorX[cursorX.length - 1][1];
  body += `<rect x="${lastX}" y="${lastY}" width="${CW}" height="${FS + 3}" fill="${th.accent}">` +
    discrete('x', sortByT(cursorX), T) + discrete('y', sortByT(cursorY), T) +
    `<animate attributeName="opacity" values="1;1;0;0" keyTimes="0;0.5;0.5;1" dur="1.1s" repeatCount="indefinite"/></rect>`;

  const css = fonts(['m400', 'm700']) + `text{font-family:${MONO};font-size:${FS}px;}`;
  let s = svgOpen(W, H, 'Terminal: whoami, Duarte Santos, app dev apprentice at Sunrise, Switzerland', css);
  s += `<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="14" fill="${th.termBg}" stroke="${th.border}"/>`;
  s += `<path d="M0.5 44V14.5A14 14 0 0 1 14.5 0.5H${W - 14.5}A14 14 0 0 1 ${W - 0.5} 14.5V44Z" fill="${th.termBar}" stroke="${th.border}"/>`;
  s += ['#ff5f57', '#febc2e', '#28c840'].map((c, i) => `<circle cx="${26 + i * 20}" cy="22" r="6" fill="${c}"/>`).join('');
  s += `<text x="${W / 2}" y="27" text-anchor="middle" fill="${th.muted}" style="font-size:13px">duarte@homelab: ~ (bash)</text>`;
  s += `<text x="${W - 24}" y="27" text-anchor="end" fill="${th.faint}" style="font-size:12px">${fmtDate(data.generatedAt)}</text>`;
  s += body + '</svg>';
  return s;
}

// ---------------------------------------------------------------- 2. openGym card

function dumbbell(x, y, scale, fill) {
  return `<g transform="translate(${x},${y}) scale(${scale})" fill="${fill}"><rect x="-72" y="-10" width="144" height="20" rx="7"/><rect x="-80" y="-36" width="20" height="72" rx="7"/><rect x="-104" y="-25" width="17" height="50" rx="7"/><rect x="60" y="-36" width="20" height="72" rx="7"/><rect x="87" y="-25" width="17" height="50" rx="7"/></g>`;
}

function gymCard(data, mode) {
  const dark = mode === 'dark';
  const c = dark
    ? { bg1: '#12151b', bg2: '#0c0e12', border: '#2b3140', text: '#eef1f6', muted: '#8b94a7', faint: '#5c6475', lime: '#a3e635', limeText: '#a3e635', cell: '#151a22', cellBorder: '#232a36' }
    : { bg1: '#fbfdf6', bg2: '#f3f7ea', border: '#d9e2c6', text: '#12151b', muted: '#4b5563', faint: '#6b7280', lime: '#65a30d', limeText: '#3f6212', cell: '#ffffff', cellBorder: '#dfe7cf' };
  const g = data.gym || {}, d = data.discord || {};
  const W = 1000, H = 312;
  const cells = [
    { big: compact(g.stars), label: 'GITHUB STARS' },
    { big: compact(g.contributors), label: 'CONTRIBUTORS' },
    { big: compact(g.apk), label: 'APK DOWNLOADS' },
    { big: compact(d.members), label: 'ON DISCORD', live: d.online ? `${compact(d.online)} online` : null },
    { big: g.release || '–', label: 'LATEST RELEASE' },
    { big: 'iOS + Watch', label: 'APP STORE', small: 'every country', smallBig: true },
  ];
  const css = fonts(['i600', 'i800', 'm500']) + `.i{font-family:${INTER}}.m{font-family:${MONO}}`;
  let s = svgOpen(W, H, `openGym: ${compact(g.stars)} stars, ${compact(g.contributors)} contributors, ${compact(g.apk)} APK downloads, ${compact(d.members)} on Discord, release ${g.release}`, css);
  s += `<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c.bg1}"/><stop offset="1" stop-color="${c.bg2}"/></linearGradient>
  <radialGradient id="glow" cx="0.12" cy="0.2" r="0.5"><stop offset="0" stop-color="${c.lime}" stop-opacity="${dark ? 0.13 : 0.12}"/><stop offset="1" stop-color="${c.lime}" stop-opacity="0"/></radialGradient></defs>`;
  s += `<rect width="${W}" height="${H}" rx="22" fill="url(#bg)"/><rect width="${W}" height="${H}" rx="22" fill="url(#glow)"/>`;
  s += `<rect x="1.5" y="1.5" width="${W - 3}" height="${H - 3}" rx="20.5" fill="none" stroke="${c.border}" stroke-width="3"/>`;
  s += dumbbell(104, 92, 0.52, c.lime);
  s += `<text class="i" x="176" y="104" font-size="52" font-weight="800" letter-spacing="-2"><tspan fill="${c.text}">open</tspan><tspan fill="${c.limeText}">Gym</tspan></text>`;
  s += `<text class="i" x="178" y="134" font-size="17" font-weight="600" fill="${c.muted}">Open-source gym &amp; bodyweight tracker for your phone, your wrist and your own server</text>`;
  // live pill, top right
  s += `<g transform="translate(${W - 176},40)"><rect width="140" height="30" rx="15" fill="none" stroke="${c.lime}" stroke-opacity="0.6"/>
    <circle cx="20" cy="15" r="4.5" fill="${c.lime}"><animate attributeName="opacity" values="1;0.25;1" dur="2.4s" repeatCount="indefinite"/></circle>
    <text class="m" x="34" y="20" font-size="12.5" font-weight="500" fill="${c.limeText}">LIVE NUMBERS</text></g>`;
  const cw = 148, gap = 10, x0 = (W - (cw * 6 + gap * 5)) / 2, y0 = 166, chH = 98;
  cells.forEach((cell, i) => {
    const x = x0 + i * (cw + gap);
    s += `<rect x="${x}" y="${y0}" width="${cw}" height="${chH}" rx="14" fill="${c.cell}" stroke="${c.cellBorder}"/>`;
    const fs2 = cell.big.length > 7 ? 21 : 30;
    s += `<text class="i" x="${x + 16}" y="${y0 + 44}" font-size="${fs2}" font-weight="800" fill="${c.text}" letter-spacing="-0.5">${esc(cell.big)}</text>`;
    s += `<text class="m" x="${x + 16}" y="${y0 + 68}" font-size="11" font-weight="500" fill="${c.muted}" letter-spacing="0.6">${esc(cell.label)}</text>`;
    const sub = cell.live || cell.small;
    if (sub) {
      if (cell.live) s += `<circle cx="${x + 20}" cy="${y0 + 83}" r="3.5" fill="${c.lime}"><animate attributeName="opacity" values="1;0.3;1" dur="1.8s" repeatCount="indefinite"/></circle>`;
      s += `<text class="m" x="${x + (cell.live ? 30 : 16)}" y="${y0 + 87}" font-size="11" font-weight="500" fill="${c.limeText}">${esc(sub)}</text>`;
    }
  });
  s += `<text class="m" x="${x0}" y="${H - 22}" font-size="11.5" fill="${c.faint}">fetched ${fmtDate(data.generatedAt)} from GitHub + Discord  ·  AGPL-3.0  ·  no subscription, no ads</text>`;
  s += `<text class="m" x="${W - x0}" y="${H - 22}" text-anchor="end" font-size="11.5" font-weight="500" fill="${c.limeText}">opengym.ch  →</text>`;
  return s + '</svg>';
}

// ---------------------------------------------------------------- 3. homelab rack

function rack(data, th) {
  const k = data.kuma || {}, h = data.host || {};
  const W = 1000, RX = 60, RW = W - 2 * RX, U = 42, top = 84;
  const units = [2, 1, 2, 1, 1];
  const H = top + units.reduce((a, b) => a + b, 0) * U + 22 + 56;
  const ledColor = (st) => st === 'up' || st === 'maintenance' ? th.green : st === 'down' ? th.red : th.orange;
  const css = fonts(['m400', 'm700', 'i700']) + `.m{font-family:${MONO}}.i{font-family:${INTER}}`;
  const metal = th === THEMES.dark ? { frame: '#1b2129', unit: '#202832', unit2: '#262f3b', edge: '#36404d', screw: '#0d1117', label: '#c9d1d9', bay: '#151b23' }
    : { frame: '#d6dbe1', unit: '#eef1f4', unit2: '#e4e8ed', edge: '#c3cad3', screw: '#9aa4b1', label: '#24292f', bay: '#d9dee5' };
  let s = svgOpen(W, H, `Homelab rack: ${k.green ?? '?'} of ${k.total ?? '?'} monitored services up`, css);
  // heading
  s += `<text class="i" x="${RX}" y="40" font-size="22" font-weight="700" fill="${th.text}">The homelab, right now</text>`;
  const sum = k.total ? `${k.green}/${k.total} checks green` + (k.uptime24 != null ? `  ·  ${(k.uptime24 * 100).toFixed(1)}% uptime (24h)` : '') : 'status unavailable';
  s += `<text class="m" x="${RX}" y="64" font-size="13" fill="${th.muted}">${esc(sum)}  ·  watched by Uptime Kuma  ·  ${fmtDate(data.generatedAt)}</text>`;
  // frame
  const RH = units.reduce((a, b) => a + b, 0) * U;
  s += `<rect x="${RX - 26}" y="${top - 12}" width="${RW + 52}" height="${RH + 24}" rx="10" fill="${metal.frame}" stroke="${metal.edge}"/>`;
  for (let i = 0; i < units.reduce((a, b) => a + b, 0); i++) {
    for (const sx of [RX - 13, RX + RW + 13]) {
      s += `<rect x="${sx - 3.5}" y="${top + i * U + U / 2 - 3.5}" width="7" height="7" rx="1.5" fill="${metal.screw}"/>`;
    }
  }
  let y = top, seed = 7;
  const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  const panel = (hU) => `<rect x="${RX}" y="${y + 2}" width="${RW}" height="${hU * U - 4}" rx="5" fill="${metal.unit}" stroke="${metal.edge}"/>`;
  const label = (x, yy, t, sz = 12, w = 700, fill = metal.label) => `<text class="m" x="${x}" y="${yy}" font-size="${sz}" font-weight="${w}" fill="${fill}" letter-spacing="0.5">${esc(t)}</text>`;
  const led = (cx, cy, st, r = 4.5) => {
    const col = ledColor(st), dur = st === 'down' ? 0.7 : 2.2 + rnd() * 2.4;
    return `<circle cx="${cx}" cy="${cy}" r="${r + 4}" fill="${col}" opacity="0.18"/><circle cx="${cx}" cy="${cy}" r="${r}" fill="${col}"><animate attributeName="opacity" values="1;${st === 'down' ? 0.15 : 0.55};1" dur="${dur.toFixed(2)}s" repeatCount="indefinite"/></circle>`;
  };
  // U1-2: proxmox host
  s += panel(2);
  s += led(RX + 24, y + 24, k.infra?.pve || 'up');
  s += label(RX + 42, y + 29, 'PROXMOX HOST');
  s += label(RX + 42, y + 50, `up ${fmtUptime(h.uptimeSecs)}  ·  ${h.ramGb || 32} GB RAM  ·  load ${h.load ?? '–'}`, 11.5, 400, th.muted);
  s += label(RX + 42, y + 68, 'hard resets survived: plenty', 11.5, 400, th.muted);
  for (let i = 0; i < 8; i++) {
    const bx = RX + 470 + i * 50;
    s += `<rect x="${bx}" y="${y + 12}" width="42" height="60" rx="4" fill="${metal.bay}" stroke="${metal.edge}"/>`;
    for (let j = 0; j < 5; j++) s += `<rect x="${bx + 8}" y="${y + 22 + j * 7}" width="26" height="2" rx="1" fill="${metal.edge}"/>`;
    s += `<circle cx="${bx + 21}" cy="${y + 63}" r="2.6" fill="${th.blue}"><animate attributeName="opacity" values="0.2;1;0.2;0.2;1;0.2" dur="${(0.9 + rnd() * 2.2).toFixed(2)}s" begin="${(rnd() * 2).toFixed(2)}s" repeatCount="indefinite"/></circle>`;
  }
  y += 2 * U;
  // U3: docker vm
  s += panel(1);
  s += led(RX + 24, y + U / 2, k.infra?.vm || 'up');
  s += label(RX + 42, y + U / 2 + 4, 'DOCKER VM');
  s += label(RX + 170, y + U / 2 + 4, 'traefik  ·  cloudflare tunnel  ·  ~20 apps  ·  passkeys everywhere', 11.5, 400, th.muted);
  y += U;
  // U4-5: public apps patch panel
  s += panel(2);
  s += label(RX + 18, y + 22, 'PUBLIC APPS', 11, 700, th.muted);
  const apps = k.apps || PUBLIC_APPS.map((a) => ({ label: a.label, status: 'unknown' }));
  const pw = (RW - 36) / apps.length;
  apps.forEach((a, i) => {
    const px = RX + 18 + i * pw;
    s += `<rect x="${px + 6}" y="${y + 33}" width="26" height="20" rx="3" fill="${metal.screw}" stroke="${metal.edge}"/><rect x="${px + 13}" y="${y + 47}" width="12" height="6" fill="${metal.unit2}"/>`;
    s += led(px + 46, y + 43, a.status, 4);
    s += label(px + 6, y + 74, PUBLIC_APPS[i] ? PUBLIC_APPS[i].label : a.label, 12.5, 400, metal.label);
  });
  y += 2 * U;
  // U6: pi
  s += panel(1);
  s += led(RX + 24, y + U / 2, k.infra?.pi || 'up');
  s += label(RX + 42, y + U / 2 + 4, 'RASPBERRY PI');
  s += label(RX + 170, y + U / 2 + 4, 'uptime kuma  ·  pi-hole  ·  vpn  ·  keeps an eye on the big box', 11.5, 400, th.muted);
  y += U;
  // U7: smart plug
  s += panel(1);
  s += `<circle cx="${RX + 24}" cy="${y + U / 2}" r="4.5" fill="${th.orange}"/>`;
  s += label(RX + 42, y + U / 2 + 4, 'SMART PLUG');
  s += label(RX + 170, y + U / 2 + 4, 'if the server stops answering, it gets turned off and on again', 11.5, 400, th.muted);
  y += U;
  // legend
  const ly = H - 26;
  s += `<circle cx="${RX + 4}" cy="${ly - 4}" r="4.5" fill="${th.green}"/>${label(RX + 16, ly, 'up', 11.5, 400, th.muted)}`;
  s += `<circle cx="${RX + 64}" cy="${ly - 4}" r="4.5" fill="${th.red}"/>${label(RX + 76, ly, 'down', 11.5, 400, th.muted)}`;
  s += `<circle cx="${RX + 136}" cy="${ly - 4}" r="4.5" fill="${th.orange}"/>${label(RX + 148, ly, 'no data', 11.5, 400, th.muted)}`;
  s += `<text class="m" x="${RX + RW}" y="${ly}" text-anchor="end" font-size="11.5" fill="${th.muted}">only public apps shown, the rest lives behind the VPN</text>`;
  return s + '</svg>';
}

// ---------------------------------------------------------------- 4. project tiles

const TILES = [
  {
    id: 'agentdeck', title: 'AgentDeck', sub: 'github.com/DuarteSantos8/agentdeck',
    desc: 'Browser terminal deck for long-running Claude Code and shell agents. Every session is tmux, so it survives closed tabs, dropped VPNs and restarts.',
    chips: ['node', 'xterm.js', 'tmux'],
    art: (th, X, Y) => {
      let a = '';
      for (let i = 2; i >= 0; i--) {
        const x = X + i * 14, y = Y + i * 14;
        a += `<rect x="${x}" y="${y}" width="150" height="104" rx="9" fill="${th.termBg}" stroke="${th.border}"/>`;
        a += `<rect x="${x}" y="${y}" width="150" height="20" rx="9" fill="${th.termBar}"/><rect x="${x}" y="${y + 12}" width="150" height="8" fill="${th.termBar}"/>`;
        a += [0, 1, 2].map((j) => `<circle cx="${x + 12 + j * 10}" cy="${y + 10}" r="3" fill="${['#ff5f57', '#febc2e', '#28c840'][j]}"/>`).join('');
        if (i === 0) {
          a += `<text class="m" x="${x + 10}" y="${y + 40}" font-size="10" fill="${th.green}">$ claude</text>`;
          a += `<text class="m" x="${x + 10}" y="${y + 56}" font-size="10" fill="${th.muted}">thinking...</text>`;
          a += `<rect x="${x + 72}" y="${y + 48}" width="6" height="10" fill="${th.accent}"><animate attributeName="opacity" values="1;1;0;0" keyTimes="0;0.5;0.5;1" dur="1.1s" repeatCount="indefinite"/></rect>`;
          a += `<rect x="${x}" y="${y + 88}" width="150" height="16" fill="${th.green}" opacity="0.85"/><text class="m" x="${x + 6}" y="${y + 99}" font-size="9" fill="${th.page}">[agents] 0:claude* 1:build</text>`;
        }
      }
      return a;
    },
  },
  {
    id: 'attitude', title: 'attitude', sub: 'duartesantos8.github.io/attitude',
    desc: 'Spatial orientation test for pilot candidates: read the aircraft\'s attitude, steer with WASD, try not to fly into the ground.',
    chips: ['canvas', 'vanilla js', 'game'],
    art: (th, X, Y) => {
      const cx = X + 90, cy = Y + 66, r = 60;
      return `<clipPath id="hz"><circle cx="${cx}" cy="${cy}" r="${r}"/></clipPath>
        <g clip-path="url(#hz)"><g><animateTransform attributeName="transform" type="rotate" values="-14 ${cx} ${cy};12 ${cx} ${cy};-14 ${cx} ${cy}" dur="9s" repeatCount="indefinite" calcMode="spline" keySplines="0.45 0 0.55 1;0.45 0 0.55 1"/>
        <g><animateTransform attributeName="transform" type="translate" values="0 -8;0 10;0 -8" dur="6.5s" repeatCount="indefinite" calcMode="spline" keySplines="0.45 0 0.55 1;0.45 0 0.55 1"/>
        <rect x="${cx - 120}" y="${cy - 120}" width="240" height="120" fill="#3b82f6"/><rect x="${cx - 120}" y="${cy}" width="240" height="120" fill="#a16207"/>
        <line x1="${cx - 120}" y1="${cy}" x2="${cx + 120}" y2="${cy}" stroke="#fff" stroke-width="2"/>
        ${[-30, -15, 15, 30].map((p) => `<line x1="${cx - (Math.abs(p) === 30 ? 22 : 12)}" y1="${cy + p}" x2="${cx + (Math.abs(p) === 30 ? 22 : 12)}" y2="${cy + p}" stroke="#fff" stroke-width="1.5" opacity="0.8"/>`).join('')}
        </g></g></g>
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${th.border}" stroke-width="5"/>
        <path d="M${cx - 38} ${cy} H${cx - 12} L${cx} ${cy + 10} L${cx + 12} ${cy} H${cx + 38}" fill="none" stroke="#f59e0b" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"/>
        <circle cx="${cx}" cy="${cy}" r="2.5" fill="#f59e0b"/>
        ${['W', 'A', 'S', 'D'].map((kk, i) => {
          const pos = [[0, -1], [-1, 0], [0, 0], [1, 0]][i];
          const kx = X + 178 + pos[0] * 24, ky = Y + 92 + pos[1] * 24;
          return `<rect x="${kx}" y="${ky}" width="21" height="21" rx="4" fill="${th.surface2}" stroke="${th.border}"/><text class="m" x="${kx + 10.5}" y="${ky + 15}" text-anchor="middle" font-size="11" font-weight="700" fill="${th.text}">${kk}</text>`;
        }).join('')}`;
    },
  },
  {
    id: 'homelab', title: 'Homelab', sub: 'one box, ~20 apps, zero open ports',
    desc: 'Proxmox box behind Cloudflare Tunnel: portfolio, openGym, school apps, monitoring, backups and a smart plug that reboots it when it hangs.',
    chips: ['proxmox', 'docker', 'traefik'],
    art: (th, X, Y) => {
      const p = `M${X + 40} ${Y + 40} C ${X + 90} ${Y + 40}, ${X + 80} ${Y + 104}, ${X + 140} ${Y + 104}`;
      const pRel = 'M0 0 C 50 0, 40 64, 100 64';
      return `<path d="M${X + 18} ${Y + 50} a16 16 0 0 1 8 -28 a22 22 0 0 1 40 -6 a16 16 0 0 1 22 18 a12 12 0 0 1 -6 16 z" fill="${th.surface2}" stroke="${th.border}" stroke-width="2"/>
        <text class="m" x="${X + 48}" y="${Y + 42}" text-anchor="middle" font-size="9" fill="${th.muted}">internet</text>
        <path d="${p}" fill="none" stroke="${th.faint}" stroke-width="2" stroke-dasharray="4 5"/>
        <g transform="translate(${X + 40},${Y + 40})"><circle r="4" fill="${th.accent}"><animateMotion dur="2.6s" repeatCount="indefinite" path="${pRel}"/></circle></g>
        <rect x="${X + 140}" y="${Y + 76}" width="74" height="56" rx="7" fill="${th.surface2}" stroke="${th.border}" stroke-width="2"/>
        <text class="m" x="${X + 177}" y="${Y + 98}" text-anchor="middle" font-size="10" font-weight="700" fill="${th.text}">pve</text>
        ${[0, 1, 2, 3, 4].map((i) => `<circle cx="${X + 152 + i * 12.5}" cy="${Y + 116}" r="3.2" fill="${th.green}"><animate attributeName="opacity" values="1;0.4;1" dur="${(1.6 + i * 0.37).toFixed(2)}s" repeatCount="indefinite"/></circle>`).join('')}
        <path d="M${X + 177} ${Y + 76} V ${Y + 30}" stroke="${th.faint}" stroke-width="2"/>
        <rect x="${X + 160}" y="${Y + 12}" width="34" height="20" rx="4" fill="${th.orange}" opacity="0.9"/>
        <text class="m" x="${X + 177}" y="${Y + 26}" text-anchor="middle" font-size="9" font-weight="700" fill="${th.page}">plug</text>`;
    },
  },
  {
    id: 'clients', title: 'Client work', sub: 'e.g. litho.ch',
    desc: 'Websites for Swiss small businesses: design, build, hosting and the legal bits nobody enjoys, so they don\'t have to.',
    chips: ['astro', 'tailwind', 'hosting'],
    art: (th, X, Y) => {
      let a = `<rect x="${X}" y="${Y + 8}" width="210" height="128" rx="9" fill="${th.surface2}" stroke="${th.border}"/>`;
      a += `<rect x="${X}" y="${Y + 8}" width="210" height="22" rx="9" fill="${th.termBar}"/><rect x="${X}" y="${Y + 22}" width="210" height="8" fill="${th.termBar}"/>`;
      a += `<rect x="${X + 40}" y="${Y + 13}" width="130" height="12" rx="6" fill="${th.surface2}" stroke="${th.border}"/><text class="m" x="${X + 105}" y="${Y + 22.5}" text-anchor="middle" font-size="8.5" fill="${th.muted}">litho.ch</text>`;
      a += `<rect x="${X + 14}" y="${Y + 42}" width="92" height="10" rx="3" fill="${th.text}" opacity="0.85"/>`;
      a += `<rect x="${X + 14}" y="${Y + 58}" width="120" height="5" rx="2.5" fill="${th.faint}"/><rect x="${X + 14}" y="${Y + 68}" width="100" height="5" rx="2.5" fill="${th.faint}"/>`;
      a += `<rect x="${X + 14}" y="${Y + 82}" width="52" height="15" rx="7.5" fill="${th.accent}"/>`;
      a += `<rect x="${X + 142}" y="${Y + 40}" width="56" height="58" rx="5" fill="${th.blue}" opacity="0.25"/>`;
      a += [0, 1, 2].map((i) => `<rect x="${X + 14 + i * 64}" y="${Y + 108}" width="56" height="20" rx="4" fill="${th.faint}" opacity="0.6"/>`).join('');
      return a;
    },
  },
];

function wrap(text, max) {
  const out = [];
  for (const w of text.split(' ')) {
    if (out.length && (out[out.length - 1] + ' ' + w).length <= max) out[out.length - 1] += ' ' + w;
    else out.push(w);
  }
  return out;
}

function tile(t, th) {
  const W = 490, H = 270;
  const css = fonts(['i400', 'i800', 'm400', 'm700']) + `.m{font-family:${MONO}}.i{font-family:${INTER}}`;
  let s = svgOpen(W, H, `${t.title}: ${t.desc}`, css);
  s += `<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="16" fill="${th.surface}" stroke="${th.border}"/>`;
  s += `<text class="i" x="26" y="50" font-size="26" font-weight="800" fill="${th.text}" letter-spacing="-0.6">${esc(t.title)}</text>`;
  s += `<text class="m" x="27" y="72" font-size="11.5" fill="${th.muted}">${esc(t.sub)}</text>`;
  wrap(t.desc, 30).forEach((l, i) => { s += `<text class="i" x="26" y="${106 + i * 21}" font-size="14" fill="${th.text}" opacity="0.92">${esc(l)}</text>`; });
  let cx = 26;
  for (const c of t.chips) {
    const w = c.length * 7.2 + 20;
    s += `<rect x="${cx}" y="${H - 44}" width="${w}" height="24" rx="12" fill="none" stroke="${th.border}"/><text class="m" x="${cx + w / 2}" y="${H - 28}" text-anchor="middle" font-size="12" fill="${th.muted}">${esc(c)}</text>`;
    cx += w + 8;
  }
  s += `<text class="m" x="${W - 24}" y="${H - 27}" text-anchor="end" font-size="13" font-weight="700" fill="${th.accentText}">open →</text>`;
  s += t.art(th, 262, 92);
  return s + '</svg>';
}

// ---------------------------------------------------------------- tech stack strip (package.json)

function stack(th) {
  const W = 1000, FS = 14, LH = 23;
  const deps = [['react', 'every day'], ['vite', 'fast enough'], ['node', '22'], ['capacitor', 'ios + android'], ['docker', 'yes'], ['linux', 'home'], ['nginx', 'front door'], ['cloudflare', 'tunnel, no open ports']];
  const dev = [['java', 'school'], ['spring-boot', 'work'], ['python', 'school'], ['vue', 'school'], ['sql', 'always'], ['claude-code', 'pair programmer']];
  const col = (x, y0, title, list) => {
    let o = `<text x="${x}" y="${y0}" xml:space="preserve"><tspan fill="${th.blue}">"${title}"</tspan><tspan fill="${th.muted}">: {</tspan></text>`;
    list.forEach(([k, v], i) => {
      o += `<text x="${x + 22}" y="${y0 + (i + 1) * LH}" xml:space="preserve"><tspan fill="${th.green}">"${esc(k)}"</tspan><tspan fill="${th.muted}">: </tspan><tspan fill="${th.orange}">"${esc(v)}"</tspan><tspan fill="${th.muted}">${i < list.length - 1 ? ',' : ''}</tspan></text>`;
    });
    o += `<text x="${x}" y="${y0 + (list.length + 1) * LH}" fill="${th.muted}">}</text>`;
    return o;
  };
  const H = 58 + (deps.length + 2) * LH + 24;
  const css = fonts(['m400']) + `text{font-family:${MONO};font-size:${FS}px}`;
  let s = svgOpen(W, H, 'Tech stack: React, Vite, Node.js, Capacitor, Docker, Linux, Nginx, Cloudflare; also Java/Spring Boot, Python, Vue, SQL', css);
  s += `<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="14" fill="${th.termBg}" stroke="${th.border}"/>`;
  s += `<text x="24" y="32" fill="${th.muted}" style="font-size:12px">~/duarte/package.json</text><line x1="0" y1="46" x2="${W}" y2="46" stroke="${th.border}"/>`;
  s += col(24, 76, 'dependencies', deps);
  s += col(530, 76, 'devDependencies', dev);
  return s + '</svg>';
}

// ---------------------------------------------------------------- 5. workout receipt

function setsReps(n) {
  if (!n) return '0 x 0';
  for (const r of [10, 8, 12, 6, 5, 9, 7, 11]) if (n % r === 0 && n / r >= 2) return `${n / r} x ${r}`;
  return n >= 10 ? `${Math.floor(n / 10)} x 10 +${n % 10}` : `1 x ${n}`;
}

function receipt(data, mode) {
  const w = data.week || {};
  const dark = mode === 'dark';
  const paper = dark ? '#e8e5da' : '#fffdf6', ink = '#25231f', inkSoft = '#6b675c', edge = dark ? '#0d1117' : '#ffffff';
  const W = 460, CH = 13.5 * 0.6, FS = 13.5, LH = 21, COLS = 46;
  const pad = (l, r) => l + ' '.repeat(Math.max(1, COLS - l.length - r.length)) + r;
  const center = (t) => ' '.repeat(Math.max(0, Math.floor((COLS - t.length) / 2))) + t;
  const rule = '-'.repeat(COLS);
  const fd = (iso) => { const [y, m, d] = (iso || '').split('-'); return d ? `${d}.${m}.${y}` : '?'; };
  const lines = [
    ['b', center("DUARTE'S GYM & CODE")],
    ['s', center('Zurich area, Switzerland')],
    ['s', center(`${fd(w.from)} - ${fd(w.to)}`)],
    ['', rule],
    ['s', pad('ITEM', 'SETS x REPS      QTY')],
    ['', pad('COMMITS', `${setsReps(w.commits)}`.padStart(11) + `${w.commits ?? 0}`.padStart(9))],
    ['', pad('PRS SHIPPED (MINE)', `${w.prsShipped ?? 0}`)],
    ['', pad('SPOTTING: PRS MERGED FOR OTHERS', `${w.prsMergedForOthers ?? 0}`)],
    ['', pad('FORM CHECKS: PRS REVIEWED', `${w.prsReviewed ?? 0}`)],
    ['', pad('ISSUES CLOSED', `${w.issuesClosed ?? 0}`)],
    ['', pad('THREADS ANSWERED', `${w.threadsCommented ?? 0}`)],
    ['', rule],
    ['', pad('SUBSCRIPTION', '0.00 CHF')],
    ['', pad('ADS, TRACKERS, PAYWALL', '0.00 CHF')],
    ['', pad('PROTEIN SHAKES', 'not billed')],
    ['', rule],
    ['b', pad('TOTAL', '0.00 CHF')],
    ['s', pad('PAID WITH', 'COFFEE + AGPL-3.0')],
    ['', ''],
    ['s', center('no account needed, keep your data.')],
    ['s', center('thank you for training with us!')],
  ];
  const top = 34, H = top + lines.length * LH + 92;
  const x0 = (W - COLS * CH) / 2;
  const css = fonts(['m400', 'm700']) + `text{font-family:${MONO};font-size:${FS}px}`;
  let s = svgOpen(W, H, `This week on GitHub as a gym receipt: ${w.commits ?? 0} commits, ${w.prsShipped ?? 0} PRs shipped, ${w.issuesClosed ?? 0} issues closed. Subscription 0.00 CHF.`, css);
  // jagged top/bottom edge
  const pts = [];
  for (let x = 0; x <= W; x += 12) pts.push([x, 7], [Math.min(x + 6, W), 0]);
  for (let x = W; x >= 0; x -= 12) pts.push([x, H - 7], [Math.max(x - 6, 0), H]);
  const shape = 'M' + pts.map(([px, py]) => `${px} ${py}`).join('L') + 'Z';
  s += `<defs><clipPath id="print"><rect x="0" y="0" width="${W}" height="${H}"><animate attributeName="height" from="0" to="${H}" dur="2.4s" fill="freeze" calcMode="spline" keyTimes="0;1" keySplines="0.3 0 0.4 1"/></rect></clipPath></defs>`;
  s += `<g clip-path="url(#print)"><path d="${shape}" fill="${paper}" stroke="${dark ? '#2d333b' : '#e5e1d3'}"/>`;
  lines.forEach(([kind, t], i) => {
    s += `<text x="${x0}" y="${top + 14 + i * LH}" xml:space="preserve" fill="${kind === 's' ? inkSoft : ink}"${kind === 'b' ? ' font-weight="700"' : ''}>${esc(t)}</text>`;
  });
  // barcode from the week's numbers
  let bx = x0 + 30, seed = (w.commits || 1) * 31 + (w.issuesClosed || 1);
  const by = top + lines.length * LH + 8;
  while (bx < W - x0 - 30) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const bw = 1 + (seed % 3);
    s += `<rect x="${bx.toFixed(1)}" y="${by}" width="${bw}" height="40" fill="${ink}"/>`;
    bx += bw + 1 + ((seed >> 4) % 3);
  }
  s += `<text x="${W / 2}" y="${by + 58}" text-anchor="middle" fill="${inkSoft}" style="font-size:11px">github.com/${USER}  ·  #${(w.to || '').replace(/-/g, '')}</text>`;
  s += '</g>';
  void edge;
  return s + '</svg>';
}

// ---------------------------------------------------------------- main

const data = await collect();
fs.mkdirSync(ASSETS, { recursive: true });
for (const mode of ['dark', 'light']) {
  const th = THEMES[mode];
  write(`terminal-${mode}.svg`, terminal(data, th));
  write(`opengym-${mode}.svg`, gymCard(data, mode));
  write(`rack-${mode}.svg`, rack(data, th));
  for (const t of TILES) write(`tile-${t.id}-${mode}.svg`, tile(t, th));
  write(`stack-${mode}.svg`, stack(th));
  write(`receipt-${mode}.svg`, receipt(data, mode));
}
if (!OFFLINE) fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2) + '\n');
log('done');
