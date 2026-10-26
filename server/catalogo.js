'use strict';
/**
 * Actualización del catálogo POR ORDEN (botón "Actualizar" del tablero).
 * - Nada corre solo: solo se ejecuta cuando alguien con la clave de administrador lo pide.
 * - Una actualización a la vez; pausa mínima entre actualizaciones; cada tienda tiene tope de pedidos y de tiempo
 *   (los límites vienen del scraper: timeout por pedido, reintentos acotados, tope de páginas).
 * - Si una tienda falla, se conserva la copia anterior de esa tienda.
 */
const fs = require('fs'), path = require('path');
const VALID = ['A', 'B'];             // Vintage BSAS y Rumba Helguera
const COOLDOWN_MS = 60 * 1000;        // pausa mínima entre actualizaciones


// Compara con la copia anterior: marca prendas nuevas, cambios de precio y las que ya no están. La clave es el enlace del producto.
function comparar(prevStore, products, now) {
  const prev = new Map(((prevStore && prevStore.products) || []).map(p => [p.url || p.name, p]));
  const primera = !prev.size; let nuevas = 0, precio = 0; const seen = new Set();
  const out = products.map(p => {
    const key = p.url || p.name, o = prev.get(key); seen.add(key);
    const q = { ...p, first: o ? (o.first || now) : now };
    if (!primera && !o) { q.nuevo = true; nuevas++; }
    if (o && o.price !== p.price) { q.prevPrice = o.price; precio++; }
    return q;
  });
  const quitadas = primera ? [] : [...prev.entries()].filter(([k]) => !seen.has(k)).slice(0, 300).map(([, o]) => ({ name: o.name, url: o.url }));
  return { products: out, nuevas, precio, quitadas, primera };
}

function createCatalogo(cfg) {
  const crawl = cfg.crawlStore || require('../scraper/sync.js').crawlStore;
  const file = path.join(cfg.dataDir, 'catalogo.json');
  const readSaved = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; } };
  let job = { running: false, startedAt: null, finishedAt: null, stores: {} };
  let lastEnd = 0;

  function datos() { const s = readSaved(); return s || { updated: null, stores: {} }; }
  function estado() { return { running: job.running, startedAt: job.startedAt, finishedAt: job.finishedAt, stores: job.stores }; }

  function iniciar(stores) {
    const list = [...new Set(Array.isArray(stores) ? stores : [])];
    if (!list.length || list.length > VALID.length || !list.every(k => VALID.includes(k))) return { code: 400, error: 'elegí una o dos distribuidoras válidas' };
    if (job.running) return { code: 409, error: 'ya hay una actualización en curso' };
    const wait = COOLDOWN_MS - (Date.now() - lastEnd);
    if (lastEnd && wait > 0) return { code: 429, error: 'esperá ' + Math.ceil(wait / 1000) + ' segundos antes de actualizar de nuevo' };
    job = { running: true, startedAt: new Date().toISOString(), finishedAt: null, stores: Object.fromEntries(list.map(k => [k, { state: 'esperando' }])) };
    run(list).catch(() => {});        // no se queda esperando: el tablero consulta el estado
    return { code: 202, estado: estado() };
  }

  async function run(list) {
    const prev = readSaved() || { updated: null, stores: {} };
    const next = { updated: prev.updated, stores: { ...prev.stores } };
    try {
      for (const k of list) {         // una tienda por vez, sin bucles: lista fija
        job.stores[k] = { state: 'leyendo' };
        try {
          const st = await crawl(k, null, null, null);   // todas las categorías; los filtros se aplican después en el tablero
          const now = new Date().toISOString(), d = comparar(prev.stores[k], st.products, now);   // "macheo" contra la copia anterior (por enlace del producto)
          next.stores[k] = { name: st.name, url: st.url, updated: now, products: d.products, quitadas: d.quitadas, categories: st.allCategories };
          job.stores[k] = { state: 'ok', count: d.products.length, requests: st.requests, errors: (st.errors || []).length, nuevas: d.nuevas, precio: d.precio, quitadas: d.quitadas.length, primera: d.primera };
        } catch (e) {
          job.stores[k] = { state: 'error', error: String(e && e.message || e).slice(0, 160) };   // se conserva la copia anterior
        }
      }
      if (Object.values(job.stores).some(s => s.state === 'ok')) {
        next.updated = new Date().toISOString();
        fs.mkdirSync(cfg.dataDir, { recursive: true });
        const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(next)); fs.renameSync(tmp, file);   // escritura atómica
      }
    } finally { job.running = false; job.finishedAt = new Date().toISOString(); lastEnd = Date.now(); }
  }
  return { iniciar, estado, datos, VALID };
}
module.exports = { createCatalogo, comparar };
