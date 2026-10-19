/* Money Bag — app personal de inversiones.
 *
 * Dos fuentes:
 *  1. Snapshot diario en Supabase (tabla inv_snapshot): 'mercado' y 'cuenta'.
 *     Lo genera exportar_app.py 1 vez al dia (niveles, fundamentales, IBKR...).
 *  2. Precios en vivo (funcion inv-precios) cada vez que se abre la app.
 *
 * Con el precio del momento se recalcula aqui: % del dia, 1S/1M/3M/1A, R:B y
 * posicion en el rango por horizonte, semaforo, alertas de cruce, Top 5,
 * upside vs precio objetivo, valor y P&L de la cartera, concentracion por
 * ticker/sector/bloque, liquidez y el panel DCLA (Art. I, III y V).
 * Las formulas son las mismas de technical_levels.py e ibkr_flex.py.
 */
(() => {
"use strict";
const CFG = window.MB_CONFIG;
const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

const S = { M: null, C: null, Q: {}, E: {}, qAt: null, loadingQ: false, view: "resumen", sector: "Todos", sort: "sector", wmode: "lista", masked: false };
try { S.masked = localStorage.getItem("mb_masked") === "1"; S.view = localStorage.getItem("mb_view") || "resumen"; S.wmode = localStorage.getItem("mb_wmode") || "lista"; } catch (_) {}

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// El briefing viene con <strong>/<em> generados por nuestro propio Python: se
// escapa todo y se re-permiten solo esas dos etiquetas.
const safeRich = (s) => esc(s).replace(/&lt;(\/?)(strong|em)&gt;/g, "<$1$2>");
const isNum = (v) => typeof v === "number" && isFinite(v);

// ── Formato ────────────────────────────────────────────────────────────────
const nf = (d) => new Intl.NumberFormat("es-CO", { minimumFractionDigits: d, maximumFractionDigits: d });
function fPrice(v) {
  if (!isNum(v)) return "—";
  const d = v >= 1000 ? 0 : v >= 1 ? 2 : 4;
  return "$" + nf(d).format(v);
}
function fUsd(v, opts = {}) {
  if (!isNum(v)) return "—";
  const sign = opts.sign ? (v > 0 ? "+" : v < 0 ? "−" : "") : (v < 0 ? "−" : "");
  const a = Math.abs(v);
  const body = a >= 1e6 ? nf(2).format(a / 1e6) + " M" : nf(a >= 1000 ? 0 : 2).format(a);
  return `<span class="amt">${sign}$${body}</span>`;
}
function fPct(v, d = 1, sign = true) {
  if (!isNum(v)) return "—";
  const s = sign ? (v > 0 ? "+" : v < 0 ? "−" : "") : v < 0 ? "−" : "";
  return s + nf(d).format(Math.abs(v)) + "%";
}
const cls = (v) => (isNum(v) ? (v > 0 ? "up" : v < 0 ? "down" : "") : "");
function fTime(ms) {
  if (!ms) return "—";
  return new Date(ms).toLocaleTimeString("es-CO", { hour: "numeric", minute: "2-digit" });
}
function fDate(iso, withYear = false) {
  if (!iso) return "—";
  const d = new Date(iso.length <= 10 ? iso + "T12:00:00" : iso);
  return d.toLocaleDateString("es-CO", { day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}) });
}
function daysUntil(iso) {
  if (!iso) return null;
  const d = new Date(iso + "T12:00:00"); const n = new Date(); n.setHours(12, 0, 0, 0);
  return Math.round((d - n) / 86400000);
}
const semClass = (s) => ({ Verde: "verde", Amarillo: "amarillo", Rojo: "rojo", VERDE: "verde", AMARILLO: "amarillo", ROJO: "rojo" }[s] || "neutro");
const verClass = (v) => ({ "Califica": "verde", "Vigilar": "amarillo", "No califica": "rojo" }[v] || "neutro");
const TIER_NAME = { tactico: "Táctico 6m", estructural: "Estructural 2a", historico: "Histórico 5a" };

// ── Lógica de niveles (port de technical_levels.py) ─────────────────────────
const RIESGO_MIN = 1.0, RATIO_TOPE = 10.0;
function riesgoBeneficio(piso, techo, precio) {
  if (!piso || !techo || !isNum(precio) || precio <= 0) return null;
  const p = piso.precio, t = techo.precio;
  if (!isNum(p) || !isNum(t) || t <= p) return null;
  const riesgo = (precio - p) / precio, benef = (t - precio) / precio;
  const pos = Math.max(0, Math.min(1, (precio - p) / (t - p)));
  const ratio = riesgo <= 0 ? null : Math.round((benef / riesgo) * 10) / 10;
  const confiable = ratio !== null && riesgo * 100 >= RIESGO_MIN;
  let sem;
  if (pos < 0.35 && ratio !== null && ratio > 2) sem = "Verde";
  else if (pos > 0.65 || ratio === null || ratio < 1) sem = "Rojo";
  else sem = "Amarillo";
  return { ratio, confiable, riesgo_pct: riesgo * 100, beneficio_pct: benef * 100, posicion: pos, semaforo: sem };
}
function fRatio(rb) {
  if (!rb) return "—";
  if (rb.ratio === null) return "bajo piso";
  if (!rb.confiable) return "en piso";
  return (rb.ratio >= RATIO_TOPE ? ">" + RATIO_TOPE : nf(1).format(rb.ratio)) + "x";
}
function liveLevels(t) {
  const info = S.M.tickers[t] || {};
  const nt = info.niveles || {};
  const price = livePrice(t);
  if (nt.error || !nt.niveles || !isNum(price)) return { price, err: nt.error || (isNum(price) ? null : "sin precio"), nt };
  const niv = nt.niveles;
  const tiers = {};
  for (const k of ["tactico", "estructural", "historico"]) {
    const x = niv[k] || {};
    tiers[k] = { ...x, rbLive: riesgoBeneficio(x.piso, x.techo, price) };
  }
  const pisoRef = niv.tactico?.piso || niv.estructural?.piso || niv.historico?.piso;
  const techoRef = niv.tactico?.techo || niv.estructural?.techo || niv.historico?.techo;
  let alerta = null, alertaTipo = null;
  if (pisoRef && price <= pisoRef.precio * 1.02) {
    const d = (price / pisoRef.precio - 1) * 100; alertaTipo = "piso";
    alerta = d <= 0 ? `cruzó su piso de compra (${fPrice(pisoRef.precio)}), ${nf(1).format(Math.abs(d))}% por debajo`
                    : `está a ${nf(1).format(d)}% de su piso de compra (${fPrice(pisoRef.precio)})`;
  } else if (techoRef && price >= techoRef.precio * 0.98) {
    const d = (1 - price / techoRef.precio) * 100; alertaTipo = "techo";
    alerta = d <= 0 ? `cruzó su techo de venta (${fPrice(techoRef.precio)}), ${nf(1).format(Math.abs(d))}% por encima`
                    : `está a ${nf(1).format(d)}% de su techo de venta (${fPrice(techoRef.precio)})`;
  }
  const rb = riesgoBeneficio(pisoRef, techoRef, price);
  return { price, nt, tiers, pisoRef, techoRef, rb, alerta, alertaTipo };
}
function topOportunidades(n = 5) {
  const cands = [];
  for (const t of allTickers()) {
    const L = liveLevels(t);
    if (!L.rb) continue;
    cands.push({ t, L, ver: L.nt.veredicto });
  }
  const sc = (c) => 1 - c.L.rb.posicion + ({ Califica: 0.15, Vigilar: 0.05 }[c.ver] || 0) + ({ Verde: 0.10, Amarillo: 0.03 }[c.L.rb.semaforo] || 0);
  const sv = (c) => c.L.rb.posicion + ({ "No califica": 0.05, Vigilar: 0.02 }[c.ver] || 0) + (c.L.rb.semaforo === "Rojo" ? 0.05 : 0);
  const compra = cands.filter((c) => c.L.rb.semaforo !== "Rojo").sort((a, b) => sc(b) - sc(a)).slice(0, n);
  const venta = cands.filter((c) => c.L.rb.semaforo !== "Verde").sort((a, b) => sv(b) - sv(a)).slice(0, n);
  return { compra, venta };
}

// ── Precios ────────────────────────────────────────────────────────────────
function allTickers() { return Object.keys(S.M?.tickers || {}); }
function livePrice(t) {
  const q = S.Q[t];
  if (q && isNum(q.price)) return q.price;
  const pos = S.C?.posiciones?.[t];
  const snap = S.M?.tickers?.[t]?.precio_snapshot;
  return isNum(snap) ? snap : pos?.mark_price ?? null;
}
function liveChg(t) {
  const q = S.Q[t];
  if (q && isNum(q.chgPct)) return q.chgPct;
  return S.M?.tickers?.[t]?.chg_snapshot ?? null;
}
function prevClose(t) { return S.Q[t]?.prevClose ?? null; }
function periodReturns(t) {
  const info = S.M.tickers[t] || {}, refs = info.ref_cierres || {}, p = livePrice(t), out = {};
  for (const k of ["1w", "1m", "3m", "1y"]) out[k] = isNum(refs[k]) && isNum(p) ? (p / refs[k] - 1) * 100 : info.hist?.[k] ?? null;
  return out;
}
const yahoo = (t) => t.replace(/\s+/g, "-");

async function loadQuotes() {
  if (S.loadingQ || !S.M) return;
  S.loadingQ = true; setStatus();
  try {
    const syms = [...new Set([...allTickers(), ...Object.keys(S.C?.posiciones || {}), ...CFG.macroSymbols].map(yahoo))];
    const { data, error } = await sb.functions.invoke("inv-precios", { body: { symbols: syms } });
    if (error) throw error;
    const q = data?.quotes || {};
    const map = {};
    for (const t of new Set([...allTickers(), ...Object.keys(S.C?.posiciones || {}), ...CFG.macroSymbols])) map[t] = q[yahoo(t)] || null;
    S.Q = map; S.qAt = data?.at || Date.now(); S.qErr = null;
  } catch (e) {
    S.qErr = "No se pudieron traer precios en vivo. Se muestran los del cierre del snapshot.";
    console.warn(e);
  } finally { S.loadingQ = false; render(); }
}

