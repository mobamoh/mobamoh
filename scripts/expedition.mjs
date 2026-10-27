// Draws the profile's two charts: a pirate's sea chart whose edge has been
// torn off (chart-*.svg) and the last year of contributions drawn as ocean
// swell (sea-*.svg). Zero dependencies — run with `node scripts/expedition.mjs`.
// The workflow in .github/workflows/expedition.yml re-plots them daily.

import { writeFile, mkdir } from "node:fs/promises";

const USER = "mobamoh";
const NAME = "Mo Bamoh";
const MOTTO = "curious explorer · sails where the maps run out";
const ARTICLES = [
  "No map is final. Every border is a suggestion.",
  "Read the source — then the parts it forgot to mention.",
  "Curiosity first. Permission, maybe later.",
  "Take apart what you love. Rebuild it stranger.",
  "Break things to learn, never to harm.",
];
const OUT = new URL("../assets/", import.meta.url);

const THEMES = {
  dark: {
    paper: "#0C1820",
    paperEdge: "#08121A",
    void: "#03060A",
    contour: "#1F4553",
    grid: "#132C37",
    ink: "#ECE3CC",
    inkDim: "#7E959C",
    brass: "#DDA64C",
    blood: "#E0493B",
    ember: "#F08A3C",
    flag: "#050608",
    bone: "#ECE3CC",
    rose: ["#ECE3CC", "#234A57"],
    sea: ["#0F2E3A", "#164556", "#1B5466"],
    foam: "#9FC9D1",
  },
  light: {
    paper: "#F3E9D1",
    paperEdge: "#E6D6B2",
    void: "#0B1015",
    contour: "#D0BA8E",
    grid: "#E2D1AC",
    ink: "#33281C",
    inkDim: "#8A7356",
    brass: "#A05A17",
    blood: "#B52E22",
    ember: "#E07A2A",
    flag: "#1C1712",
    bone: "#F3E9D1",
    rose: ["#FAF3E2", "#365F6B"],
    sea: ["#2F5A66", "#24505D", "#1A3F4B"],
    foam: "#E9F1EE",
  },
};

const SERIF = "Georgia, 'Iowan Old Style', 'Palatino Linotype', serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const f = (n) => Math.round(n * 10) / 10;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fmt = (n) => n.toLocaleString("en-US");
const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII"];

// ---------- data ----------

async function fetchProfile() {
  try {
    const res = await fetch(`https://api.github.com/users/${USER}`, {
      headers: process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {},
    });
    if (!res.ok) throw new Error(res.status);
    return await res.json();
  } catch (err) {
    console.warn("profile fetch failed:", err.message);
    return { created_at: new Date().toISOString() };
  }
}

// The public contributions page lists each day as a cell with an id, and a
// tooltip pointing at that id with the human-readable count.
async function fetchDays() {
  const html = await (await fetch(`https://github.com/users/${USER}/contributions`)).text();
  const dates = new Map();
  for (const m of html.matchAll(/data-date="(\d{4}-\d{2}-\d{2})"[^>]*?id="([^"]+)"[^>]*?data-level="(\d)"/g)) {
    dates.set(m[2], { date: m[1], level: +m[3], count: null });
  }
  for (const m of html.matchAll(/<tool-tip[^>]*?for="([^"]+)"[^>]*>\s*(No|\d+) contributions?/g)) {
    const day = dates.get(m[1]);
    if (day) day.count = m[2] === "No" ? 0 : +m[2];
  }
  const days = [...dates.values()].sort((a, b) => a.date.localeCompare(b.date));
  for (const d of days) if (d.count === null) d.count = d.level; // tooltip format changed: fall back to levels
  return days;
}

function summarize(days) {
  const weeks = [];
  for (let i = 0; i < days.length; i += 7) {
    const chunk = days.slice(i, i + 7);
    weeks.push({ start: chunk[0].date, total: chunk.reduce((s, d) => s + d.count, 0) });
  }
  let streak = 0, best = 0;
  for (const d of days) {
    streak = d.count > 0 ? streak + 1 : 0;
    best = Math.max(best, streak);
  }
  const total = days.reduce((s, d) => s + d.count, 0);
  const crest = weeks.reduce((a, b) => (b.total > a.total ? b : a), weeks[0]);
  return { weeks, total, best, crest };
}

