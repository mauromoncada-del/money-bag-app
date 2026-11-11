/* Money Bag · Asistente IA (v1.0 · 10-nov-2026)
 * ------------------------------------------------------------------------
 * Mismo patrón que el copiloto de ibpflow: un botón flotante abre un panel de
 * chat. La función mb-copilot (Supabase) guarda la clave de Claude y hace un
 * turno del modelo por llamada; si el modelo pide datos, se calculan AQUÍ con
 * las mismas funciones que dibujan la app (window.MB, en app.js): precio en
 * vivo, R:B, cartera, DCLA… Así las cifras de la IA son las de la pantalla.
 * La búsqueda web corre del lado de Claude (noticias, por qué se mueve algo).
 */
(() => {
"use strict";
const MAX_VUELTAS = 10;
const MAX_RESULTADO = 16000;
const isNum = (v) => typeof v === "number" && isFinite(v);
const r2 = (v, d = 2) => (isNum(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ═══════════════════════════ Motor de herramientas ═══════════════════════════
const MB = () => window.MB;
function resolver(t) {
  const { S } = MB();
  const q = String(t || "").trim().toUpperCase();
  if (!q) return null;
  const T = S.M?.tickers || {};
  if (T[q]) return q;
  for (const k of Object.keys(T)) if (k.toUpperCase() === q || (T[k].display || "").toUpperCase() === q || k.toUpperCase() === q + "-USD") return k;
  for (const k of Object.keys(T)) if ((T[k].nombre || "").toUpperCase().includes(q)) return k;
  return null;
}
const noTicker = (t) => ({ error: `«${t}» no está en la app (watchlist, cartera ni cripto). Puedes buscarlo en la web o pedir que se agregue a la watchlist.`, disponibles: MB().allTickers() });
const precioInfo = (t) => {
  const { S, livePrice, liveChg } = MB(); const q = S.Q[t];
  return { precio: r2(livePrice(t), 4), var_dia_pct: r2(liveChg(t)), sesion: q?.session || (q ? null : "snapshot"), moneda: q?.currency || MB().monedaDe(t) };
};
const nivelCorto = (x) => x && { piso: x.piso?.precio ?? null, techo: x.techo?.precio ?? null, techo2: x.techo2?.precio ?? null, rb: r2(x.rbLive?.ratio, 1), rb_confiable: x.rbLive?.confiable,
  posicion_pct: isNum(x.rbLive?.posicion) ? Math.round(x.rbLive.posicion * 100) : null, semaforo: x.rbLive?.semaforo, riesgo_pct: r2(x.rbLive?.riesgo_pct, 1), beneficio_pct: r2(x.rbLive?.beneficio_pct, 1) };

function cartera() {
  const { S, portfolio } = MB(); const P = portfolio();
  if (!P) return { error: "No hay datos de la cuenta de IBKR en el cálculo diario." };
  const ver = !S.masked, C = S.C;
  const out = {
    montos_visibles: ver,
    nota: ver ? "Valores en USD al precio en vivo." : "Montos ocultos en la app: solo porcentajes. Si Mauro quiere cifras en dólares, que toque el ojo de la barra superior.",
    resumen: { var_dia_pct: r2(P.dayPct), pnl_no_realizado_pct: r2(P.unrealPct), liquidez_pct: r2(P.liquidezPct, 1), apalancamiento_pct: r2(P.apal, 1), n_posiciones: P.rows.length },
    posiciones: P.rows.map((r) => ({ ticker: r.sym, peso_pct: r2(r.peso, 1), pnl_pct: r2(r.unPct, 1), precio: r2(r.px, 2), costo_prom: r2(r.avg, 2), sector: r.sector,
      semaforo_pilar4: r.sem?.estado || null, razones_pilar4: r.sem?.razones?.length ? r.sem.razones : undefined, ...(ver ? { valor: r2(r.value, 0), pnl_dia: r2(r.dayPnl, 0), pnl_no_realizado: r2(r.un, 0), cantidad: r.qty } : {}) })),
    por_sector_pct: P.porSector.map((s) => [s.k, r2(s.pct, 1)]),
    bloques: P.bloques.map((b) => ({ bloque: b.k, pct: r2(b.pct, 1), excede_tope: !!b.excede, tickers: b.quienes })), tope_bloque_pct: P.tope, tope_ticker_pct: P.topeT,
    dcla: { violaciones: P.dcla.viol, art1_sub5: P.dcla.art1.sub5, art1_cripto: P.dcla.art1.cripto, art1_margen_hoy: P.dcla.art1.margen_hoy, art1_margen_mes: P.dcla.art1.margen_mtd,
      art3_tickers_sobre_tope: P.dcla.art3.tickers.map(([t, p]) => [t, r2(p, 1)]), art3_bloques_sobre_tope: P.dcla.art3.bloques.map(([b, p]) => [b, r2(p, 1)]),
      art5_defensa_tactica_rota: P.dcla.art5.tactica, art5_defensa_estructural_rota: P.dcla.art5.estructural },
    objetivo_liquidez_pct: S.M?.config?.objetivo_liquidez_pct,
  };
  if (ver) Object.assign(out.resumen, { nav: r2(P.nav, 0), invertido: r2(P.total, 0), caja: r2(P.caja, 0), pnl_dia: r2(P.day, 0), pnl_no_realizado: r2(P.unreal, 0),
    pnl_realizado_anio: r2(C.pnl_total?.realizado_total, 0), interes_margen_mes: r2(C.liquidez?.interes_pagado_mtd, 0), usd_cop: r2(S.Q["COP=X"]?.price, 0) });
  return out;
}

async function epsFcf(t) {
  const { S, sb, livePrice } = MB();
  if (!(t in S.E)) {
    const { data, error } = await sb.from("inv_eps").select("hist,proy,fcf,actualizado").eq("ticker", t).maybeSingle();
    if (error) return { error: "No se pudo leer el EPS: " + error.message };
    S.E[t] = data || null;
  }
  const row = S.E[t];
  if (!row) return { error: `Sin histórico de EPS/FCF para ${t} (cripto o aún no cargado).` };
  const hist = row.hist || [], proy = row.proy || [], price = livePrice(t);
  const ttm = hist.length >= 4 ? hist.slice(0, 4).reduce((a, r) => a + r[2], 0) : null;
  const ult8 = hist.slice(0, 8).filter((r) => isNum(r[3]));
  const fy = proy.filter((x) => x.periodo === "A")[0];
  const f = (row.fcf || []).filter((r) => isNum(r[1]));
  const fT = f.length >= 4 ? f.slice(0, 4).reduce((a, r) => a + r[1], 0) : null;
  const fP = f.length >= 8 ? f.slice(4, 8).reduce((a, r) => a + r[1], 0) : null;
  return {
    ticker: t, precio: r2(price, 2), actualizado: row.actualizado,
    eps_12m: r2(ttm, 2), pe_12m: isNum(ttm) && ttm > 0 && isNum(price) ? r2(price / ttm, 1) : null,
    pe_proyectado: fy && fy.eps > 0 && isNum(price) ? { anio_fiscal: fy.fin, eps: fy.eps, pe: r2(price / fy.eps, 1) } : null,
    supero_estimado: ult8.length ? `${ult8.filter((r) => r[2] >= r[3]).length} de ${ult8.length}` : null,
    trimestres: hist.slice(0, 12).map((r) => ({ fin: r[0], reporte: r[1], real: r[2], estimado: r[3], sorpresa_pct: isNum(r[3]) && r[3] ? r2((r[2] / r[3] - 1) * 100 * Math.sign(r[3]), 1) : null })),
    proyecciones: proy.map((x) => ({ periodo: x.periodo === "A" ? "año fiscal" : "trimestre", fin: x.fin, eps: x.eps, alto: x.alto, bajo: x.bajo, analistas: x.n,
      revision_30d_pct: isNum(x.prev30) && x.prev30 ? r2((x.eps - x.prev30) / Math.abs(x.prev30) * 100, 1) : null, sube_30d: x.up30, baja_30d: x.down30 })),
    fcf: f.length ? { fcf_accion_12m: r2(fT, 2), crec_12m_pct: isNum(fT) && isNum(fP) && fP > 0 ? r2((fT / fP - 1) * 100, 1) : null,
      p_fcf: isNum(price) && fT > 0 ? r2(price / fT, 1) : null, rendimiento_fcf_pct: isNum(price) && fT > 0 ? r2(fT / price * 100, 2) : null,
      conversion_fcf_eps_pct: fT > 0 && ttm > 0 ? r2(fT / ttm * 100, 0) : null,
      trimestres: f.slice(0, 8).map((r) => ({ fin: r[0], fcf_accion: r2(r[1], 2) })) } : "sin datos de FCF",
  };
}

const CRITERIOS = {
  dia: (c) => c.ch, semana: (c) => c.ret["1w"], mes: (c) => c.ret["1m"], trimestre: (c) => c.ret["3m"], anio: (c) => c.ret["1y"],
  upside: (c) => c.upside, pe: (c) => (c.f.trailing_pe > 0 ? c.f.trailing_pe : null), forward_pe: (c) => (c.f.forward_pe > 0 ? c.f.forward_pe : null), peg: (c) => (c.f.peg > 0 ? c.f.peg : null),
  rb: (c) => c.L.tiers?.tactico?.rbLive?.ratio, posicion: (c) => (isNum(c.L.tiers?.tactico?.rbLive?.posicion) ? c.L.tiers.tactico.rbLive.posicion * 100 : null),
  roe: (c) => c.f.roe_pct, margen_neto: (c) => c.f.margen_neto_pct, crec_ingresos: (c) => c.f.crec_ingresos_yoy_pct, peso_cartera: (c) => c.pos?.peso, pnl_cartera: (c) => c.pos?.unPct,
};

const HERR = {
  listar_tickers({ sector } = {}) {
    const { S, liveLevels, disp } = MB();
    const pos = S.C?.posiciones || {};
    const lista = MB().allTickers().filter((t) => !sector || (S.M.tickers[t].sector || "").toLowerCase().includes(String(sector).toLowerCase())).map((t) => {
      const i = S.M.tickers[t], L = liveLevels(t);
      return { ticker: t, display: disp(t), nombre: i.nombre, sector: i.sector, tipo: i.tipo, ...precioInfo(t), veredicto: L.nt?.veredicto || null, semaforo_rb: L.rb?.semaforo || null, en_cartera: !!pos[t], alerta: L.alerta || null };
    });
    return { generado_snapshot: S.M.generado, precios_a_las: S.qAt ? new Date(S.qAt).toISOString() : "snapshot", n: lista.length, tickers: lista };
  },
  ficha_ticker({ ticker }) {
    const t = resolver(ticker); if (!t) return noTicker(ticker);
    const { S, liveLevels, periodReturns, portfolio } = MB();
    const i = S.M.tickers[t], L = liveLevels(t), nt = L.nt || {}, f = i.fundamentales || {}, e = i.earnings || {};
    const P = S.C?.posiciones?.[t] ? portfolio() : null, pr = P?.rows.find((r) => r.sym === t), sem = S.C?.semaforo?.[t];
    const ret = periodReturns(t);
    const fr = {}; for (const [k, v] of Object.entries(nt.fuerza_relativa_multi || {})) fr[k] = { texto: v.texto, tendencia: v.tendencia, detalle: v.detalle };
    return {
      ticker: t, nombre: i.nombre, sector: i.sector, industria: f.industria, ...precioInfo(t),
      rendimientos_pct: { semana: r2(ret["1w"], 1), mes: r2(ret["1m"], 1), trimestre: r2(ret["3m"], 1), anio: r2(ret["1y"], 1) },
      niveles: L.tiers ? { tactico_6m: nivelCorto(L.tiers.tactico), estructural_2a: nivelCorto(L.tiers.estructural), historico_5a: nivelCorto(L.tiers.historico) } : (L.err || "sin niveles"),
      veredicto: nt.veredicto, alerta: L.alerta, piso_tendencia: nt.piso_tendencia, volatilidad_anual_pct: nt.vol_anual_pct,
      defensa_tactica: nt.defensa_tactica, defensa_estructural: nt.defensa_estructural, escalas_entrada: nt.escalas_entrada, escalas_salida: nt.escalas_salida,
      semanas_sin_recuperar_maximo: nt.semanas_sin_recuperar_maximo, recuperacion_promedio_semanas: nt.recup_prom_semanas_historico, fuerza_relativa: fr,
      fundamentales: { market_cap: f.market_cap, pe: f.trailing_pe, forward_pe: f.forward_pe, peg: f.peg, eps: f.eps, beta: f.beta, roe_pct: f.roe_pct, roa_pct: f.roa_pct,
        margen_operativo_pct: f.margen_operativo_pct, margen_neto_pct: f.margen_neto_pct, crec_ingresos_yoy_pct: f.crec_ingresos_yoy_pct, crec_eps_yoy_pct: f.crec_eps_yoy_pct,
        ingresos_ttm: f.ingresos_ttm, calidad: f.calidad?.label, consenso: f.consenso, analistas: f.total_analistas, precio_objetivo: f.precio_objetivo,
        upside_pct: isNum(f.precio_objetivo) && isNum(L.price) ? r2((f.precio_objetivo / L.price - 1) * 100, 1) : null, max_52s: f.max_52s, min_52s: f.min_52s,
        sma_50: r2(f.sma_50), sma_200: r2(f.sma_200), insiders_pct: f.pct_insiders, instituciones_pct: f.pct_instituciones, fuente: f.fuente },
      earnings: e.fecha ? { fecha: e.fecha, dias: e.dias_faltantes, eps_estimado: e.eps_estimado, rango: [e.eps_estimado_bajo, e.eps_estimado_alto], ingresos_estimados: e.ingresos_estimados,
        revision_30d_pct: e.revision_pct_30d, revisiones_sube: e.revisiones_up_30d, revisiones_baja: e.revisiones_down_30d, tendencia: e.tendencia_revisiones } : null,
      noticia: i.noticia?.titulo ? i.noticia : null,
      mi_posicion: pr ? { peso_pct: r2(pr.peso, 1), pnl_pct: r2(pr.unPct, 1), costo_prom: r2(pr.avg, 2), semaforo_pilar4: sem?.estado, razones: sem?.razones,
        compras_sin_ganancia: sem?.compras_sin_ganancia, ...(S.masked ? {} : { cantidad: pr.qty, valor: r2(pr.value, 0), pnl_no_realizado: r2(pr.un, 0) }) } : "no está en la cartera",
    };
  },
  async eps_fcf({ ticker }) { const t = resolver(ticker); return t ? epsFcf(t) : noTicker(ticker); },
  cartera,
  oportunidades({ n = 5 } = {}) {
    const { topOportunidades, liveLevels } = MB(); const T = topOportunidades(Math.min(n || 5, 10));
    const fila = (c) => ({ ticker: c.t, ...precioInfo(c.t), veredicto: c.ver, semaforo_rb: c.L.rb.semaforo, posicion_pct: Math.round(c.L.rb.posicion * 100), rb: r2(c.L.rb.ratio, 1), piso: c.L.pisoRef?.precio, techo: c.L.techoRef?.precio });
    const alertas = MB().allTickers().map(liveLevels).filter((L) => L.alerta).map((L) => ({ ticker: L.t, tipo: L.alertaTipo, alerta: L.alerta }));
    return { top_compra: T.compra.map(fila), top_venta: T.venta.map(fila), alertas, metodo: "Posición en el rango piso-techo de referencia (táctico si existe) + bono por veredicto y semáforo R:B, al precio en vivo." };
  },
  ranking({ criterio, orden = "desc", top = 10, solo_cartera = false, sector } = {}) {
    const fn = CRITERIOS[criterio]; if (!fn) return { error: "Criterio no válido", criterios: Object.keys(CRITERIOS) };
    const { S, liveLevels, liveChg, periodReturns, portfolio, livePrice } = MB();
    const P = portfolio(), pos = Object.fromEntries((P?.rows || []).map((r) => [r.sym, r]));
    const filas = MB().allTickers().filter((t) => (!solo_cartera || pos[t]) && (!sector || (S.M.tickers[t].sector || "").toLowerCase().includes(String(sector).toLowerCase()))).map((t) => {
      const f = S.M.tickers[t].fundamentales || {}, price = livePrice(t);
      const c = { t, f, L: liveLevels(t), ch: liveChg(t), ret: periodReturns(t), pos: pos[t], upside: isNum(f.precio_objetivo) && isNum(price) ? (f.precio_objetivo / price - 1) * 100 : null };
      return { ticker: t, valor: r2(fn(c), 2), precio: r2(price, 2), var_dia_pct: r2(c.ch), sector: S.M.tickers[t].sector };
    }).filter((x) => isNum(x.valor)).sort((a, b) => (orden === "asc" ? a.valor - b.valor : b.valor - a.valor));
    if ((criterio === "peso_cartera" || criterio === "pnl_cartera") && !P) return { error: "Sin datos de cartera." };
    return { criterio, orden, n_total: filas.length, filas: filas.slice(0, Math.min(top || 10, 40)) };
  },
  macro() {
    const { S } = MB(); const m = S.M.macro || {}, vivo = {};
    for (const s of ["SPY", "QQQ", "^VIX", "^TNX", "DX-Y.NYB", "COP=X", "BTC-USD"]) { const q = S.Q[s]; vivo[s] = q ? { precio: r2(q.price, 3), var_dia_pct: r2(q.chgPct) } : null; }
    return { snapshot: m, en_vivo: vivo, nota: "^TNX = rendimiento del Tesoro a 10 años ×10 en Yahoo (48,4 = 4,84 %). COP=X = pesos por dólar." };
  },
  agenda({ dias = 45 } = {}) {
    const { S } = MB(); const hoy = Date.now();
    const ev = (S.M.proximos_eventos || []).map((e) => { const d = Math.ceil((new Date(e.fecha) - hoy) / 864e5); const er = S.M.tickers[e.ticker]?.earnings || {};
      return { ...e, dias: d, en_cartera: !!S.C?.posiciones?.[e.ticker], eps_estimado: er.eps_estimado, tendencia_revisiones: er.tendencia_revisiones, revision_30d_pct: er.revision_pct_30d }; })
      .filter((e) => e.dias >= -1 && e.dias <= dias);
    const b = S.M.briefing || {}, limpio = (a) => (a || []).map((x) => String(x).replace(/<[^>]+>/g, ""));
    return { earnings: ev, cambios_del_dia: limpio(b.cambios), acciones: limpio(b.acciones), contexto: limpio(b.contexto), snapshot: S.M.generado };
  },
  movimientos({ ticker } = {}) {
    const { S } = MB(); const C = S.C; if (!C) return { error: "Sin datos de la cuenta." };
    const oc = S.masked;
    if (ticker) {
      const t = resolver(ticker) || String(ticker).toUpperCase(); const m = C.movimientos_12m?.[t];
      if (!m) return { ticker: t, movimientos: [], nota: "Sin compras ni ventas en 12 meses." };
      return { ticker: t, montos_visibles: !oc, movimientos: m.map((x) => ({ fecha: x[0], lado: x[1] === "BUY" ? "compra" : "venta", precio: x[3], ...(oc ? {} : { cantidad: x[2], monto: r2(x[2] * x[3], 0) }) })) };
    }
    return { montos_visibles: !oc, trades_recientes: (C.trades_recientes || []).slice(0, 25).map((x) => ({ fecha: x.date, ticker: x.symbol, lado: x.side === "BUY" ? "compra" : "venta", precio: x.price, ...(oc ? {} : { cantidad: x.qty }) })) };
  },
};
async function ejecutar(nombre, input) {
  try {
    if (!MB()?.S?.M) return { error: "La app todavía no cargó el cálculo diario." };
    const fn = HERR[nombre]; if (!fn) return { error: `Herramienta desconocida: ${nombre}` };
    return await fn(input || {});
  } catch (e) { console.error("[ia]", nombre, e); return { error: "Error al calcular: " + e.message }; }
}
const NOMBRES = { listar_tickers: "Revisando la watchlist", ficha_ticker: "Armando la ficha", eps_fcf: "Leyendo EPS y flujo de caja", cartera: "Valorando la cartera",
  oportunidades: "Buscando oportunidades", ranking: "Ordenando tickers", macro: "Leyendo el panel macro", agenda: "Revisando la agenda", movimientos: "Leyendo movimientos de IBKR", web_search: "Buscando en la web" };

function contexto() {
  const { S } = MB();
  return { ahora: new Date().toISOString(), zona: "America/Bogota", vista: S.view, ticker_abierto: S.sheetT || null, montos_visibles: !S.masked,
    sesion_mercado: S.Q?.SPY?.session || null, precios_a_las: S.qAt ? new Date(S.qAt).toISOString() : null, snapshot_generado: S.M?.generado || null };
}

// ═══════════════════════════════ Interfaz ═══════════════════════════════
const CSS = `
.ia-btn{position:fixed;right:16px;bottom:calc(74px + env(safe-area-inset-bottom,0px));z-index:45;display:flex;align-items:center;gap:7px;padding:11px 15px;border:0;border-radius:999px;
  background:var(--brass);color:#fff;font:700 14px var(--f-ui);box-shadow:0 8px 22px rgba(0,0,0,.22);cursor:pointer}
@media (prefers-color-scheme:dark){.ia-btn{color:#16201B}}
.ia-btn svg{width:17px;height:17px}.ia-btn:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
.ia-panel{position:fixed;top:0;right:0;bottom:0;width:min(480px,100vw);z-index:50;display:flex;flex-direction:column;background:var(--bg);color:var(--ink);
  font:14.5px/1.5 var(--f-ui);box-shadow:-12px 0 32px rgba(0,0,0,.22);transform:translateX(105%);transition:transform .22s ease;padding-top:env(safe-area-inset-top,0px)}
.ia-panel.abierto{transform:none}
@media (prefers-reduced-motion:reduce){.ia-panel{transition:none}}
.ia-cab{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--line);background:var(--surface)}
.ia-cab h2{all:unset;flex:1;font-weight:800;font-size:17px;letter-spacing:-.01em}.ia-cab small{display:block;font-weight:400;font-size:11.5px;color:var(--muted)}
.ia-cab button{border:1px solid var(--line);background:var(--surface);border-radius:9px;padding:6px 10px;font-size:12.5px;font-weight:600;cursor:pointer}
.ia-msgs{flex:1;overflow:auto;padding:14px;display:flex;flex-direction:column;gap:10px;-webkit-overflow-scrolling:touch}
.ia-m{flex-shrink:0;max-width:100%;padding:10px 12px;border-radius:12px;background:var(--surface);border:1px solid var(--line);overflow-x:auto}
.ia-m.yo{align-self:flex-end;background:var(--ink);color:var(--bg);border-color:var(--ink);max-width:86%}
.ia-m p{margin:.35em 0}.ia-m ul,.ia-m ol{margin:.35em 0;padding-left:1.2em}.ia-m code{font-family:var(--f-num);font-size:12.5px}
.ia-m table{border-collapse:collapse;margin:.5em 0;font-size:12.5px;width:100%}
.ia-m th{text-align:left;padding:5px 6px;border-bottom:1px solid var(--line);white-space:nowrap}
.ia-m td{border-bottom:1px solid var(--line);padding:5px 6px;font-family:var(--f-num);font-variant-numeric:tabular-nums;white-space:nowrap}
.ia-m td:first-child{font-family:var(--f-ui)}
.ia-m .tk-link{font-size:inherit}
.ia-m .fuente{margin-top:8px;padding-top:6px;border-top:1px dashed var(--line);font-size:11.5px;color:var(--muted)}
.ia-m a{color:var(--brass)}
.ia-traza{font-size:11.5px;color:var(--muted);margin-top:6px}.ia-traza summary{cursor:pointer}
.ia-traza pre{white-space:pre-wrap;background:var(--sunk);border-radius:8px;padding:6px;max-height:200px;overflow:auto;font:11px var(--f-num)}
.ia-estado{font-size:12.5px;color:var(--muted);display:flex;gap:7px;align-items:center}
.ia-estado:before{content:'';width:8px;height:8px;border-radius:50%;background:var(--brass);animation:iap 1s infinite alternate}
@keyframes iap{from{opacity:.25}to{opacity:1}}
.ia-err{background:var(--down-soft);color:var(--down);border-color:transparent}
.ia-sug{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.ia-sug button{border:1px solid var(--line);background:var(--bg);border-radius:999px;padding:6px 11px;font-size:12.5px;text-align:left;cursor:pointer}
.ia-sug button:hover{border-color:var(--brass);color:var(--brass)}
.ia-pie{display:flex;gap:8px;padding:10px 12px calc(10px + env(safe-area-inset-bottom,0px));border-top:1px solid var(--line);background:var(--surface)}
.ia-pie textarea{flex:1;resize:none;border:1px solid var(--line);border-radius:12px;padding:10px 12px;font:16px var(--f-ui);min-height:44px;max-height:130px;background:var(--bg);color:var(--ink)}
.ia-pie textarea:focus{outline:2px solid var(--brass);outline-offset:1px}
.ia-pie button{border:0;border-radius:12px;background:var(--ink);color:var(--bg);padding:0 16px;font-weight:700;cursor:pointer}
.ia-pie button:disabled{opacity:.45;cursor:default}
.ia-nota{font-size:11px;color:var(--muted);padding:0 14px 6px}
body.ia-open{overflow:hidden}
@media print{.ia-btn,.ia-panel{display:none!important}}`;

// Markdown mínimo y seguro (se escapa todo antes de dar formato)
function md(texto) {
  const lineas = esc(texto).split("\n"); let html = "", i = 0;
  const inline = (s) => s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/(^|[^*])\*(?!\s)(.+?)\*/g, "$1<em>$2</em>").replace(/`([^`]+)`/g, "<code>$1</code>");
  while (i < lineas.length) {
    const l = lineas[i];
    if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < lineas.length && /^\s*\|[\s:|-]+\|/.test(lineas[i + 1])) {
      const celdas = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => inline(c.trim()));
      html += "<table><thead><tr>" + celdas(l).map((c) => `<th>${c}</th>`).join("") + "</tr></thead><tbody>"; i += 2;
      while (i < lineas.length && /^\s*\|/.test(lineas[i])) { html += "<tr>" + celdas(lineas[i]).map((c) => `<td>${c}</td>`).join("") + "</tr>"; i++; }
      html += "</tbody></table>"; continue;
    }
    if (/^\s*[-*•]\s+/.test(l)) { html += "<ul>"; while (i < lineas.length && /^\s*[-*•]\s+/.test(lineas[i])) { html += `<li>${inline(lineas[i].replace(/^\s*[-*•]\s+/, ""))}</li>`; i++; } html += "</ul>"; continue; }
    if (/^\s*\d+[.)]\s+/.test(l)) { html += "<ol>"; while (i < lineas.length && /^\s*\d+[.)]\s+/.test(lineas[i])) { html += `<li>${inline(lineas[i].replace(/^\s*\d+[.)]\s+/, ""))}</li>`; i++; } html += "</ol>"; continue; }
    if (/^#{1,4}\s/.test(l)) { html += `<p><strong>${inline(l.replace(/^#+\s/, ""))}</strong></p>`; i++; continue; }
    if (/^\s*(fuente|fuentes)\s*:/i.test(l)) { html += `<div class="fuente">${inline(l)}</div>`; i++; continue; }
    if (l.trim()) html += `<p>${inline(l)}</p>`;
    i++;
  }
  return html;
}
// Los tickers de la app en negrita o en tablas se vuelven enlaces a su ficha.
function enlazarTickers(el) {
  const T = new Set(MB()?.allTickers() || []);
  el.querySelectorAll("strong, td:first-child").forEach((n) => {
    const t = n.textContent.trim().toUpperCase();
    if (T.has(t) && !n.querySelector("button")) n.innerHTML = `<button type="button" class="tk-link" data-t="${esc(t)}">${esc(n.textContent.trim())}</button>`;
  });
}

function sugeridas() {
  const S = MB()?.S, t = S?.sheetT;
  const base = [
    "¿Cómo va mi cartera hoy y qué la está moviendo?",
    "¿Qué tickers están cerca de su piso de compra con R:B verde?",
    "¿Estoy incumpliendo alguna regla de la DCLA? ¿Qué haría falta para cumplir?",
    "¿Qué earnings vienen en las próximas 2 semanas y cuáles tengo en cartera?",
    "Ordena la watchlist por upside al precio objetivo",
    "¿Cómo está el régimen macro y qué significa para mis posiciones de chips?",
  ];
  return t ? [`Analiza ${t} con mi Consejo de inversión`, `¿Por qué se mueve ${t} hoy?`, `¿${t} está caro o barato por P/E y P/FCF?`, ...base.slice(0, 3)] : base;
}

let ui = null;
function montar() {
  if (ui) return ui;
  const st = document.createElement("style"); st.textContent = CSS; document.head.appendChild(st);
  const btn = document.createElement("button");
  btn.className = "ia-btn"; btn.type = "button"; btn.setAttribute("aria-label", "Preguntar a la IA");
  btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3l1.8 4.6L18 9.4l-4.2 1.8L12 16l-1.8-4.8L6 9.4l4.2-1.8z"/><path d="M19 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/></svg>IA';
  document.body.appendChild(btn);

  const el = document.createElement("aside");
  el.className = "ia-panel"; el.setAttribute("role", "dialog"); el.setAttribute("aria-label", "Asistente IA");
  el.innerHTML = `<div class="ia-cab"><h2>Asistente IA<small>Con tus datos en vivo y búsqueda web</small></h2>
      <button type="button" data-a="nueva">Nueva</button><button type="button" data-a="cerrar" aria-label="Cerrar">✕</button></div>
    <div class="ia-msgs" aria-live="polite"></div>
    <div class="ia-nota" style="background:var(--surface)">Información para decidir, no recomendación. Verifica con la línea Fuente.</div>
    <form class="ia-pie"><textarea rows="1" placeholder="Pregunta sobre tus inversiones…" enterkeyhint="send"></textarea><button type="submit">Enviar</button></form>`;
  document.body.appendChild(el);
  const $msgs = el.querySelector(".ia-msgs"), $form = el.querySelector("form"), $txt = el.querySelector("textarea"), $send = el.querySelector("form button");

  let mensajes = [], ocupado = false, conversacion = nuevaId();
  function nuevaId() { return (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()); }
  const abrir = () => { if (!mensajes.length) bienvenida(); el.classList.add("abierto"); document.body.classList.add("ia-open"); btn.hidden = true; if (matchMedia("(hover:hover)").matches) setTimeout(() => $txt.focus(), 220); };
  const cerrar = () => { el.classList.remove("abierto"); document.body.classList.remove("ia-open"); btn.hidden = false; };
  btn.addEventListener("click", abrir);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && el.classList.contains("abierto")) { e.stopPropagation(); cerrar(); } }, true);
  // Tocar un ticker en la respuesta: cierra el chat (la conversación queda) y abre su ficha.
  el.addEventListener("click", (e) => { if (e.target.closest("[data-t]")) cerrar(); });

  function bienvenida() {
    $msgs.innerHTML = "";
    const m = document.createElement("div"); m.className = "ia-m";
    const t = MB()?.S?.sheetT;
    m.innerHTML = `<p>Pregúntame por tus posiciones, niveles, valuación, reglas DCLA, earnings o noticias${t ? ` — o sobre <strong>${esc(t)}</strong>, que tienes abierto` : ""}. Algunas ideas:</p><div class="ia-sug"></div>`;
    const sug = m.querySelector(".ia-sug");
    for (const q of sugeridas()) { const b = document.createElement("button"); b.type = "button"; b.textContent = q; b.onclick = () => { $txt.value = q; $form.requestSubmit(); }; sug.appendChild(b); }
    $msgs.appendChild(m);
  }
  el.querySelector("[data-a=cerrar]").onclick = cerrar;
  el.querySelector("[data-a=nueva]").onclick = () => { if (ocupado) return; mensajes = []; conversacion = nuevaId(); bienvenida(); };
  $txt.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && matchMedia("(hover:hover)").matches) { e.preventDefault(); $form.requestSubmit(); } });
  $txt.addEventListener("input", () => { $txt.style.height = "auto"; $txt.style.height = Math.min($txt.scrollHeight, 130) + "px"; });

  const burbuja = (cls, html) => { const d = document.createElement("div"); d.className = "ia-m " + cls; d.innerHTML = html; $msgs.appendChild(d); $msgs.scrollTop = $msgs.scrollHeight; return d; };

  async function llamar(pregunta) {
    const { data, error } = await MB().sb.functions.invoke("mb-copilot", { body: { messages: mensajes, contexto: contexto(), conversacion, pregunta } });
    if (error) {
      let msg = error.message;
      try { const j = await error.context?.json?.(); if (j?.error) msg = j.error; } catch (_) {}
      throw new Error(msg);
    }
    if (data?.error) throw new Error(data.error);
    return data;
  }

  $form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = $txt.value.trim();
    if (!q || ocupado) return;
    ocupado = true; $send.disabled = true; $txt.value = ""; $txt.style.height = "";
    burbuja("yo", esc(q));
    const largoAntes = mensajes.length;
    mensajes.push({ role: "user", content: q });
    const estado = burbuja("", '<div class="ia-estado">Pensando…</div>');
    const traza = [];
    try {
      for (let vuelta = 0; vuelta < MAX_VUELTAS; vuelta++) {
        const resp = await llamar(vuelta === 0 ? q : null);
        const content = resp.content || [];
        mensajes.push({ role: "assistant", content });
        for (const b of content) if (b.type === "server_tool_use") traza.push({ nombre: "web_search", input: b.input, resumen: "(búsqueda web de Claude)" });
        if (resp.stop_reason === "pause_turn") { estado.innerHTML = '<div class="ia-estado">Buscando en la web…</div>'; continue; }
        const usos = content.filter((b) => b.type === "tool_use");
        if (resp.stop_reason !== "tool_use" || !usos.length) {
          const texto = content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
          estado.innerHTML = md(texto || "(sin respuesta)");
          enlazarTickers(estado);
          if (traza.length) {
            const det = document.createElement("details"); det.className = "ia-traza";
            det.innerHTML = `<summary>Ver datos usados (${traza.length})</summary>` + traza.map((t) => `<pre><b>${esc(t.nombre)}</b> ${esc(JSON.stringify(t.input))}\n→ ${esc(t.resumen)}</pre>`).join("");
            estado.appendChild(det);
          }
          break;
        }
        const resultados = [];
        for (const u of usos) {
          estado.innerHTML = `<div class="ia-estado">${esc(NOMBRES[u.name] || u.name)}…</div>`;
          const salida = await ejecutar(u.name, u.input);
          let txt = JSON.stringify(salida);
          if (txt.length > MAX_RESULTADO) txt = txt.slice(0, MAX_RESULTADO) + "…[recortado: pide un filtro, un sector o menos filas]";
          traza.push({ nombre: u.name, input: u.input, resumen: txt.slice(0, 500) + (txt.length > 500 ? "…" : "") });
          resultados.push({ type: "tool_result", tool_use_id: u.id, content: txt, is_error: !!salida?.error });
        }
        mensajes.push({ role: "user", content: resultados });
        estado.innerHTML = '<div class="ia-estado">Redactando…</div>';
        if (vuelta === MAX_VUELTAS - 1) estado.innerHTML = md("No logré cerrar la respuesta. Prueba con una pregunta más acotada (un ticker o un sector).");
      }
    } catch (err) {
      estado.classList.add("ia-err"); estado.textContent = err.message || String(err);
      mensajes.length = largoAntes;
    } finally {
      ocupado = false; $send.disabled = false; $msgs.scrollTop = $msgs.scrollHeight;
    }
  });
  ui = { abrir, cerrar, preguntar: (q) => { abrir(); $txt.value = q; $form.requestSubmit(); } };
  return ui;
}

// Se monta cuando la app ya tiene sesión y datos (window.MB existe y la app está visible).
function intentar() {
  const app = document.getElementById("app");
  if (!app) return;
  if (window.MB && !app.hidden) montar();
  if (ui) { if (app.hidden) ui.cerrar(); document.querySelector(".ia-btn").style.display = app.hidden ? "none" : ""; }
}
new MutationObserver(intentar).observe(document.getElementById("app"), { attributes: true, attributeFilter: ["hidden"] });
intentar();
window.MBCopiloto = { abrir: () => montar().abrir(), preguntar: (q) => montar().preguntar(q), ejecutar, md };
})();