// ── Cartera en vivo (port de ibkr_flex.py) ─────────────────────────────────
function portfolio() {
  const C = S.C; if (!C?.posiciones) return null;
  const cfg = S.M?.config || {};
  const rows = [];
  let total = 0, day = 0, dayKnown = false, unreal = 0, cost = 0;
  for (const [sym, p] of Object.entries(C.posiciones)) {
    const px = S.Q[sym]?.price ?? p.mark_price ?? livePrice(sym);
    const value = isNum(px) && isNum(p.qty) ? px * p.qty : p.position_value;
    const pc = prevClose(sym);
    const dayPnl = isNum(pc) && isNum(px) ? (px - pc) * p.qty : null;
    const un = isNum(p.avg_cost) && isNum(px) ? (px - p.avg_cost) * p.qty : null;
    if (isNum(value)) total += value;
    if (isNum(dayPnl)) { day += dayPnl; dayKnown = true; }
    if (isNum(un)) { unreal += un; cost += p.avg_cost * p.qty; }
    rows.push({ sym, qty: p.qty, avg: p.avg_cost, px, value, dayPnl, un, unPct: isNum(un) && p.avg_cost ? (px / p.avg_cost - 1) * 100 : null,
      sector: (cfg.sector_map || {})[sym] || "Sin clasificar", sem: C.semaforo?.[sym] });
  }
  const caja = isNum(C.caja) ? C.caja : 0;
  const nav = total + caja;
  rows.forEach((r) => (r.peso = nav > 0 && isNum(r.value) ? (r.value / nav) * 100 : null));
  rows.sort((a, b) => (b.value || 0) - (a.value || 0));

  const sectores = {};
  rows.forEach((r) => (sectores[r.sector] = (sectores[r.sector] || 0) + (r.value || 0)));
  const porSector = Object.entries(sectores).map(([k, v]) => ({ k, pct: nav > 0 ? (v / nav) * 100 : 0 })).sort((a, b) => b.pct - a.pct);

  const bloquesCfg = cfg.bloques || {}, tope = cfg.tope_bloque_pct ?? 25;
  const asignado = {};
  const bloques = Object.entries(bloquesCfg).map(([nombre, miembros]) => {
    let v = 0; const quienes = [];
    for (const r of rows) {
      const f = miembros[r.sym.toUpperCase()];
      if (f && isNum(r.value)) { v += r.value * f; quienes.push(r.sym); asignado[r.sym] = true; }
    }
    return { k: nombre, pct: nav > 0 ? (v / nav) * 100 : 0, quienes, excede: nav > 0 && (v / nav) * 100 > tope };
  }).filter((b) => b.quienes.length);
  const resto = rows.filter((r) => !asignado[r.sym]).reduce((s, r) => s + (r.value || 0), 0);
  if (resto > 0) bloques.push({ k: cfg.bloque_residual || "Sin agrupar", pct: nav > 0 ? (resto / nav) * 100 : 0, residual: true, quienes: [] });
  bloques.sort((a, b) => (a.residual ? 1 : 0) - (b.residual ? 1 : 0) || b.pct - a.pct);

  const liquidezPct = nav > 0 ? (caja / nav) * 100 : null;
  const apal = nav > 0 && caja < 0 ? (-caja / nav) * 100 : 0;

  // DCLA en vivo
  const criptoSet = new Set(Object.keys(bloquesCfg["Bitcoin (exposición efectiva)"] || {}));
  const art1 = {
    sub5: rows.filter((r) => isNum(r.px) && r.px < 5).map((r) => r.sym),
    cripto: rows.filter((r) => criptoSet.has(r.sym.toUpperCase())).map((r) => r.sym),
    margen_hoy: apal > 0, margen_mtd: !!C.liquidez?.uso_margen_mtd,
  };
  const topeT = cfg.tope_ticker_pct ?? 15;
  const art3 = { tickers: rows.filter((r) => r.peso > topeT).map((r) => [r.sym, r.peso]), bloques: bloques.filter((b) => b.excede).map((b) => [b.k, b.pct]) };
  const art5 = { tactica: [], estructural: [], sin: [] };
  for (const r of rows) {
    const nt = S.M?.tickers?.[r.sym]?.niveles || {};
    const dt = nt.defensa_tactica, de = nt.defensa_estructural;
    if (!isNum(r.px) || (dt == null && de == null)) { art5.sin.push(r.sym); continue; }
    if (isNum(dt) && r.px < dt) art5.tactica.push(r.sym);
    if (isNum(de) && r.px < de) art5.estructural.push(r.sym);
  }
  const viol = art1.sub5.length + art1.cripto.length + (art1.margen_hoy ? 1 : 0) + (art1.margen_mtd ? 1 : 0) +
    art3.tickers.length + art3.bloques.length + art5.tactica.length + art5.estructural.length;

  return { rows, total, caja, nav, day: dayKnown ? day : null, dayPct: dayKnown && nav - day > 0 ? (day / (nav - day)) * 100 : null,
    unreal, unrealPct: cost > 0 ? (unreal / cost) * 100 : null, porSector, bloques, tope, liquidezPct, apal,
    dcla: { art1, art3, art5, viol }, topeT };
}

// ── Render ─────────────────────────────────────────────────────────────────
function setStatus() {
  const dot = $("#dot"), txt = $("#status-txt"), btn = $("#refresh-btn");
  btn.classList.toggle("spin", S.loadingQ);
  if (S.loadingQ) { dot.className = "dot"; txt.textContent = "Actualizando…"; return; }
  if (S.qErr || !S.qAt) { dot.className = "dot stale"; txt.textContent = S.M ? "Precios del snapshot" : "Sin datos"; return; }
  const ses = S.Q.SPY?.session;
  const lbl = { pre: "pre", regular: "abierto", post: "post", closed: "cerrado" }[ses] || "";
  dot.className = "dot live"; txt.textContent = `${fTime(S.qAt)}${lbl ? " · " + lbl : ""}`;
}

function render() {
  setStatus();
  document.body.classList.toggle("masked", S.masked);
  if (!S.M) return;
  const ban = $("#banner");
  const ageH = (Date.now() - new Date(S.M.generado).getTime()) / 3.6e6;
  const msgs = [];
  if (S.qErr) msgs.push(S.qErr);
  if (ageH > 30) msgs.push(`El cálculo diario es del ${fDate(S.M.generado)} (hace ${Math.round(ageH / 24)} días). Revisa el proceso en GitHub.`);
  ban.hidden = !msgs.length; ban.textContent = msgs.join(" ");
  renderResumen(); renderWatch(); renderCartera(); renderMacro();
  for (const v of ["resumen", "watch", "cartera", "macro"]) $("#v-" + v).hidden = S.view !== v;
  document.querySelectorAll(".tab").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.v === S.view)));
}

// Tres rangos piso–techo apilados (táctico 6m, estructural 2a, histórico 5a),
// cada uno en su propia escala, con un punto donde está el precio de ahora.
// Si el precio rompió el piso o el techo, el punto queda en el borde y hueco.
function tierBars(l) {
  if (!l.tiers) return "";
  const filas = [["tactico", "6m"], ["estructural", "2a"], ["historico", "5a"]].map(([k, lbl]) => {
    const x = l.tiers[k] || {}, p = x.piso?.precio, t = x.techo?.precio, px = l.price;
    let mk = "";
    if (isNum(p) && isNum(t) && t > p && isNum(px)) {
      const raw = (px - p) / (t - p), fuera = raw < 0 || raw > 1;
      mk = `<span class="mk${fuera ? " out" : ""}" style="left:${(Math.max(0, Math.min(1, raw)) * 100).toFixed(1)}%"></span>`;
    } else if (isNum(p) && !isNum(t)) {
      mk = `<span class="mk out" style="left:100%"></span>`;   // sin techo: precio en descubrimiento
    }
    return `<span class="tl">${lbl}</span><span class="num">${isNum(p) ? fPrice(p) : "—"}</span><div class="range${isNum(p) || isNum(t) ? "" : " off"}">${mk}</div><span class="num">${isNum(t) ? fPrice(t) : "—"}</span>`;
  }).join("");
  return `<div class="bars3">${filas}</div>`;
}

function rangeBar(rb) {
  if (!rb) return `<div class="range" style="opacity:.35"></div>`;
  return `<div class="range" title="Posición en el rango piso–techo"><span class="mk" style="left:${(rb.posicion * 100).toFixed(1)}%"></span></div>`;
}

// Equivalente en pesos con el USD/COP en vivo (Yahoo "COP=X").
function copLine(usd) {
  const q = S.Q["COP=X"], fx = q?.price;
  if (!isNum(fx) || !isNum(usd)) return "";
  const cop = usd * fx, txt = Math.abs(cop) >= 1e9 ? `${nf(2).format(cop / 1e9)} mil millones` : `${nf(1).format(cop / 1e6)} millones`;
  return `<div class="sub num" style="margin-top:2px"><span class="amt">≈ $${txt} COP</span> · dólar $${nf(0).format(fx)} <span class="${cls(q.chgPct)}">${fPct(q.chgPct, 2)}</span></div>`;
}

function renderResumen() {
  const el = $("#v-resumen");
  const P = portfolio();
  const parts = [];

  if (P) {
    parts.push(`<div class="card hero">
      <div><div class="label">Valor de la cartera</div><div class="big num">${fUsd(P.nav)}</div>${copLine(P.nav)}</div>
      <div class="grid3">
        <div class="kv"><div class="k">Hoy</div><div class="v num ${cls(P.day)}">${fUsd(P.day, { sign: true })}<div class="sub num ${cls(P.dayPct)}">${fPct(P.dayPct, 2)}</div></div></div>
        <div class="kv"><div class="k">No realizado</div><div class="v num ${cls(P.unreal)}">${fUsd(P.unreal, { sign: true })}<div class="sub num ${cls(P.unrealPct)}">${fPct(P.unrealPct, 1)}</div></div></div>
        <div class="kv"><div class="k">Liquidez</div><div class="v num">${fPct(P.liquidezPct, 1, false)}<div class="sub">${P.dcla.viol ? `<span class="pill rojo">${P.dcla.viol} alerta${P.dcla.viol > 1 ? "s" : ""} DCLA</span>` : `<span class="pill verde">DCLA ok</span>`}</div></div></div>
      </div></div>`);
  }

  // Alertas de cruce en vivo
  const alertas = allTickers().map((t) => ({ t, L: liveLevels(t) })).filter((x) => x.L.alerta);
  const own = new Set(Object.keys(S.C?.posiciones || {}));
  alertas.sort((a, b) => (own.has(b.t) - own.has(a.t)) || (a.L.alertaTipo === "piso" ? -1 : 1));
  parts.push(`<h2>Alertas en vivo</h2><div class="card">${alertas.length ? `<ul class="list">${alertas.map(({ t, L }) =>
    `<li><span class="ic">${L.alertaTipo === "piso" ? "▼" : "▲"}</span><span><a href="#" data-t="${esc(t)}" style="text-decoration:none"><strong>${esc(disp(t))}</strong></a>${own.has(t) ? ' <span class="own" style="display:inline-block;vertical-align:middle"></span>' : ""} ${esc(L.alerta)}.</span></li>`).join("")}</ul>`
    : `<div class="sub">Ningún ticker está a menos de 2% de su piso o techo con el precio de ahora.</div>`}</div>`);

  // Briefing del cálculo diario
  const b = S.M.briefing || {};
  const items = [
    ...(b.acciones || []).map((x) => ["⚠️", x]), ...(b.cambios || []).map((x) => ["↻", x]),
    ...(b.foto_inicial || []).map((x) => ["•", x]), ...(b.contexto || []).map((x) => ["◎", x]),
  ];
  parts.push(`<h2>Resumen del día · ${fDate(S.M.generado)}</h2><div class="card">${items.length ? `<ul class="list">${items.map(([i, x]) => `<li><span class="ic">${i}</span><span>${safeRich(x)}</span></li>`).join("")}</ul>` : `<div class="sub">Sin cambios de señal desde el cálculo anterior.</div>`}</div>`);

  // Top 5
  const { compra, venta } = topOportunidades(5);
  const rk = (arr, kind) => arr.length ? arr.map((c, i) => `<div class="r" data-t="${esc(c.t)}" role="button" tabindex="0">
      <span class="n num">${i + 1}</span><span class="t">${esc(disp(c.t))}</span>
      <span>${rangeBar(c.L.rb)}</span>
      <span class="num" style="font-size:12.5px">${kind === "c" ? "R:B " + fRatio(c.L.rb) : nf(0).format(c.L.rb.posicion * 100) + "%"}</span></div>`).join("")
    : `<div class="sub">Sin candidatos genuinos ahora.</div>`;
  parts.push(`<h2>Top 5 con el precio de ahora</h2><div class="duo">
    <div class="card"><div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px"><strong>Comprar · cerca del piso</strong><span class="pill verde">entrada</span></div><div class="rank">${rk(compra, "c")}</div></div>
    <div class="card"><div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px"><strong>Vender · cerca del techo</strong><span class="pill rojo">utilidad</span></div><div class="rank">${rk(venta, "v")}</div></div></div>`);

  // Próximos earnings
  const ev = (S.M.proximos_eventos || []).map((e) => ({ ...e, d: daysUntil(e.fecha) })).filter((e) => e.d !== null && e.d >= 0 && e.d <= 21);
  parts.push(`<h2>Earnings próximos 3 semanas</h2><div class="card">${ev.length ? `<table><tbody>${ev.map((e) => {
    const ai = S.M.tickers[e.ticker]?.earnings || {};
    const peso = P?.rows.find((r) => r.sym === e.ticker)?.peso;
    return `<tr data-t="${esc(e.ticker)}" style="cursor:pointer"><td><strong>${esc(disp(e.ticker))}</strong>${own.has(e.ticker) ? ` <span class="sub num">${fPct(peso, 1, false)} cartera</span>` : ""}</td>
      <td>${fDate(e.fecha)}</td><td class="r sub">${e.d === 0 ? "hoy" : e.d === 1 ? "mañana" : "en " + e.d + " días"}</td>
      <td class="r">${ai.tendencia_revisiones ? `<span class="pill ${ai.tendencia_revisiones === "subiendo" ? "verde" : ai.tendencia_revisiones === "bajando" ? "rojo" : "neutro"}">rev. ${esc(ai.tendencia_revisiones)}</span>` : ""}</td></tr>`;
  }).join("")}</tbody></table>` : `<div class="sub">Ninguno del watchlist reporta en las próximas 3 semanas.</div>`}</div>`);

  parts.push(`<div class="foot">Cálculo diario: ${fDate(S.M.generado)} ${fTime(new Date(S.M.generado).getTime())} · Precios: ${S.qAt ? fTime(S.qAt) : "snapshot"}</div>`);
  el.innerHTML = parts.join("");
}

const disp = (t) => S.M?.tickers?.[t]?.display || t;