// ---------- geometry helpers ----------

function rng(seed) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

// Catmull-Rom through the points, emitted as cubic Béziers.
function smoothPath(pts) {
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const [p0, p1, p2, p3] = [pts[i - 1] || pts[i], pts[i], pts[i + 1], pts[i + 2] || pts[i + 1]];
    // Clamp control points vertically so the curve never overshoots its
    // neighbours — no crests above the data, no troughs below the seabed.
    const lo = Math.min(p1[1], p2[1]), hi = Math.max(p1[1], p2[1]);
    const clamp = (y) => Math.min(hi, Math.max(lo, y));
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, clamp(p1[1] + (p2[1] - p0[1]) / 6)];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, clamp(p2[1] - (p3[1] - p1[1]) / 6)];
    d += `C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(p2[0])} ${f(p2[1])}`;
  }
  return d;
}

// Topographic contour lines: a field of random hills traced with marching
// squares. Segments aren't joined; at low opacity with round caps they read
// as continuous lines.
function contours(w, h, seed, levels = 9, step = 11) {
  const rand = rng(seed);
  const hills = Array.from({ length: 7 }, () => ({
    x: rand() * w, y: rand() * h, r: 90 + rand() * 220, a: 0.5 + rand(),
  }));
  const field = (x, y) =>
    hills.reduce((s, k) => s + k.a * Math.exp(-((x - k.x) ** 2 + (y - k.y) ** 2) / (2 * k.r ** 2)), 0) +
    0.08 * Math.sin(x / 47) * Math.cos(y / 39);
  const cols = Math.ceil(w / step) + 1, rows = Math.ceil(h / step) + 1;
  const v = [];
  let max = 0;
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) max = Math.max(max, (v[j * cols + i] = field(i * step, j * step)));
  const paths = [];
  for (let l = 1; l <= levels; l++) {
    const t = (max * l) / (levels + 1);
    let d = "";
    for (let j = 0; j < rows - 1; j++) for (let i = 0; i < cols - 1; i++) {
      const c = [v[j * cols + i], v[j * cols + i + 1], v[(j + 1) * cols + i + 1], v[(j + 1) * cols + i]];
      const P = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]];
      const hits = [];
      for (let e = 0; e < 4; e++) {
        const a = c[e], b = c[(e + 1) % 4];
        if ((a < t) !== (b < t)) {
          const k = (t - a) / (b - a);
          const [pa, pb] = [P[e], P[(e + 1) % 4]];
          hits.push([(pa[0] + (pb[0] - pa[0]) * k) * step, (pa[1] + (pb[1] - pa[1]) * k) * step]);
        }
      }
      for (let k = 0; k + 1 < hits.length; k += 2)
        d += `M${f(hits[k][0])} ${f(hits[k][1])}L${f(hits[k + 1][0])} ${f(hits[k + 1][1])}`;
    }
    paths.push({ d, index: l });
  }
  return paths;
}

// The alternating black/white "neatline" band that frames printed sea charts.
function chartFrame(w, h, t, inset = 18, band = 8, seg = 36) {
  const x0 = inset, y0 = inset, x1 = w - inset, y1 = h - inset;
  let ticks = "";
  for (let x = x0, n = 0; x < x1; x += seg, n++) {
    if (n % 2) continue;
    const sw = Math.min(seg, x1 - x);
    ticks += `<rect x="${x}" y="${y0}" width="${sw}" height="${band}"/><rect x="${x}" y="${y1 - band}" width="${sw}" height="${band}"/>`;
  }
  for (let y = y0, n = 0; y < y1; y += seg, n++) {
    if (n % 2) continue;
    const sh = Math.min(seg, y1 - y);
    ticks += `<rect x="${x0}" y="${y}" width="${band}" height="${sh}"/><rect x="${x1 - band}" y="${y}" width="${band}" height="${sh}"/>`;
  }
  return `
  <g fill="${t.ink}" opacity="0.85">${ticks}</g>
  <rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" fill="none" stroke="${t.ink}" stroke-width="1.2"/>
  <rect x="${x0 + band}" y="${y0 + band}" width="${x1 - x0 - 2 * band}" height="${y1 - y0 - 2 * band}" fill="none" stroke="${t.ink}" stroke-width="0.8"/>
  <rect x="${x0 - 6}" y="${y0 - 6}" width="${x1 - x0 + 12}" height="${y1 - y0 + 12}" fill="none" stroke="${t.ink}" stroke-width="0.6" opacity="0.6"/>`;
}

