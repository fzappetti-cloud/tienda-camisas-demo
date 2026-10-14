// Recorre el catálogo público de cada distribuidora, categoría por categoría y página por página,
// leyendo los datos estructurados JSON-LD que la tienda publica para Google. Sin dependencias (Node 18+).
// Reglas del proyecto: timeout por pedido, máx. reintentos, tope de páginas/pedidos/tiempo, pausa entre
// pedidos, sin bucles sin salida. Si algo falla conserva la copia anterior (data/catalog.json).
const fs = require('fs');
const path = require('path');

const STORES = {
  A: { name: 'Vintage BSAS', origin: 'https://www.vintagebsas.com.ar' },
  B: { name: 'Rumba Helguera', origin: 'https://www.rumbahelguera.com.ar' },
};
const LIMITS = {
  timeoutMs: 20000,      // por pedido
  retries: 2,            // reintentos extra por pedido
  pauseMs: 700,          // pausa entre pedidos (no saturar la tienda)
  maxPagesPerCategory: 15,
  maxRequestsPerStore: 300,
  maxMsPerStore: 4 * 60 * 1000,
};
// Secciones que no son prendas del catálogo (promos que repiten productos, páginas informativas, etc.)
const EXCLUDE = /descuent|oferta|liquidaci|cyber|nuev|new-|temporada|search|account|contact|donde|como-comprar|preguntas|politica|arrepent|fragancia|kids|carrito/i;
const OUT = path.join(__dirname, '..', 'data', 'catalog.json');
const STATUS = path.join(__dirname, '..', 'data', 'status.json');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function cleanName(n) { return String(n || '').replace(/\s*[-(]\s*[\w ]*\d{3,}\)?\s*$/, '').trim(); }
function titleCase(t) { t = t.replace(/\s+/g, ' ').trim().toLowerCase(); return t.charAt(0).toUpperCase() + t.slice(1); }

function parseProducts(html, baseUrl) {
  const out = []; const seen = new Set();
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let j; try { j = JSON.parse(m[1]); } catch { continue; }
    for (const x of (Array.isArray(j) ? j : [j])) {
      if (!x || x['@type'] !== 'Product') continue;
      const off = Array.isArray(x.offers) ? x.offers[0] : x.offers;
      const price = Number(off && (off.price || off.lowPrice));
      const image = Array.isArray(x.image) ? x.image[0] : x.image;
      const url = x.url || (off && off.url) || '';
      const key = url || x.name;
      if (!price || !image || !x.name || seen.has(key)) continue;
      seen.add(key);
      out.push({ name: cleanName(x.name), price, image, url: url || baseUrl });
    }
  }
  return out;
}

// Categorías de primer nivel que aparecen en el menú de la portada.
function discoverCategories(html) {
  const cats = new Map();
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    let href = m[1].trim().split('#')[0];
    const text = m[2].replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
    if (!href || !text || href.includes('?')) continue;
    href = href.replace(/^https?:\/\/[^/]+/i, '');
    if (!/^\/[a-z0-9-]+\/$/i.test(href)) continue;           // solo primer nivel: /camisas/
    if (EXCLUDE.test(href) || EXCLUDE.test(text)) continue;
    if (!cats.has(href)) cats.set(href, titleCase(text));
  }
  return [...cats].map(([p, name]) => ({ path: p, name }));
}

function makeFetcher(budget) {
  return async function get(url) {
    let lastErr;
    for (let i = 0; i <= LIMITS.retries; i++) {
      if (budget.requests >= LIMITS.maxRequestsPerStore) throw new Error('tope de pedidos alcanzado');
      if (Date.now() > budget.deadline) throw new Error('tope de tiempo alcanzado');
      budget.requests++;
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(LIMITS.timeoutMs), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; catalogo-sync/2.0)', 'Accept-Language': 'es-AR' } });
        if (r.status === 404) return { status: 404, html: '' };      // la tienda muestra productos en su 404: no sirven
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const html = await r.text();
        await sleep(LIMITS.pauseMs);
        return { status: 200, html };
      } catch (e) { lastErr = e; await sleep(1500 * (i + 1)); }
    }
    throw lastErr;
  };
}

async function crawlStore(key, get = null, origin = null) {
  const s = STORES[key]; origin = origin || s.origin;
  const budget = { requests: 0, deadline: Date.now() + LIMITS.maxMsPerStore };
  get = get || makeFetcher(budget);
  const home = await get(origin + '/');
  if (home.status !== 200) throw new Error('portada no disponible');
  const cats = discoverCategories(home.html);
  if (!cats.length) throw new Error('no se encontraron categorías en el menú');
  const products = []; const seen = new Set(); const report = []; const errors = [];
  for (const c of cats) {
    let count = 0;
    try {
      for (let page = 1; page <= LIMITS.maxPagesPerCategory; page++) {
        const r = await get(origin + c.path + (page > 1 ? '?page=' + page : ''));
        if (r.status !== 200) break;
        const list = parseProducts(r.html, origin + c.path);
        const fresh = list.filter(p => !seen.has(p.url || p.name));
        if (!fresh.length) break;                                    // página vacía o repetida: fin de la categoría
        fresh.forEach(p => { seen.add(p.url || p.name); products.push({ ...p, cat: c.name }); });
        count += fresh.length;
      }
    } catch (e) { errors.push(c.name + ': ' + String(e.message || e)); }
    report.push({ category: c.name, path: c.path, count });
  }
  if (!products.length) throw new Error('sin productos');
  return { name: s.name, url: origin + '/', products, categories: report, errors, requests: budget.requests };
}

async function main() {
  let prev = {}; try { prev = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch {}
  const next = { updated: new Date().toISOString(), stores: { ...(prev.stores || {}) } };
  const status = { run: next.updated, stores: {} };
  for (const key of Object.keys(STORES)) {
    try {
      const st = await crawlStore(key);
      next.stores[key] = { name: st.name, url: st.url, products: st.products };
      status.stores[key] = { ok: true, count: st.products.length, requests: st.requests, categories: st.categories, errors: st.errors };
    } catch (e) { status.stores[key] = { ok: false, error: String(e.message || e) }; }
  }
  fs.writeFileSync(STATUS, JSON.stringify(status, null, 2));
  if (Object.values(status.stores).some(s => s.ok)) fs.writeFileSync(OUT, JSON.stringify(next));
  console.log(JSON.stringify({ run: status.run, stores: Object.fromEntries(Object.entries(status.stores).map(([k, v]) => [k, v.ok ? { ok: true, count: v.count, requests: v.requests } : v])) }));
  process.exit(Object.values(status.stores).every(s => s.ok) ? 0 : 1);
}
if (require.main === module) main(); else module.exports = { parseProducts, discoverCategories, crawlStore, LIMITS };