function renderWatch() {
  const el = $("#v-watch");
  const own = new Set(Object.keys(S.C?.posiciones || {}));
  const ts = allTickers();
  const sectores = ["Todos", "En cartera", ...new Set(ts.map((t) => S.M.tickers[t].sector))];
  let list = ts.filter((t) => S.sector === "Todos" || (S.sector === "En cartera" ? own.has(t) : S.M.tickers[t].sector === S.sector));
  const L = Object.fromEntries(list.map((t) => [t, liveLevels(t)]));
  const ord = { sector: null, dia: (t) => -(liveChg(t) ?? -1e9), rango: (t) => L[t].rb ? L[t].rb.posicion : 2 };
  if (S.sort === "sector") list.sort((a, b) => (S.M.tickers[a].tipo === "cripto" ? -1 : 0) - (S.M.tickers[b].tipo === "cripto" ? -1 : 0) || S.M.tickers[a].sector.localeCompare(S.M.tickers[b].sector) || a.localeCompare(b));
  else list.sort((a, b) => ord[S.sort](a) - ord[S.sort](b));

  const rows = list.map((t) => {
    const info = S.M.tickers[t], l = L[t], ch = liveChg(t);
    return `<button class="row" data-t="${esc(t)}" type="button">
      <div style="min-width:0"><div class="tk">${esc(disp(t))}${own.has(t) ? '<span class="own" title="En tu cartera"></span>' : ""}
        ${l.nt?.veredicto ? `<span class="pill ${verClass(l.nt.veredicto)}">${esc(l.nt.veredicto)}</span>` : ""}</div>
        <div class="nm">${esc(info.nombre)}</div></div>
      <div><div class="px num">${fPrice(l.price)}</div><div class="ch num ${cls(ch)}">${fPct(ch, 2)}</div></div>
      ${tierBars(l)}
      ${l.alerta ? `<div class="alert-tag" style="grid-column:1/-1">${esc(l.alerta)}</div>` : ""}
    </button>`;
  }).join("");

  const heat = (ch) => {
    if (!isNum(ch)) return "background:var(--sunk)";
    const k = Math.round(10 + Math.min(Math.abs(ch) / 6, 1) * 62);
    return `background:color-mix(in srgb, ${ch >= 0 ? "var(--up)" : "var(--down)"} ${k}%, var(--surface))${k > 42 ? ";color:#fff" : ""}`;
  };
  const tiles = list.map((t) => {
    const ch = liveChg(t), l = L[t];
    return `<button class="tile" data-t="${esc(t)}" type="button" style="${heat(ch)}" aria-label="${esc(disp(t))} ${fPct(ch, 2)}">
      <span class="tt">${esc(disp(t))}${own.has(t) ? '<span class="own"></span>' : ""}</span>
      <span class="num tp">${fPrice(l.price)}</span><span class="num tc">${fPct(ch, 2)}</span></button>`;
  }).join("");
  const sube = list.filter((t) => liveChg(t) > 0).length, baja = list.filter((t) => liveChg(t) < 0).length;

  el.innerHTML = `
    <div class="toolbar" role="group" aria-label="Vista">${[["lista", "Lista"], ["mapa", "Mapa de calor"]].map(([k, l]) => `<button class="chip" data-wmode="${k}" aria-pressed="${S.wmode === k}">${l}</button>`).join("")}
      ${S.C ? `<button class="chip chip-edit" type="button" data-wl-edit><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>Editar títulos</button>` : ""}</div>
    <div class="toolbar" role="group" aria-label="Filtrar">${sectores.map((s) => `<button class="chip" data-sector="${esc(s)}" aria-pressed="${S.sector === s}">${esc(s)}</button>`).join("")}</div>
    <div class="toolbar" role="group" aria-label="Ordenar">${[["sector", "Por sector"], ["dia", "Mayor % hoy"], ["rango", "Más cerca del piso"]].map(([k, l]) => `<button class="chip" data-sort="${k}" aria-pressed="${S.sort === k}">${l}</button>`).join("")}</div>
    ${S.wmode === "mapa"
      ? `${list.length ? `<div class="sub" style="margin:0 2px"><span class="up">▲ ${sube} suben</span> · <span class="down">▼ ${baja} bajan</span> hoy</div><div class="heat">${tiles}</div>` : `<div class="card empty">Sin tickers en este filtro.</div>`}
         <div class="foot">Color por el % del día: más intenso, mayor movimiento (tope ±6%). Punto dorado: en tu cartera. Toca un cuadro para ver la ficha.</div>`
      : `<div class="card flush">${rows || `<div class="empty">Sin tickers en este filtro.</div>`}</div>
    <div class="foot">Barras: piso y techo por volumen a 6 meses, 2 años y 5 años; el punto es el precio de ahora. Punto hueco: el precio rompió ese rango.</div>`}`;
}

function hbar(lbl, pct, tope, over) {
  const w = Math.max(0, Math.min(100, pct || 0));
  return `<div class="hbar"><span class="lbl">${esc(lbl)}</span><span class="track"><span class="fill${over ? " over" : ""}" style="width:${w}%"></span>${tope ? `<span class="cap" style="left:${Math.min(100, tope)}%"></span>` : ""}</span><span class="num" style="text-align:right">${fPct(pct, 1, false)}</span></div>`;
}

function renderCartera() {
  const el = $("#v-cartera");
  const P = portfolio();
  if (!P) { el.innerHTML = `<div class="card empty">Todavía no hay datos de tu cuenta IBKR. Aparecen después del primer cálculo diario con el Flex Query activo.</div>`; return; }
  const C = S.C;
  const pnlT = C.pnl_total || {};
  const posRows = P.rows.map((r) => `<tr data-t="${esc(r.sym)}" style="cursor:pointer">
      <td><button type="button" class="tk-link" data-t="${esc(r.sym)}" aria-label="Ver análisis completo de ${esc(disp(r.sym))}">${esc(disp(r.sym))}<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg></button>${r.sem ? ` <span class="pill ${semClass(r.sem.estado)}" title="${esc((r.sem.razones || []).join(" · "))}">${esc(r.sem.estado)}</span>` : ""}<div class="sub num"><span class="amt">${nf(r.qty % 1 ? 2 : 0).format(r.qty)}</span> × ${fPrice(r.px)}</div></td>
      <td class="r num">${fUsd(r.value)}<div class="sub">${fPct(r.peso, 1, false)}</div></td>
      <td class="r num ${cls(r.dayPnl)}">${fUsd(r.dayPnl, { sign: true })}</td>
      <td class="r num ${cls(r.un)}">${fUsd(r.un, { sign: true })}<div class="sub ${cls(r.unPct)}">${fPct(r.unPct, 1)}</div></td></tr>`).join("");
  const sem = Object.entries(C.semaforo || {}).filter(([, v]) => v && v.estado !== "VERDE");
  const d = P.dcla;
  const dl = (arr) => (arr.length ? arr.map((x) => (Array.isArray(x) ? `${esc(disp(x[0]))} ${fPct(x[1], 1, false)}` : esc(disp(x)))).join(", ") : "—");
  const trades = (C.trades_recientes || []).slice(0, 10);

  el.innerHTML = `
    <div class="card hero">
      <div><div class="label">Valor de la cartera (precios de ahora)</div><div class="big num">${fUsd(P.nav)}</div></div>
      <div class="grid3">
        <div class="kv"><div class="k">Invertido</div><div class="v num">${fUsd(P.total)}</div></div>
        <div class="kv"><div class="k">Caja</div><div class="v num ${cls(P.caja)}">${fUsd(P.caja)}</div></div>
        <div class="kv"><div class="k">P&L realizado</div><div class="v num ${cls(pnlT.realizado_total)}">${fUsd(pnlT.realizado_total, { sign: true })}</div></div>
      </div>
    </div>
    <h2>Posiciones</h2>
    <div class="card flush tbl-wrap"><table><thead><tr><th>Ticker</th><th class="r">Valor · peso</th><th class="r">Hoy</th><th class="r">No realizado</th></tr></thead><tbody>${posRows}</tbody></table></div>

    <h2>Constitución DCLA · en vivo</h2>
    <div class="card"><table><tbody>
      <tr><td>Art. I · acciones bajo $5</td><td class="r">${dl(d.art1.sub5)}</td></tr>
      <tr><td>Art. I · cripto / proxies</td><td class="r">${dl(d.art1.cripto)}</td></tr>
      <tr><td>Art. I · margen hoy / este mes</td><td class="r">${d.art1.margen_hoy ? '<span class="pill rojo">hoy</span>' : "no"} · ${d.art1.margen_mtd ? '<span class="pill amarillo">este mes</span>' : "no"}</td></tr>
      <tr><td>Art. III · tickers sobre ${P.topeT}%</td><td class="r">${dl(d.art3.tickers)}</td></tr>
      <tr><td>Art. III · bloques sobre ${P.tope}%</td><td class="r">${dl(d.art3.bloques)}</td></tr>
      <tr><td>Art. V · rompió defensa táctica</td><td class="r">${dl(d.art5.tactica)}</td></tr>
      <tr><td>Art. V · rompió defensa estructural</td><td class="r">${dl(d.art5.estructural)}</td></tr>
    </tbody></table>
    <div class="sub" style="margin-top:8px">${d.viol ? `${d.viol} punto${d.viol > 1 ? "s" : ""} a revisar.` : "Sin violaciones con los precios de ahora."}${d.art5.sin.length ? ` Sin niveles para: ${dl(d.art5.sin)}.` : ""}</div></div>

    <h2>Semáforo Pilar 4</h2>
    <div class="card">${sem.length ? `<ul class="list">${sem.map(([s, v]) => `<li><span class="ic"><span class="pill ${semClass(v.estado)}" style="padding:0 5px">●</span></span><span><strong>${esc(disp(s))}</strong> · ${esc(v.estado)} — ${esc((v.razones || []).join("; ") || `${v.compras_sin_ganancia} compras sin ganancia`)}</span></li>`).join("")}</ul>` : `<div class="sub">Todas las posiciones en verde.</div>`}</div>

    <h2>Concentración por bloque de riesgo</h2>
    <div class="card">${P.bloques.map((b) => hbar(b.k + (b.quienes.length ? ` (${b.quienes.map(disp).join(", ")})` : ""), b.pct, b.residual ? null : P.tope, b.excede)).join("")}
      <div class="sub" style="margin-top:6px">Línea vertical: tope de ${P.tope}% por bloque.</div></div>

    <h2>Concentración por sector</h2>
    <div class="card">${P.porSector.map((s) => hbar(s.k, s.pct, S.M.config?.tope_sector_pct, s.pct > (S.M.config?.tope_sector_pct ?? 50))).join("")}</div>

    <h2>Liquidez y margen</h2>
    <div class="card metrics">
      <div class="metric"><div class="k">Liquidez</div><div class="v num">${fPct(P.liquidezPct, 1, false)}</div><div class="sub">objetivo ${S.M.config?.objetivo_liquidez_pct ?? 15}%</div></div>
      <div class="metric"><div class="k">Apalancamiento</div><div class="v num ${P.apal > 0 ? "down" : ""}">${fPct(P.apal, 1, false)}</div><div class="sub">tope ${S.M.config?.tope_apalancamiento_pct ?? 20}%</div></div>
      <div class="metric"><div class="k">Interés margen (mes)</div><div class="v num">${fUsd(C.liquidez?.interes_pagado_mtd)}</div></div>
    </div>

    ${trades.length ? `<h2>Movimientos recientes</h2><div class="card flush tbl-wrap"><table><thead><tr><th>Fecha</th><th>Ticker</th><th>Op.</th><th class="r">Cant.</th><th class="r">Precio</th></tr></thead><tbody>
      ${trades.map((t) => `<tr><td class="num">${esc(String(t.date || "").slice(0, 10))}</td><td><strong>${esc(t.symbol)}</strong></td><td><span class="pill ${t.side === "BUY" ? "verde" : "rojo"}">${t.side === "BUY" ? "compra" : "venta"}</span></td><td class="r num"><span class="amt">${nf(2).format(t.qty || 0)}</span></td><td class="r num">${fPrice(t.price)}</td></tr>`).join("")}
    </tbody></table></div>` : ""}
    <div class="foot">Posiciones y caja del Flex Query de IBKR (${fDate(C.generado)}); valores recalculados con precios de ahora.</div>`;
}