// A periodic swell, drawn one wavelength wider on each side so it can slide
// left by exactly one wavelength and loop seamlessly.
function swell(x0, x1, y, amp, wl, floor) {
  let d = `M${x0 - wl} ${y}`;
  for (let x = x0 - wl; x < x1 + wl; x += wl) d += `q${wl / 4} ${-amp} ${wl / 2} 0t${wl / 2} 0`;
  return { fill: `${d}V${floor}H${x0 - wl}Z`, crest: d };
}

// A jagged line between two points — the ragged edge of torn paper.
function ragged(a, b, n, jitter, rand) {
  const pts = [];
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const len = Math.hypot(dx, dy);
  for (let i = 0; i <= n; i++) {
    const k = i / n, off = i === 0 || i === n ? 0 : (rand() - 0.5) * 2 * jitter * (rand() < 0.25 ? 1.8 : 0.6);
    pts.push([a[0] + dx * k - (dy / len) * off, a[1] + dy * k + (dx / len) * off]);
  }
  return pts;
}

function ship(t, scale = 1) {
  return `<g transform="scale(${scale})">
    <path d="M-26 -2H26L19 9H-19Z" fill="${t.flag}" stroke="${t.ink}" stroke-width="1"/>
    <path d="M-17 2h4M-7 2h4M3 2h4M13 2h4" stroke="${t.ember}" stroke-width="1.6"/>
    <path d="M-4 -2V-44M11 -2V-34" stroke="${t.ink}" stroke-width="1.6"/>
    <path d="M-3 -40Q12 -30 -3 -10Z" fill="${t.ink}" opacity="0.92"/>
    <path d="M12 -31Q23 -22 12 -9Z" fill="${t.ink}" opacity="0.8"/>
    <path d="M-5 -38Q-18 -26 -5 -12Z" fill="${t.ink}" opacity="0.7"/>
    <path d="M-4 -44H-16V-37H-4Z" fill="${t.flag}" stroke="${t.ink}" stroke-width="0.8"/>
    <circle cx="-10" cy="-40.5" r="1.7" fill="${t.ink}"/>
  </g>`;
}

// ---------- the sea chart ----------

// A compass that has given up: the rose is all there, but North is struck
// out and the needle never settles.
function lostCompass(cx, cy, r, t) {
  let star = "";
  const point = (deg, len, wid) => {
    const a = ((deg - 90) * Math.PI) / 180;
    const tip = [cx + len * Math.cos(a), cy + len * Math.sin(a)];
    const l = [cx + wid * Math.cos(a - Math.PI / 2), cy + wid * Math.sin(a - Math.PI / 2)];
    const rr = [cx + wid * Math.cos(a + Math.PI / 2), cy + wid * Math.sin(a + Math.PI / 2)];
    return `<path d="M${f(cx)} ${f(cy)}L${f(tip[0])} ${f(tip[1])}L${f(l[0])} ${f(l[1])}Z" fill="${t.rose[1]}" stroke="${t.ink}" stroke-width="0.6"/>` +
      `<path d="M${f(cx)} ${f(cy)}L${f(tip[0])} ${f(tip[1])}L${f(rr[0])} ${f(rr[1])}Z" fill="${t.rose[0]}" stroke="${t.ink}" stroke-width="0.6"/>`;
  };
  for (let d = 11.25; d < 360; d += 22.5) star += point(d, r * 0.4, r * 0.05);
  for (let d = 45; d < 360; d += 90) star += point(d, r * 0.62, r * 0.09);
  for (let d = 0; d < 360; d += 90) star += point(d, r * 0.9, r * 0.12);

  let ticks = "";
  for (let d = 0; d < 360; d += 5) {
    const a = ((d - 90) * Math.PI) / 180;
    const r0 = d % 30 === 0 ? r * 1.02 : d % 10 === 0 ? r * 1.06 : r * 1.08;
    ticks += `M${f(cx + r0 * Math.cos(a))} ${f(cy + r0 * Math.sin(a))}L${f(cx + r * 1.12 * Math.cos(a))} ${f(cy + r * 1.12 * Math.sin(a))}`;
  }
  const at = (d, rr) => {
    const a = ((d - 90) * Math.PI) / 180;
    return [cx + rr * Math.cos(a), cy + rr * Math.sin(a)];
  };
  const card = (txt, d) => {
    const [x, y] = at(d, r * 1.26);
    return `<text x="${f(x)}" y="${f(y + 7)}">${txt}</text>`;
  };
  let rhumb = "";
  for (let d = 0; d < 360; d += 22.5) {
    const [a, b] = [at(d, r * 1.12), at(d, 1000)];
    rhumb += `M${f(a[0])} ${f(a[1])}L${f(b[0])} ${f(b[1])}`;
  }
  const [nx, ny] = at(0, r * 1.26);
  const L = r * 1.0;

  return `
  <path d="${rhumb}" stroke="${t.brass}" stroke-width="0.6" opacity="0.2" clip-path="url(#inner)"/>
  <circle cx="${cx}" cy="${cy}" r="${f(r * 1.12)}" fill="${t.paper}" opacity="0.8"/>
  <circle cx="${cx}" cy="${cy}" r="${f(r * 1.12)}" fill="none" stroke="${t.ink}" stroke-width="1"/>
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${t.ink}" stroke-width="0.6"/>
  <path d="${ticks}" stroke="${t.ink}" stroke-width="0.8"/>
  <g opacity="0.85">${star}</g>
  <g font-family="${SERIF}" font-size="20" font-weight="700" fill="${t.ink}" text-anchor="middle">${card("N", 0)}${card("E", 90)}${card("S", 180)}${card("W", 270)}</g>
  <path d="M${f(nx - 13)} ${f(ny + 6)}L${f(nx + 13)} ${f(ny - 12)}M${f(nx - 13)} ${f(ny - 12)}L${f(nx + 13)} ${f(ny + 6)}" stroke="${t.blood}" stroke-width="3" stroke-linecap="round"/>
  <g>
    <animateTransform attributeName="transform" type="rotate" dur="11s" repeatCount="indefinite" calcMode="spline"
      values="0 ${cx} ${cy};150 ${cx} ${cy};110 ${cx} ${cy};290 ${cx} ${cy};250 ${cx} ${cy};400 ${cx} ${cy};360 ${cx} ${cy}"
      keyTimes="0;0.18;0.3;0.5;0.62;0.86;1" keySplines="0.3 0 0.2 1;0.4 0 0.6 1;0.3 0 0.2 1;0.4 0 0.6 1;0.3 0 0.2 1;0.4 0 0.6 1"/>
    <path d="M${cx} ${f(cy - L)}L${f(cx + r * 0.07)} ${cy}L${cx} ${f(cy + L)}L${f(cx - r * 0.07)} ${cy}Z" fill="${t.ink}" opacity="0.18"/>
    <path d="M${cx} ${f(cy - L)}L${f(cx + r * 0.07)} ${cy}H${f(cx - r * 0.07)}Z" fill="${t.blood}" stroke="${t.ink}" stroke-width="0.8"/>
    <path d="M${cx} ${f(cy + L)}L${f(cx + r * 0.07)} ${cy}H${f(cx - r * 0.07)}Z" fill="${t.ink}" stroke="${t.ink}" stroke-width="0.8"/>
  </g>
  <circle cx="${cx}" cy="${cy}" r="${f(r * 0.06)}" fill="${t.brass}" stroke="${t.ink}" stroke-width="0.8"/>
  <text x="${cx}" y="${f(cy + r * 1.26 + 40)}" font-family="${MONO}" font-size="11" letter-spacing="2.5" fill="${t.blood}" text-anchor="middle">TRUE NORTH · NOT FOUND</text>`;
}