function renderMacro() {
  const el = $("#v-macro");
  const m = S.M.macro || {};
  const live = [["SPY", "S&P 500 (SPY)"], ["QQQ", "Nasdaq 100 (QQQ)"], ["^VIX", "VIX"], ["^TNX", "Bono 10 años"], ["DX-Y.NYB", "Índice dólar"], ["COP=X", "Dólar (USD/COP)"], ["BTC-USD", "Bitcoin"]];
  const tiles = live.map(([s, n]) => {
    const q = S.Q[s];
    const v = q?.price; const ch = q?.chgPct;
    const val = s === "^TNX" ? (isNum(v) ? nf(2).format(v) + "%" : "—") : s === "^VIX" || s === "DX-Y.NYB" ? (isNum(v) ? nf(2).format(v) : "—") : s === "COP=X" ? (isNum(v) ? "$" + nf(0).format(v) : "—") : fPrice(v);
    return `<div class="metric"><div class="k">${n}</div><div class="v num">${val}</div><div class="sub num ${s === "^VIX" || s === "^TNX" ? cls(-ch) : cls(ch)}">${fPct(ch, 2)}</div></div>`;
  }).join("");
  const reg = m.regimen;
  el.innerHTML = `
    <h2>Mercado ahora</h2><div class="card metrics">${tiles}</div>
    <h2>Régimen macro · ${fDate(S.M.generado)}</h2>
    <div class="card stack">
      <div><span class="pill ${reg === "risk-on" ? "verde" : reg === "risk-off" ? "rojo" : "neutro"}" style="font-size:13px;padding:4px 10px">${esc(reg || "sin dato")}</span>
        ${isNum(m.regimen_score) ? `<span class="sub num" style="margin-left:6px">puntaje ${nf(0).format(m.regimen_score)}</span>` : ""}</div>
      ${(m.regimen_detalle || []).length ? `<ul class="list">${m.regimen_detalle.map((x) => `<li><span class="ic">·</span><span>${esc(typeof x === "string" ? x : JSON.stringify(x))}</span></li>`).join("")}</ul>` : ""}
    </div>
    <div class="card metrics">
      <div class="metric"><div class="k">Tesoro 10 años</div><div class="v num">${isNum(m.treasury_10y) ? nf(2).format(m.treasury_10y) + "%" : "—"}</div><div class="sub num">${isNum(m.treasury_10y_delta) ? (m.treasury_10y_delta >= 0 ? "+" : "−") + nf(0).format(Math.abs(m.treasury_10y_delta * 100)) + " pb" : ""}</div></div>
      <div class="metric"><div class="k">Fed funds</div><div class="v num">${isNum(m.fed_funds) ? nf(2).format(m.fed_funds) + "%" : "—"}</div></div>
      <div class="metric"><div class="k">Inflación (CPI a/a)</div><div class="v num">${isNum(m.cpi_yoy) ? nf(1).format(m.cpi_yoy) + "%" : "—"}</div></div>
      <div class="metric"><div class="k">Tasa real</div><div class="v num">${isNum(m.tasa_real) ? nf(2).format(m.tasa_real) + "%" : "—"}</div></div>
      <div class="metric"><div class="k">Nasdaq vs media 200</div><div class="v num ${cls(m.nasdaq_vs_ma200)}">${fPct(m.nasdaq_vs_ma200, 1)}</div></div>
      <div class="metric"><div class="k">Dólar (DXY) 1 mes</div><div class="v num ${cls(m.dxy_delta_1m)}">${fPct(m.dxy_delta_1m, 1)}</div></div>
    </div>
    <div class="foot">Datos macro de Alpha Vantage y yfinance, del cálculo diario.</div>`;
}

// ── Ficha de ticker ───────────────────────────────────────────────────────
function sparkSvg(arr, price) {
  const pts = (arr || []).filter(isNum).slice();
  if (isNum(price) && pts.length) pts.push(price);
  if (pts.length < 2) return "";
  const W = 320, H = 56, mn = Math.min(...pts), mx = Math.max(...pts), rg = mx - mn || 1;
  const xy = pts.map((v, i) => [(i / (pts.length - 1)) * (W - 4) + 2, H - 4 - ((v - mn) / rg) * (H - 8)]);
  const up = pts[pts.length - 1] >= pts[0];
  const line = xy.map((p) => p.map((n) => n.toFixed(1)).join(",")).join(" ");
  const col = up ? "var(--up)" : "var(--down)";
  const last = xy[xy.length - 1];
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="Precio último año">
    <polygon points="2,${H} ${line} ${W - 2},${H}" fill="${col}" opacity=".12"/>
    <polyline points="${line}" fill="none" stroke="${col}" stroke-width="1.6" vector-effect="non-scaling-stroke"/>
    <circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="3" fill="${col}"/></svg>`;
}

function openSheet(t) {
  const info = S.M.tickers[t]; if (!info) return;
  const L = liveLevels(t), ch = liveChg(t), ret = periodReturns(t);
  const nt = L.nt || {}, f = info.fundamentales || {}, e = info.earnings || {};
  const pos = S.C?.posiciones?.[t];
  const P = pos ? portfolio() : null;
  const pr = P?.rows.find((r) => r.sym === t);
  const upside = isNum(f.precio_objetivo) && isNum(L.price) ? (f.precio_objetivo / L.price - 1) * 100 : null;
  const tiersRows = L.tiers ? ["tactico", "estructural", "historico"].map((k) => {
    const x = L.tiers[k] || {}, rb = x.rbLive;
    return `<tr><td>${TIER_NAME[k]}</td><td class="r num">${x.piso ? fPrice(x.piso.precio) : "—"}</td><td class="r num">${x.techo ? fPrice(x.techo.precio) : "—"}</td>
      <td class="r num">${fRatio(rb)}</td><td class="r">${rb ? `<span class="pill ${semClass(rb.semaforo)}">${nf(0).format(rb.posicion * 100)}%</span>` : "—"}</td></tr>`;
  }).join("") : "";
  const fr = nt.fuerza_relativa_multi || {};
  const sem = S.C?.semaforo?.[t];

  $("#sheet").innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(disp(t))}">
    <div class="grab"></div>
    <div class="sheet-head"><div><h3>${esc(disp(t))}</h3><div class="sub">${esc(info.nombre)} · ${esc(info.sector)}</div></div>
      <button class="icon-btn x" type="button" data-close aria-label="Cerrar"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>
    <div class="stack">
      <div class="card">
        <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap"><span class="num" style="font-size:30px;font-weight:600">${fPrice(L.price)}</span>
          <span class="num ${cls(ch)}" style="font-weight:600">${fPct(ch, 2)}</span>
          ${S.Q[t]?.session && S.Q[t].session !== "regular" ? `<span class="pill neutro">${esc({ pre: "pre-mercado", post: "post-mercado", closed: "cerrado" }[S.Q[t].session] || "")}</span>` : ""}</div>
        ${sparkSvg(info.spark, L.price)}
        <div class="metrics" style="margin-top:6px">${[["1 sem", ret["1w"]], ["1 mes", ret["1m"]], ["3 meses", ret["3m"]], ["1 año", ret["1y"]]].map(([k, v]) => `<div class="metric"><div class="k">${k}</div><div class="v num ${cls(v)}">${fPct(v, 1)}</div></div>`).join("")}</div>
      </div>
      ${L.alerta ? `<div class="banner">${esc(disp(t))} ${esc(L.alerta)}.</div>` : ""}
      ${pr ? `<div class="card"><strong>Tu posición</strong>${sem ? ` <span class="pill ${semClass(sem.estado)}">Pilar 4 ${esc(sem.estado)}</span>` : ""}
        <div class="metrics" style="margin-top:8px">
          <div class="metric"><div class="k">Cantidad</div><div class="v num"><span class="amt">${nf(pr.qty % 1 ? 2 : 0).format(pr.qty)}</span></div></div>
          <div class="metric"><div class="k">Costo promedio</div><div class="v num">${fPrice(pr.avg)}</div></div>
          <div class="metric"><div class="k">Valor · peso</div><div class="v num">${fUsd(pr.value)} <span class="sub">${fPct(pr.peso, 1, false)}</span></div></div>
          <div class="metric"><div class="k">No realizado</div><div class="v num ${cls(pr.un)}">${fUsd(pr.un, { sign: true })} <span class="sub">${fPct(pr.unPct, 1)}</span></div></div>
        </div>${sem?.razones?.length ? `<div class="sub" style="margin-top:6px">${esc(sem.razones.join(" · "))}</div>` : ""}</div>` : ""}
      ${L.tiers ? `<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap"><strong>Niveles por volumen</strong>
          ${nt.veredicto ? `<span class="pill ${verClass(nt.veredicto)}">${esc(nt.veredicto)}</span>` : ""}</div>
        <div class="tbl-wrap" style="margin-top:6px"><table><thead><tr><th>Horizonte</th><th class="r">Piso</th><th class="r">Techo</th><th class="r">R:B</th><th class="r">Rango</th></tr></thead><tbody>${tiersRows}</tbody></table></div>
        <div class="metrics" style="margin-top:10px">
          <div class="metric"><div class="k">Defensa táctica</div><div class="v num ${isNum(nt.defensa_tactica) && L.price < nt.defensa_tactica ? "down" : ""}">${fPrice(nt.defensa_tactica)}</div></div>
          <div class="metric"><div class="k">Defensa estructural</div><div class="v num ${isNum(nt.defensa_estructural) && L.price < nt.defensa_estructural ? "down" : ""}">${fPrice(nt.defensa_estructural)}</div></div>
          <div class="metric"><div class="k">Volatilidad anual</div><div class="v num">${fPct(nt.vol_anual_pct, 0, false)}</div></div>
          <div class="metric"><div class="k">Revisión sugerida</div><div class="v">${esc(nt.frecuencia_revision || "—")}</div></div>
        </div>
        ${(nt.escalas_entrada || []).length ? `<div class="sub" style="margin-top:10px"><strong>Entrada por tramos:</strong> ${nt.escalas_entrada.map((x) => `${fPrice(x.precio)} (${x.pct_tramo}%)`).join(" · ")}</div>` : ""}
        ${(nt.escalas_salida || []).length ? `<div class="sub" style="margin-top:4px"><strong>Salida por tramos:</strong> ${nt.escalas_salida.map((x) => `${fPrice(x.precio)} (${x.pct_tramo}%)`).join(" · ")}</div>` : `<div class="sub" style="margin-top:4px">Sin techo en ningún horizonte (precio en descubrimiento): usar trailing stop.</div>`}
      </div>` : `<div class="card sub">Sin niveles técnicos para este ticker${nt.error ? ` (${esc(nt.error)})` : ""}.</div>`}
      ${Object.keys(f).length ? `<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap"><strong>Valuación y analistas</strong>
          ${f.calidad?.label ? `<span class="pill ${f.calidad.label === "Alta" ? "verde" : f.calidad.label === "Baja" ? "rojo" : "amarillo"}">Calidad ${esc(f.calidad.label)}</span>` : ""}</div>
        <div class="metrics" style="margin-top:8px">
          <div class="metric"><div class="k">P/E</div><div class="v num">${f.per_negativo_o_sin_dato ? "n/a" : nf(1).format(f.per)}</div></div>
          <div class="metric"><div class="k">P/E futuro</div><div class="v num">${isNum(f.forward_pe) ? nf(1).format(f.forward_pe) : "—"}</div></div>
          <div class="metric"><div class="k">PEG</div><div class="v num">${isNum(f.peg) ? nf(2).format(f.peg) : "—"}</div></div>
          <div class="metric"><div class="k">ROE</div><div class="v num">${fPct(f.roe_pct, 0, false)}</div></div>
          <div class="metric"><div class="k">Margen operativo</div><div class="v num">${fPct(f.margen_operativo_pct, 0, false)}</div></div>
          <div class="metric"><div class="k">Ingresos a/a</div><div class="v num ${cls(f.crec_ingresos_yoy_pct)}">${fPct(f.crec_ingresos_yoy_pct, 0)}</div></div>
          <div class="metric"><div class="k">Consenso</div><div class="v">${esc(f.consenso || "—")} <span class="sub">${f.total_analistas ? f.total_analistas + " anal." : ""}</span></div></div>
          <div class="metric"><div class="k">Precio objetivo</div><div class="v num">${fPrice(f.precio_objetivo)} <span class="sub ${cls(upside)}">${fPct(upside, 0)}</span></div></div>
        </div>${f.dato_stale ? `<div class="sub" style="margin-top:6px">Dato de hace ${f.dato_edad_dias} días.</div>` : ""}</div>` : ""}
      ${e.fecha || info.siguiente_call ? `<div class="card"><strong>Earnings</strong><div class="metrics" style="margin-top:8px">
          <div class="metric"><div class="k">Próximo</div><div class="v">${fDate(e.fecha || (S.M.proximos_eventos || []).find((x) => x.ticker === t)?.fecha, true)}</div></div>
          <div class="metric"><div class="k">EPS estimado</div><div class="v num">${isNum(e.eps_estimado) ? nf(2).format(e.eps_estimado) : "—"}</div></div>
          <div class="metric"><div class="k">Revisiones 30d</div><div class="v">${esc(e.tendencia_revisiones || "—")}</div></div>
          <div class="metric"><div class="k">Siguiente call</div><div class="v">${fDate(info.siguiente_call, true)}</div></div></div></div>` : ""}
      <div id="eps-slot" class="stack" data-eps="${esc(t)}"><div class="card sub">Cargando EPS…</div></div>
      ${Object.values(fr).some(Boolean) ? `<div class="card"><strong>Fuerza relativa</strong><ul class="list" style="margin-top:8px">${["SPY", "QQQ", "BTC"].filter((k) => fr[k]).map((k) => `<li><span class="ic num" style="font-size:11px">${k}</span><span>${esc(fr[k].texto)}</span></li>`).join("")}</ul></div>` : ""}
      ${info.noticia?.titulo ? `<div class="card"><strong>Última noticia</strong><div style="margin-top:6px">${info.noticia.url ? `<a href="${esc(info.noticia.url)}" target="_blank" rel="noopener">${esc(info.noticia.titulo)}</a>` : esc(info.noticia.titulo)}</div></div>` : ""}
    </div></div>`;
  $("#sheet").hidden = false;
  document.body.style.overflow = "hidden";
  loadEps(t);
}
// ── EPS trimestral (tabla inv_eps, la llena eps_sync.py) ──────────────────
const MES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const qLbl = (iso) => { const [y, m] = String(iso).split("-"); return `${MES[+m - 1]} ${y.slice(2)}`; };
const fEps = (v) => (isNum(v) ? (Math.abs(v) < 1 ? nf(3) : nf(2)).format(v) : "—");

function epsChart(hist, proyT, simple = false) {
  const real = hist.slice().reverse();                 // viejo → nuevo
  const items = [...real.map((r) => ({ fin: r[0], v: r[2], est: r[3], p: false })),
                 ...proyT.map((x) => ({ fin: x.fin, v: x.eps, est: null, p: true, lo: x.bajo, hi: x.alto }))];
  if (items.length < 2) return "";
  const W = 320, H = 132, padB = 16, padT = 14;
  const vals = items.flatMap((i) => [i.v, i.est, i.hi, i.lo]).filter(isNum);
  const mx = Math.max(0, ...vals), mn = Math.min(0, ...vals), rg = mx - mn || 1;
  const y = (v) => padT + (mx - v) / rg * (H - padB - padT);
  const bw = (W - 4) / items.length, gap = Math.max(1, bw * 0.22);
  const y0 = y(0);
  let out = `<line x1="0" x2="${W}" y1="${y0.toFixed(1)}" y2="${y0.toFixed(1)}" stroke="var(--line)"/>`;
  let lastYear = "";
  items.forEach((it, i) => {
    const x = 2 + i * bw + gap / 2, w = bw - gap, top = y(Math.max(it.v, 0)), bot = y(Math.min(it.v, 0));
    const h = Math.max(1, bot - top);
    const beat = isNum(it.est) ? it.v >= it.est : null;
    const fill = it.p ? "none" : it.v < 0 ? "var(--down)" : "var(--brass)";
    out += `<rect x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="1.5" fill="${fill}"
      ${it.p ? `stroke="var(--brass)" stroke-dasharray="3 2" stroke-width="1.2"` : `opacity="${beat === false ? 0.55 : 1}"`}>
      <title>${qLbl(it.fin)} · ${it.p ? "proyectado" : "real"} ${fEps(it.v)}${isNum(it.est) ? ` · estimado ${fEps(it.est)}` : ""}</title></rect>`;
    if (isNum(it.est)) out += `<line x1="${(x - 1).toFixed(1)}" x2="${(x + w + 1).toFixed(1)}" y1="${y(it.est).toFixed(1)}" y2="${y(it.est).toFixed(1)}" stroke="var(--ink)" stroke-width="1.4" opacity=".7"/>`;
    const yr = it.fin.slice(0, 4);
    if (yr !== lastYear && x < W - 26) { lastYear = yr; out += `<text x="${x.toFixed(1)}" y="${H - 3}" font-size="9" fill="var(--muted)" font-family="var(--f-num)">${yr}</text>`; }
  });
  const last = items.length - 1, it = items[last], lx = 2 + last * bw + bw - gap / 2;
  const ly = it.v >= 0 ? y(Math.max(it.v, it.hi ?? it.v)) - 3 : Math.min(H - padB - 2, y(Math.min(it.v, it.lo ?? it.v)) + 10);
  out += `<text x="${Math.min(W - 1, lx).toFixed(1)}" y="${Math.max(9, ly).toFixed(1)}" font-size="9.5" text-anchor="end" fill="var(--ink)" font-family="var(--f-num)">${fEps(it.v)}</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;margin-top:8px" role="img" aria-label="${simple ? "Flujo de caja libre por acción por trimestre" : "EPS por trimestre desde 2020: barras llenas real, punteadas proyectado, raya estimado"}">${out}</svg>
    <div class="sub" style="display:flex;gap:12px;flex-wrap:wrap;margin-top:4px">
      <span><span style="display:inline-block;width:9px;height:9px;background:var(--brass);border-radius:2px"></span> Real</span>
      <span><span style="display:inline-block;width:9px;height:9px;border:1.2px dashed var(--brass);border-radius:2px"></span> Proyectado</span>
      ${simple ? "" : `<span><span style="display:inline-block;width:12px;height:2px;background:var(--ink);opacity:.7;vertical-align:middle"></span> Estimado</span>
      <span>Atenuada = no superó el estimado</span>`}</div>`;
}

function epsCardHtml(t, row) {
  if (!row) return `<div class="card"><strong>EPS por trimestre</strong><div class="sub" style="margin-top:6px">Todavía sin histórico de EPS para este ticker. Se carga en las próximas corridas diarias.</div></div>`;
  const hist = row.hist || [], proy = row.proy || [];
  if (!hist.length && !proy.length) return `<div class="card"><strong>EPS por trimestre</strong><div class="sub" style="margin-top:6px">Alpha Vantage no tiene EPS para este ticker.</div></div>`;
  const proyT = proy.filter((x) => x.periodo === "T"), proyA = proy.filter((x) => x.periodo === "A");
  const ttm = hist.length >= 4 ? hist.slice(0, 4).reduce((a, r) => a + r[2], 0) : null;
  const yoy = hist.length >= 5 && hist[4][2] > 0 ? (hist[0][2] / hist[4][2] - 1) * 100 : null;
  const ult8 = hist.slice(0, 8).filter((r) => isNum(r[3]));
  const beats = ult8.filter((r) => r[2] >= r[3]).length;
  const price = livePrice(t);
  const fy = proyA[0];
  const peF = fy && isNum(price) && fy.eps > 0 ? price / fy.eps : null;
  const peT = isNum(ttm) && ttm > 0 && isNum(price) ? price / ttm : null;
  const rev = (x) => { if (!isNum(x.prev30) || !x.prev30) return ""; const d = (x.eps - x.prev30) / Math.abs(x.prev30) * 100;
    return `<span class="sub ${cls(d)}">${Math.abs(d) < 0.05 ? "sin cambio" : fPct(d, 1)} 30d</span>`; };
  const s0 = hist[0];
  const sorpresa = s0 && isNum(s0[3]) && s0[3] !== 0 ? (s0[2] / s0[3] - 1) * 100 * Math.sign(s0[3]) : null;
  const filas = hist.map((r) => { const sp = isNum(r[3]) && r[3] !== 0 ? (r[2] / r[3] - 1) * 100 * Math.sign(r[3]) : null;
    return `<tr><td>${qLbl(r[0])}</td><td class="r num">${fEps(r[2])}</td><td class="r num">${fEps(r[3])}</td><td class="r num ${cls(sp)}">${fPct(sp, 1)}</td></tr>`; }).join("");
  return `<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap"><strong>EPS por trimestre</strong>
      ${ult8.length ? `<span class="pill ${beats / ult8.length >= 0.75 ? "verde" : beats / ult8.length >= 0.5 ? "amarillo" : "rojo"}">Superó ${beats} de ${ult8.length}</span>` : ""}</div>
    ${epsChart(hist, proyT)}
    <div class="metrics" style="margin-top:10px">
      <div class="metric"><div class="k">Último trimestre${s0 ? ` · ${qLbl(s0[0])}` : ""}</div><div class="v num">${fEps(s0?.[2])} <span class="sub ${cls(sorpresa)}">${isNum(sorpresa) ? fPct(sorpresa, 1) + " vs est." : ""}</span></div></div>
      <div class="metric"><div class="k">Crecimiento a/a</div><div class="v num ${cls(yoy)}">${fPct(yoy, 0)}</div></div>
      <div class="metric"><div class="k">EPS últimos 12m</div><div class="v num">${fEps(ttm)} <span class="sub">${isNum(peT) ? "P/E " + nf(1).format(peT) : ""}</span></div></div>
      <div class="metric"><div class="k">P/E proyectado${fy ? ` · año fiscal ${fy.fin.slice(0, 4)}` : ""}</div><div class="v num">${isNum(peF) ? nf(1).format(peF) : "—"}</div></div>
    </div>
    ${proy.length ? `<div class="tbl-wrap" style="margin-top:10px"><table><thead><tr><th>Proyección</th><th class="r">EPS</th><th class="r">Rango est.</th><th class="r">Revisión</th></tr></thead><tbody>
      ${[...proyT, ...proyA].map((x) => `<tr><td>${x.periodo === "A" ? "Año fiscal" : "Trim."} ${qLbl(x.fin)}<div class="sub">${x.n} analistas${x.up30 || x.down30 ? ` · ↑${x.up30} ↓${x.down30}` : ""}</div></td>
        <td class="r num">${fEps(x.eps)}${hist[3] && x.periodo === "T" ? `<div class="sub ${cls(x.eps - (hist.find((r) => r[0].slice(5, 7) === x.fin.slice(5, 7)) || [])[2])}">${(() => { const b = hist.find((r) => r[0].slice(5, 7) === x.fin.slice(5, 7) && r[0] < x.fin); return b && b[2] > 0 ? fPct((x.eps / b[2] - 1) * 100, 0) + " a/a" : ""; })()}</div>` : ""}</td>
        <td class="r num sub">${isNum(x.bajo) && isNum(x.alto) ? `${fEps(x.bajo)} a ${fEps(x.alto)}` : "—"}</td><td class="r">${rev(x)}</td></tr>`).join("")}
    </tbody></table></div>` : ""}
    ${hist.length ? `<details style="margin-top:10px"><summary class="sub" style="cursor:pointer">Ver los ${hist.length} trimestres desde 2020</summary>
      <div class="tbl-wrap" style="margin-top:6px"><table><thead><tr><th>Trimestre</th><th class="r">Real</th><th class="r">Estimado</th><th class="r">Sorpresa</th></tr></thead><tbody>${filas}</tbody></table></div></details>` : ""}
    <div class="sub" style="margin-top:8px">EPS ajustado (el que compara el consenso), por fin de trimestre fiscal. Fuente: Alpha Vantage.</div>
  </div>`;
}