// The Jolly Roger — with blinking terminal cursors for eyes.
function jollyRoger(x, y, t) {
  const w = 150, h = 92;
  const flag = (a, b) =>
    `M${x} ${y}C${x + 40} ${y + a} ${x + 100} ${y - a} ${x + w} ${y + b}L${x + w + b / 2} ${y + h + b}C${x + 100} ${y + h - a} ${x + 40} ${y + h + a} ${x} ${y + h}Z`;
  const cx = x + 74, cy = y + 44;
  return `
  <path d="M${x} ${y - 14}V${y + 168}" stroke="${t.ink}" stroke-width="3" stroke-linecap="round"/>
  <circle cx="${x}" cy="${y - 16}" r="4" fill="${t.brass}"/>
  <path d="${flag(-9, 4)}" fill="${t.flag}" stroke="${t.ink}" stroke-width="1">
    <animate attributeName="d" dur="2.8s" repeatCount="indefinite" values="${flag(-9, 4)};${flag(9, -4)};${flag(-9, 4)}"/>
  </path>
  <g>
    <animateTransform attributeName="transform" type="translate" dur="2.8s" repeatCount="indefinite" values="0 0;1 2;0 0"/>
    <g stroke="${t.bone}" stroke-width="6" stroke-linecap="round">
      <path d="M${cx - 30} ${cy - 22}L${cx + 30} ${cy + 26}M${cx + 30} ${cy - 22}L${cx - 30} ${cy + 26}"/>
    </g>
    <g fill="${t.bone}">
      ${[[-30, -22], [30, -22], [-30, 26], [30, 26]].map(([dx, dy]) => {
        const sx = Math.sign(dx), sy = Math.sign(dy);
        return `<circle cx="${cx + dx + sx * 1}" cy="${cy + dy - sy * 4}" r="4.2"/><circle cx="${cx + dx - sx * 4}" cy="${cy + dy + sy * 1}" r="4.2"/>`;
      }).join("")}
      <circle cx="${cx}" cy="${cy - 6}" r="20"/>
      <rect x="${cx - 12}" y="${cy + 6}" width="24" height="12" rx="3"/>
    </g>
    <g fill="${t.flag}">
      <rect x="${cx - 12}" y="${cy - 12}" width="8" height="11" rx="1"/>
      <rect x="${cx + 4}" y="${cy - 12}" width="8" height="11" rx="1"/>
      <path d="M${cx} ${cy + 1}l-3 5h6z"/>
      <path d="M${cx - 6} ${cy + 12}v6M${cx} ${cy + 12}v6M${cx + 6} ${cy + 12}v6" stroke="${t.flag}" stroke-width="1.6"/>
    </g>
    <g fill="${t.blood}">
      <animate attributeName="opacity" values="1;1;0;0" keyTimes="0;0.5;0.5;1" dur="1.1s" repeatCount="indefinite"/>
      <rect x="${cx - 11}" y="${cy - 5}" width="6" height="3"/>
      <rect x="${cx + 5}" y="${cy - 5}" width="6" height="3"/>
    </g>
  </g>`;
}