// ── Flujo de caja libre por acción (row.fcf: [[fin, fcf_por_accion, ocf, capex, acciones], ...]) ──
function fcfCardHtml(t, row) {
  const f = (row?.fcf || []).filter((r) => isNum(r[1]));   // ignora la marca "sin_datos"
  if (!f.length) return "";
  const hist = row.hist || [], proy = row.proy || [];
  const ttm = (arr, i) => (arr.length >= i + 4 ? arr.slice(i, i + 4).reduce((a, r) => a + r[1], 0) : null);
  const fTtm = ttm(f, 0), fTtmPrev = ttm(f, 4);
  const yoy = isNum(fTtm) && isNum(fTtmPrev) && fTtmPrev > 0 ? (fTtm / fTtmPrev - 1) * 100 : null;
  const eTtm = hist.length >= 4 ? hist.slice(0, 4).reduce((a, r) => a + r[2], 0) : null;
  const conv = isNum(fTtm) && isNum(eTtm) && eTtm > 0 && fTtm > 0 ? fTtm / eTtm : null;   // FCF/acción ÷ EPS ajustado, 12m
  const price = livePrice(t);
  const pfcf = isNum(price) && isNum(fTtm) && fTtm > 0 ? price / fTtm : null;
  const ult = f[0][0];
  const est = conv ? proy.filter((x) => x.fin > ult).map((x) => ({ ...x, v: x.eps * conv })) : [];
  const estT = est.filter((x) => x.periodo === "T"), estA = est.filter((x) => x.periodo === "A");
  const fmt = (v) => (isNum(v) ? nf(2).format(v) : "—");
  // 12m acumulado por fila (historia) y a/a del trimestre
  const rows = f.map((r, i) => { const t12 = ttm(f, i); const prev = f.find((x) => x[0].slice(5, 7) === r[0].slice(5, 7) && x[0] < r[0]);
    const a = prev && prev[1] > 0 ? (r[1] / prev[1] - 1) * 100 : null;
    return `<tr><td>${qLbl(r[0])}</td><td class="r num ${r[1] < 0 ? "down" : ""}">${fmt(r[1])}</td><td class="r num">${fmt(t12)}</td><td class="r num ${cls(a)}">${fPct(a, 0)}</td></tr>`; });
  const chain = [...f.map((r) => r[1])];                    // nuevo → viejo
  const t12est = {}; estT.forEach((x) => { chain.unshift(x.v); t12est[x.fin] = chain.length >= 4 ? chain.slice(0, 4).reduce((a, b) => a + b, 0) : null; });
  const estRows = [...estT, ...estA].map((x) => { const prev = x.periodo === "T" ? f.find((r) => r[0].slice(5, 7) === x.fin.slice(5, 7) && r[0] < x.fin) : null;
    const a = prev && prev[1] > 0 ? (x.v / prev[1] - 1) * 100 : null;
    return `<tr style="background:var(--brass-soft)"><td>${x.periodo === "A" ? "Año fiscal" : "Trim."} ${qLbl(x.fin)} <span class="pill brass" style="font-size:10px;padding:1px 6px">est.</span></td>
      <td class="r num">${fmt(x.v)}</td><td class="r num">${x.periodo === "A" ? `<span class="sub">año</span>` : fmt(t12est[x.fin])}</td><td class="r num ${cls(a)}">${fPct(a, 0)}</td></tr>`; }).join("");
  const chartHist = f.map((r) => [r[0], null, r[1], null]);
  return `<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap"><strong>Flujo de caja libre por acción</strong>
      ${isNum(pfcf) ? `<span class="pill ${pfcf <= 20 ? "verde" : pfcf <= 40 ? "amarillo" : "rojo"}">P/FCF ${nf(1).format(pfcf)}</span>` : ""}</div>
    ${epsChart(chartHist, estT.map((x) => ({ fin: x.fin, eps: x.v })), true)}
    <div class="metrics" style="margin-top:10px">
      <div class="metric"><div class="k">FCF/acción 12m</div><div class="v num">${fmt(fTtm)}</div></div>
      <div class="metric"><div class="k">Crecimiento 12m a/a</div><div class="v num ${cls(yoy)}">${fPct(yoy, 0)}</div></div>
      <div class="metric"><div class="k">Rendimiento FCF</div><div class="v num">${isNum(pfcf) ? fPct(100 / pfcf, 1, false) : "—"}</div></div>
      <div class="metric"><div class="k">Conversión FCF / EPS</div><div class="v num">${isNum(conv) ? nf(0).format(conv * 100) + "%" : "—"}</div></div>
    </div>
    <div class="tbl-wrap" style="margin-top:10px"><table><thead><tr><th>Trimestre</th><th class="r">FCF/acción</th><th class="r">12m</th><th class="r">a/a</th></tr></thead>
      <tbody>${estRows}${rows.slice(0, 8).join("")}</tbody></table></div>
    ${rows.length > 8 ? `<details style="margin-top:8px"><summary class="sub" style="cursor:pointer">Ver los ${rows.length} trimestres desde ${f[f.length - 1][0].slice(0, 4)}</summary>
      <div class="tbl-wrap" style="margin-top:6px"><table><tbody>${rows.slice(8).join("")}</tbody></table></div></details>` : ""}
    <div class="sub" style="margin-top:8px">FCF = flujo de caja operativo − inversión en activos fijos (capex), dividido entre las acciones en circulación de cada trimestre.
      ${est.length ? `<strong>Las filas "est." no son consenso de analistas:</strong> son el EPS de consenso × la conversión FCF/EPS de los últimos 12 meses (${nf(0).format(conv * 100)}%).` : ""} Fuente: Alpha Vantage.</div>
  </div>`;
}

async function loadEps(t) {
  const slot = document.getElementById("eps-slot"); if (!slot) return;
  if (!(t in S.E)) {
    try {
      const { data, error } = await sb.from("inv_eps").select("hist,proy,fcf,actualizado").eq("ticker", t).maybeSingle();
      if (error) throw error;
      S.E[t] = data || null;
    } catch (e) { console.warn(e); slot.innerHTML = `<div class="card sub">No se pudo leer el EPS.</div>`; return; }
  }
  const cur = document.getElementById("eps-slot");
  if (cur && cur.dataset.eps === t) cur.innerHTML = epsCardHtml(t, S.E[t]) + fcfCardHtml(t, S.E[t]);
}

function closeSheet() { $("#sheet").hidden = true; $("#sheet").innerHTML = ""; document.body.style.overflow = ""; }

// ── Glosario: explicación al pasar el mouse o tocar cualquier título o medida ──
// Las claves se buscan al inicio del texto de cada etiqueta (sin distinguir mayúsculas).
const GLOSARIO = [
  // Ficha · tu posición
  ["Tu posición", "Tu posición", "Lo que tienes hoy de este título en IBKR: cantidad, costo, valor actual y ganancia o pérdida sin vender."],
  ["Cantidad", "Cantidad", "Número de acciones (o unidades) que tienes en IBKR."],
  ["Cant.", "Cantidad", "Número de acciones de la operación."],
  ["Costo promedio", "Costo promedio", "Precio promedio que pagaste por cada acción, ponderando todas tus compras."],
  ["Valor · peso", "Valor · peso", "Valor: cantidad × precio de ahora. Peso: qué % de tu cartera total (incluida la caja) representa este título."],
  ["No realizado", "Ganancia/pérdida no realizada", "Lo que ganarías o perderías si vendieras hoy: (precio de ahora − costo promedio) × cantidad. No es plata en el bolsillo hasta que vendes."],
  ["P&L realizado", "P&L realizado", "Ganancia o pérdida de las ventas ya cerradas (método FIFO: se vende primero lo que se compró primero)."],
  ["Pilar 4", "Semáforo Pilar 4", "Disciplina de compra por título según tu historial en IBKR. Regla A: muchas compras seguidas sin cerrar en ganancia. Regla B: racha de cierres seguidos en pérdida. Regla C: la última compra fue más grande que la anterior con la posición en rojo. ROJO = se cumple al menos una regla: pausa antes de comprar más. VERDE = sin alertas."],
  ["Semáforo Pilar 4", "Semáforo Pilar 4", "Disciplina de compra por título según tu historial en IBKR (reglas A, B y C de frecuencia y tamaño de compras). ROJO = pausa antes de comprar más."],
  // Niveles por volumen
  ["Niveles por volumen", "Niveles por volumen", "Pisos y techos calculados donde más volumen se ha negociado (perfil de volumen). Son zonas donde el precio suele frenar: el piso como soporte (compra) y el techo como resistencia (venta). Se calculan en 3 horizontes de tiempo."],
  ["Horizonte", "Horizonte", "Ventana de tiempo usada para calcular piso y techo: táctico (6 meses), estructural (2 años) e histórico (5 años)."],
  ["Táctico 6m", "Horizonte táctico (6 meses)", "Piso y techo con el volumen de los últimos 6 meses. Sirve para entradas y salidas de corto plazo."],
  ["Estructural 2a", "Horizonte estructural (2 años)", "Piso y techo con el volumen de los últimos 2 años. Marca la tendencia de mediano plazo."],
  ["Histórico 5a", "Horizonte histórico (5 años)", "Piso y techo con el volumen de los últimos 5 años. Las zonas de largo plazo más fuertes."],
  ["Piso", "Piso", "Precio con mucho volumen negociado por debajo del precio actual: zona de soporte donde suelen aparecer compradores. Referencia para comprar."],
  ["Techo", "Techo", "Precio con mucho volumen negociado por encima del precio actual: zona de resistencia donde suelen aparecer vendedores. Referencia para vender o tomar ganancias."],
  ["R:B", "Riesgo : Beneficio", "Cuánto podrías ganar hasta el techo por cada peso que arriesgas hasta el piso. 2x = el beneficio potencial es el doble del riesgo. 'bajo piso' = el precio ya rompió el piso; 'en piso' = está tan cerca del piso que el cálculo no es confiable."],
  ["Rango est.", "Rango de estimados", "EPS más bajo y más alto entre los analistas que cubren el título. Un rango amplio = mucha incertidumbre."],
  ["Rango", "Posición en el rango", "Dónde está el precio entre el piso (0%) y el techo (100%). Verde: cerca del piso con R:B > 2. Rojo: arriba del 65% del rango o R:B < 1. Amarillo: en medio."],
  ["Califica", "Veredicto: Califica", "La relación riesgo/beneficio y la posición del precio frente a sus pisos y techos son favorables para comprar o sumar."],
  ["Vigilar", "Veredicto: Vigilar", "Condiciones mixtas: no es zona clara de compra ni de venta. Seguirlo de cerca."],
  ["No califica", "Veredicto: No califica", "Riesgo/beneficio desfavorable (precio lejos del piso o cerca del techo). No es momento de comprar."],
  ["Defensa táctica", "Defensa táctica", "Precio de stop de corto plazo. Si el precio cierra por debajo, la tesis de corto plazo se rompió (Art. V de tu Constitución DCLA)."],
  ["Defensa estructural", "Defensa estructural", "Precio de stop de mediano plazo. Romperla indica que la tendencia de fondo cambió (Art. V de tu Constitución DCLA)."],
  ["Volatilidad anual", "Volatilidad anual", "Cuánto se mueve el precio en un año típico (desviación estándar anualizada). 92% = movimientos muy grandes: posiciones más pequeñas y revisiones más frecuentes."],
  ["Revisión sugerida", "Revisión sugerida", "Cada cuánto revisar el título según su volatilidad: más volátil, más seguido."],
  ["Entrada por tramos", "Entrada por tramos", "Plan para comprar en partes en cada piso (con el % del monto en cada uno), en vez de todo de una vez."],
  ["Salida por tramos", "Salida por tramos", "Plan para vender en partes en cada techo (con el % de la posición en cada uno)."],
  // Valuación
  ["Valuación y analistas", "Valuación y analistas", "Qué tan caro está el título frente a sus utilidades, la calidad del negocio y qué opinan los analistas (Alpha Vantage, se refresca cada pocos días)."],
  ["Calidad", "Calidad del negocio (lente Buffett)", "Suma señales: ROE ≥ 15% y margen operativo ≥ 15% suman; ROE o margen < 5% restan; crecimiento de ingresos y de EPS positivo suma, negativo resta. Alta / Media / Baja. Necesita al menos 2 señales con dato."],
  ["P/E futuro", "P/E futuro", "Precio ÷ EPS esperado por los analistas para los próximos 12 meses. Más bajo que el P/E actual = se espera que las utilidades crezcan."],
  ["P/E proyectado", "P/E proyectado", "Precio de ahora ÷ EPS de consenso del próximo año fiscal."],
  ["P/E", "P/E (precio / utilidad)", "Cuántos años de utilidades actuales pagas por la acción. Más alto = más caro (o más crecimiento esperado). 'n/a' = la empresa tiene pérdidas."],
  ["PEG", "PEG", "P/E ÷ crecimiento esperado de utilidades. Cerca de 1 = precio justo para su crecimiento; menos de 1 = barato para lo que crece; más de 2 = caro."],
  ["ROE", "ROE (rentabilidad del patrimonio)", "Utilidad neta ÷ patrimonio, últimos 12 meses. Cuánto gana la empresa con el dinero de los accionistas. Más de 15% es bueno."],
  ["Margen operativo", "Margen operativo", "Utilidad operativa ÷ ingresos. Cuánto le queda del negocio principal por cada dólar vendido. Negativo = pierde plata operando."],
  ["Ingresos a/a", "Ingresos a/a", "Crecimiento de las ventas frente al mismo trimestre del año anterior."],
  ["Consenso", "Consenso de analistas", "Recomendación promedio de los analistas que cubren el título (Compra fuerte → Venta fuerte) y cuántos son."],
  ["Precio objetivo", "Precio objetivo", "Precio promedio que esperan los analistas en 12 meses. El % es el potencial frente al precio de ahora."],
  // Earnings / EPS
  ["Earnings", "Earnings", "Fecha del próximo reporte trimestral de resultados y lo que espera el mercado."],
  ["Próximo", "Próximo reporte", "Fecha del próximo reporte trimestral de resultados."],
  ["EPS estimado", "EPS estimado", "Utilidad por acción que esperan los analistas para el próximo reporte."],
  ["Revisiones 30d", "Revisiones 30 días", "Si los analistas subieron o bajaron su estimado en el último mes. Revisiones al alza suelen anticipar buenos resultados."],
  ["Siguiente call", "Siguiente call", "Fecha de la conferencia con inversionistas del siguiente reporte."],
  ["EPS por trimestre", "EPS (utilidad por acción)", "Utilidad ajustada de cada trimestre dividida entre el número de acciones. Es el dato que compara el mercado contra lo esperado. Barras llenas: real; punteadas: proyección de consenso; raya: lo que se esperaba."],
  ["Superó", "Le ganó al estimado", "En cuántos de los últimos trimestres el EPS real fue igual o mayor al que esperaban los analistas. 6 de 8 o más es consistente."],
  ["Último trimestre", "Último trimestre", "EPS del último reporte y su sorpresa: cuánto quedó por encima (+) o por debajo (−) de lo esperado."],
  ["Crecimiento a/a", "Crecimiento a/a", "EPS del último trimestre frente al mismo trimestre del año anterior."],
  ["EPS últimos 12m", "EPS últimos 12 meses", "Suma del EPS de los últimos 4 trimestres. El P/E al lado usa el precio de ahora."],
  ["Proyección", "Proyección", "Estimados de consenso para los próximos trimestres y años fiscales: promedio, rango (más bajo – más alto), número de analistas y revisiones en 30 días (↑ al alza, ↓ a la baja)."],
  ["Sorpresa", "Sorpresa", "Diferencia % entre el EPS real y el estimado."],
  ["Revisión", "Revisión 30 días", "Cuánto cambió el estimado promedio en los últimos 30 días."],
  ["Estimado", "Estimado", "EPS que esperaban los analistas antes del reporte."],
  ["Real", "Real", "EPS reportado por la empresa."],
  ["Trimestre", "Trimestre", "Trimestre fiscal, nombrado por su mes de cierre."],
  // FCF
  ["Flujo de caja libre", "Flujo de caja libre (FCF) por acción", "Caja que genera el negocio después de invertir en activos fijos: flujo de caja operativo − capex, dividido entre las acciones. Es más difícil de maquillar que la utilidad contable."],
  ["P/FCF", "Precio / flujo de caja libre", "Cuántas veces pagas el FCF anual por acción. Verde ≤ 20, amarillo ≤ 40, rojo más arriba."],
  ["FCF/acción 12m", "FCF por acción 12 meses", "Suma del FCF por acción de los últimos 4 trimestres."],
  ["FCF/acción", "FCF por acción", "Flujo de caja libre del trimestre ÷ acciones en circulación."],
  ["Crecimiento 12m a/a", "Crecimiento 12m a/a", "FCF de los últimos 12 meses frente a los 12 meses anteriores."],
  ["Rendimiento FCF", "Rendimiento FCF", "FCF anual por acción ÷ precio. Es como la 'tasa de interés' que te paga el negocio en caja: 5% o más es atractivo."],
  ["Conversión FCF", "Conversión FCF / EPS", "Qué parte de la utilidad (EPS) se convierte en caja libre. Cerca de 100% o más = utilidades de buena calidad."],
  ["12m", "12 meses", "Acumulado de los últimos 4 trimestres hasta esa fila."],
  ["a/a", "Año contra año", "Cambio frente al mismo periodo del año anterior."],
  ["est.", "Estimado (no es consenso)", "FCF proyectado = EPS de consenso × conversión FCF/EPS de los últimos 12 meses."],
  ["Fuerza relativa", "Fuerza relativa", "Si el título le está ganando o perdiendo a los índices (S&P 500, Nasdaq) y a Bitcoin en el mismo periodo."],
  // Resumen / cartera
  ["Valor de la cartera", "Valor de la cartera", "Suma de tus posiciones a precio de ahora más la caja en IBKR. Debajo, su equivalente en pesos con el dólar del momento."],
  ["Hoy", "Hoy", "Cuánto ha ganado o perdido tu cartera (o el título) desde el cierre de ayer."],
  ["Liquidez", "Liquidez", "Caja disponible como % del valor total de la cartera."],
  ["DCLA", "Constitución DCLA", "Tus reglas de inversión: Art. I (sin acciones bajo $5, cripto ni margen), Art. III (topes de concentración por título y bloque) y Art. V (respetar las defensas). 'ok' = sin alertas."],
  ["Constitución DCLA", "Constitución DCLA", "Tus reglas de inversión revisadas en vivo con los precios de ahora."],
  ["Art. I", "Art. I", "Prohibiciones: acciones bajo $5, cripto o sus proxies, y uso de margen."],
  ["Art. III", "Art. III", "Topes de concentración: ningún título ni bloque de riesgo puede pasar el % máximo de la cartera."],
  ["Art. V", "Art. V", "Si el precio rompe la defensa táctica o estructural, se revisa o se sale de la posición."],
  ["Concentración por bloque", "Concentración por bloque de riesgo", "Títulos que tienden a moverse juntos (p. ej. cripto: MSTR, IREN, BTC) sumados. La raya gris es el tope permitido; rojo = lo pasaste."],
  ["Concentración por sector", "Concentración por sector", "% de la cartera en cada sector frente al tope."],
  ["Caja", "Caja", "Efectivo disponible en IBKR."],
  ["Invertido", "Invertido", "Valor de mercado de tus posiciones, sin la caja."],
  ["Apalancamiento", "Apalancamiento", "Cuánto de tu cartera está financiado con préstamo del bróker (margen). 0% = solo plata propia."],
  ["Interés margen", "Interés de margen", "Intereses que IBKR te cobró este mes por usar margen."],
  ["Top 5", "Top 5 con el precio de ahora", "Comprar: los títulos más cerca de su piso con mejor riesgo/beneficio. Vender: los más cerca de su techo."],
  ["Alertas en vivo", "Alertas en vivo", "Títulos que cruzaron o están muy cerca de un piso o techo con el precio de ahora."],
  ["Earnings próximos", "Earnings próximos", "Títulos del watchlist que reportan resultados en las próximas 3 semanas."],
  // Macro
  ["Mercado ahora", "Mercado ahora", "Indicadores del mercado con precio en vivo."],
  ["S&P 500", "S&P 500 (SPY)", "Las 500 empresas más grandes de EE. UU. Es la referencia del mercado: si tu cartera le gana, vas mejor que el promedio."],
  ["Nasdaq 100", "Nasdaq 100 (QQQ)", "Las 100 tecnológicas y de crecimiento más grandes del Nasdaq. Tu cartera, cargada en IA y chips, suele moverse parecido."],
  ["Bitcoin", "Bitcoin", "Precio en vivo. Mueve directamente a MSTR, IREN y otros títulos ligados a cripto."],
  ["VIX", "VIX", "Índice del miedo: volatilidad esperada del S&P 500. Menos de 15 = calma; más de 25 = nervios; más de 30 = pánico."],
  ["Bono 10 años", "Bono del Tesoro a 10 años", "Tasa de interés de largo plazo en EE. UU. Si sube, presiona a la baja las acciones de crecimiento."],
  ["Tesoro 10 años", "Bono del Tesoro a 10 años", "Tasa de interés de largo plazo en EE. UU. y su cambio en puntos básicos (pb)."],
  ["Índice dólar", "Índice dólar (DXY)", "Fuerza del dólar frente a las principales monedas. Un dólar fuerte suele pesar sobre acciones y cripto."],
  ["Dólar (DXY)", "Índice dólar (DXY) 1 mes", "Cambio de la fuerza del dólar en el último mes."],
  ["Dólar (USD/COP)", "Dólar en Colombia", "Pesos por dólar en vivo. Si sube, tu cartera vale más en pesos aunque no se mueva en dólares."],
  ["Régimen macro", "Régimen macro", "Lectura del entorno: risk-on (favorable para riesgo), risk-off (defensivo) o neutral, combinando tasas, dólar, inflación y tendencia del Nasdaq."],
  ["Fed funds", "Tasa de la Fed", "Tasa de interés de referencia de la Reserva Federal."],
  ["Inflación", "Inflación (CPI a/a)", "Variación de los precios al consumidor en EE. UU. en el último año."],
  ["Tasa real", "Tasa real", "Bono a 10 años menos inflación. Positiva y alta = el dinero 'seguro' rinde bien y compite con las acciones."],
  ["Nasdaq vs media 200", "Nasdaq vs media de 200 días", "Qué tan arriba (+) o abajo (−) está el Nasdaq de su promedio de 200 días. Debajo = tendencia bajista."],
];
const _G = GLOSARIO.map(([k, t, d]) => [k.toLowerCase(), t, d]).sort((a, b) => b[0].length - a[0].length);
function glosa(txt) {
  const s = String(txt || "").replace(/\s+/g, " ").trim().toLowerCase().replace(/:$/, "");
  if (!s || s.length > 60) return null;
  if (/\bdcla\b/.test(s) && !s.startsWith("constitución")) return _G.find((g) => g[0] === "dcla").slice(1);
  for (const [k, t, d] of _G) if (s === k || s.startsWith(k + " ") || s.startsWith(k + "·") || (k.length > 3 && s.startsWith(k))) return [t, d];
  return null;
}
const TIP_SEL = ".metric .k, .kv .k, .label, th, h2, .card strong, .pill, td:first-child, .sheet .sub strong";
function annotateTips(root) {
  root.querySelectorAll(TIP_SEL).forEach((el) => {
    if (el.dataset.tipDone) return;
    el.dataset.tipDone = "1";
    if (el.closest("[data-t]") || el.closest(".tabs")) return;       // filas que abren la ficha: no robarles el toque
    const txt = el.childNodes.length && el.childNodes[0].nodeType === 3 ? el.childNodes[0].textContent : el.textContent;
    const g = glosa(txt) || glosa(el.textContent);
    if (!g) return;
    el.dataset.tip = g[0]; el.dataset.tipD = g[1];
    el.classList.add("tip"); el.tabIndex = 0;
  });
}
const tipBox = document.createElement("div");
tipBox.id = "tip"; tipBox.setAttribute("role", "tooltip"); tipBox.hidden = true;
document.body.appendChild(tipBox);
let tipFor = null, tipTimer = null, tipAt = 0;
function showTip(el) {
  if (tipFor !== el) tipAt = Date.now();
  tipFor = el;
  tipBox.innerHTML = `<strong>${esc(el.dataset.tip)}</strong><div>${esc(el.dataset.tipD)}</div>`;
  tipBox.hidden = false;
  const r = el.getBoundingClientRect(), w = Math.min(300, window.innerWidth - 24);
  tipBox.style.maxWidth = w + "px";
  const bh = tipBox.offsetHeight, bw = tipBox.offsetWidth;
  let left = Math.max(12, Math.min(r.left, window.innerWidth - bw - 12));
  let top = r.bottom + 8;
  if (top + bh > window.innerHeight - 12) top = Math.max(12, r.top - bh - 8);
  tipBox.style.left = left + "px"; tipBox.style.top = top + "px";
}
function hideTip() { tipFor = null; tipBox.hidden = true; clearTimeout(tipTimer); }
const canHover = window.matchMedia("(hover: hover)").matches;
if (canHover) {
  document.addEventListener("mouseover", (e) => { const el = e.target.closest?.("[data-tip]"); if (!el || el === tipFor) return; clearTimeout(tipTimer); tipTimer = setTimeout(() => showTip(el), 250); });
  document.addEventListener("mouseout", (e) => { const el = e.target.closest?.("[data-tip]"); if (el && !el.contains(e.relatedTarget)) hideTip(); });
}
document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-tip]");
  if (el) { e.preventDefault(); e.stopPropagation(); if (tipFor === el && !tipBox.hidden && Date.now() - tipAt > 400) hideTip(); else showTip(el); return; }
  if (!e.target.closest("#tip")) hideTip();
}, true);
document.addEventListener("focusin", (e) => { if (e.target.matches?.("[data-tip]")) showTip(e.target); });
document.addEventListener("focusout", (e) => { if (e.target.matches?.("[data-tip]")) hideTip(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideTip(); });
window.addEventListener("scroll", hideTip, true);
window.addEventListener("resize", hideTip);
new MutationObserver(() => annotateTips(document.body)).observe(document.body, { childList: true, subtree: true });

// ── Editar watchlist (tabla inv_watchlist; el cálculo diario la lee a las 4:17 a. m.) ──
const WL = { filas: null, msg: "", err: false, busy: false };
async function wlCargar() {
  const { data, error } = await sb.from("inv_watchlist").select("ticker,nombre,sector,activo,agregado").order("agregado");
  if (error) throw error;
  WL.filas = data || [];
}
function wlSectores() {
  const base = ["IA & Chips", "Energia & Nuclear", "Materiales & Recursos", "Salud", "Resto"];
  return [...new Set([...base, ...Object.values(S.M?.tickers || {}).map((i) => i.sector).filter((x) => x && x !== "Cripto" && x !== "Sin clasificar")])];
}
function wlRender() {
  const box = document.querySelector("#sheet .wl"); if (!box) return;
  const own = new Set(Object.keys(S.C?.posiciones || {}));
  const activos = (WL.filas || []).filter((f) => f.activo);
  const enCalculo = new Set(S.M?.watchlist || []);
  const filas = activos.map((f) => {
    const t = f.ticker, info = S.M?.tickers?.[t];
    const estado = !enCalculo.has(t) ? `<span class="pill amarillo">pendiente</span>` : "";
    return `<li class="wl-row"><div style="min-width:0"><strong>${esc(disp(t))}</strong> ${estado}${own.has(t) ? ' <span class="own" title="En tu cartera" style="display:inline-block;vertical-align:middle"></span>' : ""}
        <div class="sub">${esc([f.nombre || info?.nombre, f.sector || info?.sector].filter(Boolean).join(" · "))}</div></div>
      <button type="button" class="btn ghost sm" data-wl-del="${esc(t)}" ${WL.busy ? "disabled" : ""}>Quitar</button></li>`;
  }).join("");
  const retirados = [...enCalculo].filter((t) => !activos.some((f) => f.ticker === t));
  box.innerHTML = `
    <form class="card stack" data-wl-form autocomplete="off">
      <strong>Agregar título</strong>
      <div class="wl-add">
        <input name="t" placeholder="Ticker, ej. AAPL" maxlength="12" required style="text-transform:uppercase" aria-label="Ticker">
        <select name="s" aria-label="Sector" required><option value="">Sector…</option>${wlSectores().map((x) => `<option>${esc(x)}</option>`).join("")}</select>
      </div>
      <input name="n" placeholder="Nombre de la empresa (opcional)" maxlength="60" aria-label="Nombre">
      <button class="btn" type="submit" ${WL.busy ? "disabled" : ""}>${WL.busy ? "Verificando…" : "Agregar"}</button>
      ${WL.msg ? `<div class="msg${WL.err ? " err" : ""}">${esc(WL.msg)}</div>` : ""}
    </form>
    <h2>En el reporte · ${activos.length}</h2>
    <div class="card">${filas ? `<ul class="wl-list">${filas}</ul>` : `<div class="sub">Sin títulos.</div>`}</div>
    ${retirados.length ? `<div class="sub" style="margin:0 2px">Se retiran en el próximo cálculo: ${retirados.map((t) => esc(disp(t))).join(", ")}.</div>` : ""}
    <div class="sub" style="margin:0 2px">Los cambios se aplican en el cálculo diario (≈ 4:17 a. m.). Si los quieres ya: GitHub → Actions → "App Money Bag – snapshot diario" → Run workflow. Los títulos que tienes en IBKR siempre aparecen, estén o no en esta lista.</div>`;
}
async function wlAbrir() {
  $("#sheet").innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="Editar títulos del reporte">
    <div class="grab"></div>
    <div class="sheet-head"><div><h3>Títulos del reporte</h3><div class="sub">Agrega o quita títulos del watchlist</div></div>
      <button class="icon-btn x" type="button" data-close aria-label="Cerrar"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>
    <div class="stack wl"><div class="card sub">Cargando…</div></div></div>`;
  $("#sheet").hidden = false; document.body.style.overflow = "hidden";
  WL.msg = ""; WL.err = false;
  try { await wlCargar(); } catch (e) { WL.msg = "No se pudo leer la lista. Revisa tu conexión."; WL.err = true; WL.filas = []; }
  wlRender();
}
async function wlAgregar(form) {
  const t = String(form.t.value || "").trim().toUpperCase().replace(/\s+/g, "-");
  const sector = form.s.value, nombre = String(form.n.value || "").trim();
  if (!/^[A-Z0-9.\-^=]{1,12}$/.test(t)) { WL.msg = "Ticker no válido."; WL.err = true; return wlRender(); }
  if ((WL.filas || []).some((f) => f.ticker === t && f.activo)) { WL.msg = `${t} ya está en el reporte.`; WL.err = true; return wlRender(); }
  WL.busy = true; WL.msg = ""; wlRender();
  try {
    const { data, error } = await sb.functions.invoke("inv-precios", { body: { symbols: [t] } });
    if (error) throw error;
    const q = data?.quotes?.[t];
    if (!q || !isNum(q.price)) { WL.msg = `No encontré ${t} en Yahoo Finance. Revisa el ticker.`; WL.err = true; return; }
    const { error: e2 } = await sb.from("inv_watchlist").upsert({ ticker: t, sector, nombre: nombre || null, activo: true, agregado: new Date().toISOString() });
    if (e2) throw e2;
    await wlCargar();
    WL.msg = `${t} agregado (${fPrice(q.price)}). Aparece con niveles y análisis después del próximo cálculo.`; WL.err = false;
  } catch (e) { console.warn(e); WL.msg = "No se pudo agregar. Intenta de nuevo."; WL.err = true; }
  finally { WL.busy = false; wlRender(); const i = document.querySelector('#sheet [name="t"]'); if (i && !WL.err) i.value = ""; }
}
async function wlQuitar(t) {
  WL.busy = true; wlRender();
  try {
    const { error } = await sb.from("inv_watchlist").update({ activo: false }).eq("ticker", t);
    if (error) throw error;
    await wlCargar();
    WL.msg = `${t} se retira del reporte en el próximo cálculo.`; WL.err = false;
  } catch (e) { console.warn(e); WL.msg = "No se pudo quitar. Intenta de nuevo."; WL.err = true; }
  finally { WL.busy = false; wlRender(); }
}
document.addEventListener("click", (ev) => {
  if (ev.target.closest("[data-wl-edit]")) { ev.preventDefault(); wlAbrir(); return; }
  const del = ev.target.closest("[data-wl-del]");
  if (del) { ev.preventDefault(); wlQuitar(del.dataset.wlDel); }
});
document.addEventListener("submit", (ev) => {
  if (ev.target.matches("[data-wl-form]")) { ev.preventDefault(); wlAgregar(ev.target); }
});

// ── Datos y sesión ────────────────────────────────────────────────────────
async function loadSnapshot() {
  const { data, error } = await sb.from("inv_snapshot").select("clave,data,generado");
  if (error) throw error;
  for (const r of data || []) { if (r.clave === "mercado") S.M = r.data; if (r.clave === "cuenta") S.C = r.data; }
  try { localStorage.setItem("mb_cache", JSON.stringify({ M: S.M, C: S.C })); } catch (_) {}
}

let started = false;
async function start() {
  if (started) return; started = true;
  $("#login").hidden = true; $("#app").hidden = false;
  // Pinta al instante lo último guardado en este teléfono y luego actualiza.
  try { const c = JSON.parse(localStorage.getItem("mb_cache") || "null"); if (c?.M) { S.M = c.M; S.C = c.C; render(); } } catch (_) {}
  try { await loadSnapshot(); }
  catch (e) { console.warn(e); if (!S.M) { $("#v-resumen").innerHTML = `<div class="card empty">No se pudo leer el cálculo diario. Revisa tu conexión e intenta de nuevo.</div>`; return; } }
  if (!S.M) { $("#v-resumen").innerHTML = `<div class="card empty">Todavía no hay cálculo diario guardado. Aparece después de la primera corrida del proceso en GitHub.</div>`; setStatus(); return; }
  render();
  loadQuotes();
}

function showLogin(msg, err) {
  $("#app").hidden = true; $("#login").hidden = false;
  const m = $("#login-msg"); m.hidden = !msg; m.textContent = msg || ""; m.className = "msg" + (err ? " err" : "");
}

// ── Eventos ───────────────────────────────────────────────────────────────
document.addEventListener("click", (ev) => {
  const t = ev.target.closest("[data-t]");
  if (t && !ev.target.closest("[data-close]")) { ev.preventDefault(); openSheet(t.dataset.t); return; }
  if (ev.target.closest("[data-close]") || ev.target.id === "sheet") { closeSheet(); return; }
  const tab = ev.target.closest(".tab");
  if (tab) { S.view = tab.dataset.v; try { localStorage.setItem("mb_view", S.view); } catch (_) {} render(); window.scrollTo({ top: 0 }); return; }
  const chip = ev.target.closest("[data-sector]");
  if (chip) { S.sector = chip.dataset.sector; renderWatch(); return; }
  const wm = ev.target.closest("[data-wmode]");
  if (wm) { S.wmode = wm.dataset.wmode; try { localStorage.setItem("mb_wmode", S.wmode); } catch (_) {} renderWatch(); return; }
  const so = ev.target.closest("[data-sort]");
  if (so) { S.sort = so.dataset.sort; renderWatch(); return; }
});
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && !$("#sheet").hidden) closeSheet();
  if ((ev.key === "Enter" || ev.key === " ") && ev.target.matches(".r[data-t]")) { ev.preventDefault(); openSheet(ev.target.dataset.t); }
});
$("#refresh-btn").addEventListener("click", () => loadQuotes());
$("#mask-btn").addEventListener("click", () => {
  S.masked = !S.masked; try { localStorage.setItem("mb_masked", S.masked ? "1" : "0"); } catch (_) {}
  $("#mask-btn").setAttribute("aria-label", S.masked ? "Mostrar montos" : "Ocultar montos"); render();
});
// Cada vez que vuelves a la app (estaba en segundo plano) trae precios nuevos.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && S.M && (!S.qAt || Date.now() - S.qAt > 30000)) loadQuotes();
});

$("#login-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const email = $("#email").value.trim().toLowerCase(), password = $("#pass").value;
  if (!/^\S+@\S+\.\S+$/.test(email)) { showLogin("Escribe un correo válido.", true); return; }
  if (!password) { showLogin("Escribe tu contraseña, o pide un enlace de acceso al correo.", true); return; }
  $("#pass-btn").disabled = true;
  const { error } = await sb.auth.signInWithPassword({ email, password });
  $("#pass-btn").disabled = false;
  if (error) showLogin("Correo o contraseña no válidos. Si aún no creaste contraseña, pide el enlace al correo.", true);
});
$("#send-btn").addEventListener("click", async () => {
  const email = $("#email").value.trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) { showLogin("Escribe un correo válido.", true); return; }
  $("#send-btn").disabled = true;
  const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
  $("#send-btn").disabled = false;
  if (error) { showLogin("No se pudo enviar el enlace: " + error.message, true); return; }
  showLogin("Te enviamos un correo. Ábrelo en este teléfono y toca el enlace. Una vez dentro, crea una contraseña (sección Acceso, al final de la pantalla) para entrar directo desde la app instalada.");
});

// Contraseña y cierre de sesión (pie de Resumen)
document.addEventListener("submit", async (ev) => {
  if (ev.target.id !== "pw-form") return;
  ev.preventDefault();
  const p1 = $("#pw1").value, msg = $("#pw-msg");
  if (p1.length < 8) { msg.hidden = false; msg.className = "msg err"; msg.textContent = "Usa al menos 8 caracteres."; return; }
  const { error } = await sb.auth.updateUser({ password: p1 });
  msg.hidden = false; msg.className = "msg" + (error ? " err" : "");
  msg.textContent = error ? "No se pudo guardar: " + error.message : "Contraseña guardada. Ya puedes entrar con correo y contraseña.";
  if (!error) $("#pw1").value = "";
});
document.addEventListener("click", async (ev) => {
  if (ev.target.id === "logout-btn") { await sb.auth.signOut(); }
});

sb.auth.onAuthStateChange((evt, session) => {
  if (evt === "SIGNED_IN" && session) { if (location.hash.includes("access_token")) history.replaceState(null, "", location.pathname); start(); }
  if (evt === "SIGNED_OUT") { started = false; try { localStorage.removeItem("mb_cache"); } catch (_) {} showLogin(); }
});
(async () => {
  const { data } = await sb.auth.getSession();
  if (data?.session) start(); else showLogin();
})();

if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
})();