function seaChart(t, profile) {
  const W = 1180, H = 600;
  const days = Math.floor((Date.now() - new Date(profile.created_at)) / 864e5);
  const rand = rng(0x5ea);

  const topo = contours(W, H, 0xb4a0 + 7).map(({ d, index }) =>
    `<path d="${d}" stroke="${t.contour}" stroke-width="${index % 3 === 0 ? 1.3 : 0.7}" opacity="${index % 3 === 0 ? 0.85 : 0.55}"/>`
  ).join("");
  let grid = "";
  for (let x = 160; x < W - 40; x += 160) grid += `M${x} 34V${H - 34}`;
  for (let y = 150; y < H - 40; y += 150) grid += `M34 ${y}H${W - 34}`;
  const lonLabels = [160, 320, 480, 640, 800].map((x) => `<text x="${x}" y="13">??°E</text>`).join("");
  const latLabels = [150, 300, 450].map((y) => `<text x="9" y="${y}" transform="rotate(-90 9 ${y})">??°N</text>`).join("");

  // The torn corner: the chart simply stops, and past it is open night.
  const edge = ragged([W + 4, 268], [790, H + 4], 70, 9, rand);
  const tear = `M${edge.map(([x, y]) => `${f(x)} ${f(y)}`).join("L")}L${W + 4} ${H + 4}Z`;
  const edgeLine = `M${edge.map(([x, y]) => `${f(x)} ${f(y)}`).join("L")}`;
  let stars = "";
  for (let i = 0; i < 46; i++) {
    const x = 800 + rand() * 380, y = 270 + rand() * 330, r = 0.5 + rand() * 1.3;
    const blink = rand() < 0.35 ? `<animate attributeName="opacity" values="0.9;0.15;0.9" dur="${(2 + rand() * 4).toFixed(1)}s" begin="${(rand() * 3).toFixed(1)}s" repeatCount="indefinite"/>` : "";
    stars += `<circle cx="${f(x)}" cy="${f(y)}" r="${f(r)}" fill="#F1EAD6" opacity="0.8">${blink}</circle>`;
  }

  const LX = 500;
  const articles = ARTICLES.map((a, i) => {
    const y = 286 + i * 37;
    return `
    <g>
      <animate attributeName="opacity" values="0;0;1" keyTimes="0;${((0.6 + i * 0.3) / (1.2 + i * 0.3)).toFixed(3)};1" dur="${(1.2 + i * 0.3).toFixed(2)}s" fill="freeze"/>
      <text x="${LX + 26}" y="${y}" font-family="${SERIF}" font-size="17" font-weight="700" fill="${t.blood}" text-anchor="end">${ROMAN[i]}.</text>
      <text x="${LX + 40}" y="${y}" font-family="${SERIF}" font-size="19" fill="${t.ink}">${esc(a)}</text>
    </g>`;
  }).join("");

  const back = swell(0, W, 532, 5, 96, H + 10);
  const mid = swell(0, W, 546, 7, 140, H + 10);
  const front = swell(0, W, 566, 6, 74, H + 10);
  const slide = (wl, dur) => `<animateTransform attributeName="transform" type="translate" from="0 0" to="${-wl} 0" dur="${dur}s" repeatCount="indefinite"/>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(NAME)} — a pirate's sea chart with the edge torn off">
<defs>
  <radialGradient id="paper" cx="25%" cy="40%" r="95%">
    <stop offset="0%" stop-color="${t.paper}"/><stop offset="100%" stop-color="${t.paperEdge}"/>
  </radialGradient>
  <radialGradient id="night" cx="100%" cy="100%" r="90%">
    <stop offset="0%" stop-color="#0E1A28"/><stop offset="100%" stop-color="${t.void}"/>
  </radialGradient>
  <clipPath id="inner"><rect x="34" y="34" width="${W - 68}" height="${H - 68}"/></clipPath>
  <clipPath id="beyond"><path d="${tear}"/></clipPath>
  <filter id="burn" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="3"/></filter>
</defs>

<rect width="${W}" height="${H}" fill="url(#paper)"/>
<g clip-path="url(#inner)" fill="none" stroke-linecap="round">
  ${topo}
  <path d="${grid}" stroke="${t.grid}" stroke-width="1"/>
</g>
${chartFrame(W, H, t)}
<g font-family="${MONO}" font-size="9" fill="${t.inkDim}" text-anchor="middle">${lonLabels}${latLabels}</g>

${lostCompass(240, 262, 148, t)}

<g font-family="${MONO}" font-size="12" letter-spacing="3.2" fill="${t.blood}">
  <text x="${LX}" y="84">NO MAP · NO MASTER · NO PORT OF CALL</text>
</g>
<text x="${LX - 3}" y="156" font-family="${SERIF}" font-size="66" font-weight="700" letter-spacing="1" fill="${t.ink}">${esc(NAME)}</text>
<text x="${LX}" y="194" font-family="${SERIF}" font-size="20" font-style="italic" fill="${t.inkDim}">${esc(MOTTO)}</text>
${jollyRoger(958, 60, t)}
<path d="M${LX} 216H${930}" stroke="${t.ink}" stroke-width="1"/>
<path d="M${LX} 220H${930}" stroke="${t.ink}" stroke-width="0.5" opacity="0.6"/>
<text x="${LX}" y="248" font-family="${MONO}" font-size="11" letter-spacing="2.5" fill="${t.inkDim}">THE ARTICLES · SWORN ON THE OPEN SEA</text>
${articles}

<g font-family="${MONO}" font-size="13" fill="${t.ink}">
  <text x="${LX}" y="500"><tspan fill="${t.blood}">$</tspan> ./set-sail --no-map --no-rules <tspan fill="${t.inkDim}"># day ${fmt(days)} at sea</tspan></text>
  <rect x="${LX + 4 + 52 * 7.8}" y="489" width="8" height="14" fill="${t.ink}">
    <animate attributeName="opacity" values="1;1;0;0" keyTimes="0;0.5;0.5;1" dur="1.1s" repeatCount="indefinite"/>
  </rect>
</g>

<path d="${tear}" fill="url(#night)"/>
<g clip-path="url(#beyond)">${stars}</g>
<path d="${edgeLine}" fill="none" stroke="${t.ember}" stroke-width="7" opacity="0.55" filter="url(#burn)">
  <animate attributeName="opacity" values="0.55;0.3;0.6;0.45;0.55" dur="3.2s" repeatCount="indefinite"/>
</path>
<path d="${edgeLine}" fill="none" stroke="#2A1A10" stroke-width="2.4"/>
<g font-family="${SERIF}" font-style="italic" fill="#E9E1CB" text-anchor="end">
  <text x="1148" y="430" font-size="16">the map ends here.</text>
  <text x="1148" y="454" font-size="16" fill="${t.ember}">we don't.</text>
</g>

<g>${slide(96, 9)}<path d="${back.fill}" fill="${t.sea[0]}" opacity="0.75"/></g>
<g>
  <animateMotion dur="46s" repeatCount="indefinite" path="M-70 532H1260"/>
  <g>
    <animateTransform attributeName="transform" type="rotate" values="-4;3;-4" dur="3.4s" repeatCount="indefinite"/>
    ${ship(t, 0.95)}
  </g>
</g>
<g>${slide(140, 12)}<path d="${mid.fill}" fill="${t.sea[1]}"/><path d="${mid.crest}" fill="none" stroke="${t.foam}" stroke-width="1.2" opacity="0.55"/></g>
<g>${slide(74, 6)}<path d="${front.fill}" fill="${t.sea[2]}"/><path d="${front.crest}" fill="none" stroke="${t.foam}" stroke-width="1.4" stroke-dasharray="14 9" opacity="0.7"/></g>
</svg>
`;
}

// ---------- the sea state ----------

function seaState(t, stats) {
  const W = 1180, H = 330;
  const X0 = 70, X1 = W - 70, FLOOR = 270, CREST = 128;
  const { weeks } = stats;
  const max = Math.max(1, ...weeks.map((w) => w.total));
  const step = (X1 - X0) / (weeks.length - 1);
  const height = (v) => FLOOR - 10 - (Math.sqrt(v) / Math.sqrt(max)) * (FLOOR - CREST);
  const pts = weeks.map((w, i) => [X0 + i * step, height(w.total)]);
  const surface = smoothPath(pts);
  const water = `${surface}L${X1} ${FLOOR}L${X0} ${FLOOR}Z`;

  // The long background swells are decorative — the front wave is the data.
  const far = swell(X0 - 30, X1 + 30, 232, 8, 160, FLOOR);
  const near = swell(X0 - 30, X1 + 30, 246, 6, 104, FLOOR);
  const slide = (wl, dur) => `<animateTransform attributeName="transform" type="translate" from="0 0" to="${-wl} 0" dur="${dur}s" repeatCount="indefinite"/>`;

  let ripples = "";
  for (let y = FLOOR - 14; y > CREST - 10; y -= 12) ripples += `M${X0} ${y}h${X1 - X0}`;

  const ci = weeks.indexOf(stats.crest);
  const [cx, cy] = pts[ci];

  let months = "", lastMonth = -1;
  weeks.forEach((w, i) => {
    const m = new Date(w.start).getUTCMonth();
    if (m !== lastMonth && i > 0) {
      const x = X0 + i * step;
      months += `<path d="M${f(x)} ${FLOOR}v6" stroke="${t.ink}" stroke-width="1"/>` +
        `<text x="${f(x)}" y="${FLOOR + 20}">${new Date(w.start).toLocaleString("en-US", { month: "short", timeZone: "UTC" }).toUpperCase()}</text>`;
    }
    lastMonth = m;
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="A pirate ship sailing a year of rough waters">
<defs>
  <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="${t.paperEdge}"/><stop offset="100%" stop-color="${t.paper}"/>
  </linearGradient>
  <clipPath id="plot"><rect x="${X0 - 30}" y="40" width="${X1 - X0 + 60}" height="${FLOOR - 40}"/></clipPath>
  <clipPath id="water"><path d="${water}"/></clipPath>
</defs>
<rect width="${W}" height="${H}" fill="url(#sky)"/>
${chartFrame(W, H, t)}


<g clip-path="url(#plot)">
  <g>${slide(160, 14)}<path d="${far.fill}" fill="${t.sea[0]}" opacity="0.35"/></g>
  <g>${slide(104, 9)}<path d="${near.fill}" fill="${t.sea[1]}" opacity="0.45"/></g>
</g>
<path d="${water}" fill="${t.sea[2]}"/>
<path d="${ripples}" stroke="${t.foam}" stroke-width="0.7" stroke-dasharray="3 9" opacity="0.35" clip-path="url(#water)">
  <animate attributeName="stroke-dashoffset" from="0" to="-48" dur="4s" repeatCount="indefinite"/>
</path>
<path d="${surface}" fill="none" stroke="${t.foam}" stroke-width="2"/>

<g>
  <animateMotion dur="34s" repeatCount="indefinite" path="${surface}"/>
  <g transform="translate(0 -4)">
    <animateTransform attributeName="transform" type="rotate" values="-5;4;-5" dur="2.6s" repeatCount="indefinite" additive="sum"/>
    ${ship(t, 0.62)}
  </g>
</g>

<g transform="translate(${f(cx)} ${f(cy - 4)})">
  <path d="M0 0V-40" stroke="${t.ink}" stroke-width="1.6"/>
  <path d="M0 -40H22V-26H0Z" fill="${t.flag}" stroke="${t.ink}" stroke-width="0.8">
    <animate attributeName="d" values="M0 -40H22V-26H0Z;M0 -40Q11 -43 22 -38V-25Q11 -28 0 -26Z;M0 -40H22V-26H0Z" dur="1.8s" repeatCount="indefinite"/>
  </path>
  <circle cx="11" cy="-34.5" r="3.2" fill="${t.ink}"/>
</g>

<path d="M${X0} ${FLOOR}H${X1}" stroke="${t.ink}" stroke-width="1.2"/>
<g font-family="${MONO}" font-size="9" letter-spacing="1" fill="${t.inkDim}" text-anchor="middle">${months}</g>
</svg>
`;
}

// ---------- main ----------

const [profile, days] = await Promise.all([fetchProfile(), fetchDays()]);
const stats = summarize(days);
await mkdir(OUT, { recursive: true });
for (const [name, t] of Object.entries(THEMES)) {
  await writeFile(new URL(`chart-${name}.svg`, OUT), seaChart(t, profile));
  await writeFile(new URL(`sea-${name}.svg`, OUT), seaState(t, stats));
}
console.log(`plotted ${days.length} days, ${stats.total} contributions, biggest wave ${stats.crest.total} (${stats.crest.start})`);
