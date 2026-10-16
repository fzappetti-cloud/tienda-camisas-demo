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
  maxPagesPerCategory: 60,     // 12 por página = 720 productos por categoría
  maxRequestsPerStore: 450,
  maxMsPerStore: 4 * 60 * 1000,
};
// Secciones que no son prendas del catálogo (promos que repiten productos, páginas informativas, etc.)
// Incluye los enlaces genéricos que listan TODO el catálogo ("Ver colección", "Productos"): si entraran como categoría
// se llevarían todos los productos y las categorías reales quedarían vacías.
const EXCLUDE = /descuent|oferta|liquidaci|cyber|nuev|new-|temporada|search|account|contact|donde|como-comprar|preguntas|politica|arrepent|fragancia|kids|carrito|\/productos\/|ver\s+colec|ver\s+todo|todos?\s+los\s+productos|^productos$|^tienda$/i;
const OUT = path.join(__dirname, '..', 'data', 'catalog.json');
const STATUS = path.join(__dirname, '..', 'data', 'status.json');
const CONFIG = path.join(__dirname, '..', 'data', 'config.json');       // categorías tildadas por la clienta
const CATS = path.join(__dirname, '..', 'data', 'categories.json');     // todas las categorías detectadas
const sleep = ms => new Promise(r => setTimeout(r, ms));

function cleanName(n) { return String(n || '').replace(/\s*[-(]\s*[\w ]*\d{3,}\)?\s*$/, '').trim(); }
function titleCase(t) { t = t.replace(/\s+/g, ' ').trim().toLowerCase(); return t.charAt(0).toUpperCase() + t.slice(1); }

function parseProducts(html, baseUrl) {
  const out = []; const seen = new Set(); const sizes = parseSizes(html);
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
      const pth = String(url).replace(/^https?:\/\/[^/]+/i, '').split('?')[0];
      const item = { name: cleanName(x.name), price, image, url: url || baseUrl };
      if (sizes[pth]) item.sz = sizes[pth];
      out.push(item);
    }
  }
  return out;
}

// Talles disponibles por producto: cada tarjeta de la tienda trae un atributo data-variants (JSON) con las variantes
// (color/talle) y si están disponibles. Se asocia al producto por el enlace /productos/ que aparece justo después.
const SIZE_ORDER = ['XXS','XS','S','M','L','XL','XXL','XXXL','U','UNICO','ÚNICO'];
function variantSizes(arr) {
  const set = new Set();
  for (const v of arr) {
    if (!v || v.available === false || v.is_visible === false) continue;
    const opts = [v.option0, v.option1, v.option2].filter(Boolean);
    if (opts.length) set.add(String(opts[opts.length - 1]).trim().toUpperCase());   // el talle es la última opción (antes va el color)
  }
  return [...set].sort((a, b) => (SIZE_ORDER.indexOf(a) + 1 || 99) - (SIZE_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b));
}
const unescapeAttr = t => t.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'");
function parseSizes(html) {
  const map = {};
  const re = /data-variants=(["'])([\s\S]*?)\1/gi;
  let m;
  while ((m = re.exec(html))) {
    let arr; try { arr = JSON.parse(m[2].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'")); } catch { continue; }
    if (!Array.isArray(arr)) continue;
    // el atributo puede pesar ~40 KB: el enlace del producto se busca DESPUÉS de que termina, hasta la próxima tarjeta
    const end = m.index + m[0].length, nxt = html.indexOf('data-variants=', end);
    const after = html.slice(end, nxt > 0 ? nxt : end + 15000);
    const h = /href=["'](?:https?:\/\/[^/"']+)?(\/productos\/[^"'?#]+)/i.exec(after);
    if (!h) continue;
    const sizes = variantSizes(arr);
    map[h[1]] = sizes;
  }
  return map;
}

// Página de UN producto (el enlace que pega la clienta). Ojo: los datos JSON-LD de estas páginas son de los productos
// RELACIONADOS, no del principal; el principal se lee del título (og:title), la imagen (og:image) y el bloque #single-product.
function parseProductPage(html, url) {
  const meta = p => { const m = new RegExp('<meta[^>]+property=["\']' + p + '["\'][^>]*content=["\']([^"\']*)["\']', 'i').exec(html) || new RegExp('<meta[^>]+content=["\']([^"\']*)["\'][^>]*property=["\']' + p + '["\']', 'i').exec(html); return m ? m[1].replace(/&amp;/g, '&').trim() : ''; };
  const tag = /<[a-z]+\b[^>]*\bid=["']single-product["'][^>]*>/i.exec(html);
  const name = cleanName(meta('og:title') || ((/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html) || [])[1] || '').replace(/<[^>]+>/g, ''));
  const image = meta('og:image').replace(/^http:\/\//i, 'https://');   // la tienda la publica con http: se pasa a https
  const vm = tag && /data-variants=(["'])([\s\S]*?)\1/i.exec(tag[0]);
  let arr = []; if (vm) { try { arr = JSON.parse(unescapeAttr(vm[2])); } catch {} }
  if (!name || !image || !Array.isArray(arr) || !arr.length) throw new Error('no se pudo leer el producto (¿es la página de un producto?)');
  const sz = variantSizes(arr);
  const prices = arr.filter(v => v && v.available !== false).map(v => Number(v.price_number)).filter(Boolean);
  const price = prices.length ? Math.min(...prices) : Number(meta('product:price:amount')) || 0;
  const rest = html.replace(tag[0], tag[0].replace(/data-variants=(["'])[\s\S]*?\1/i, ''));   // sin el bloque principal, para no mezclar talles
  const path = String(url).replace(/^https?:\/\/[^/]+/i, '').split('?')[0];
  const related = parseProducts(rest, url).filter(p => String(p.url).replace(/^https?:\/\/[^/]+/i, '').split('?')[0] !== path).slice(0, 8);
  return { name, price, image, url, sz, available: sz.length > 0, related };
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

async function crawlStore(key, get = null, origin = null, selected = null) {
  const s = STORES[key]; origin = origin || s.origin;
  const budget = { requests: 0, deadline: Date.now() + LIMITS.maxMsPerStore };
  get = get || makeFetcher(budget);
  const home = await get(origin + '/');
  if (home.status !== 200) throw new Error('portada no disponible');
  const allCats = discoverCategories(home.html);
  if (!allCats.length) throw new Error('no se encontraron categorías en el menú');
  // selected = rutas tildadas por la clienta (null = todas; [] = ninguna, solo se detectan las categorías)
  const cats = selected ? allCats.filter(c => selected.includes(c.path)) : allCats;
  // Un producto puede estar en varias categorías (p. ej. un vestido en "Vestidos" y en "Fiesta"): se guarda una vez con todas sus categorías.
  const byUrl = new Map(); const report = []; const errors = [];
  for (const c of cats) {
    let count = 0; const catSeen = new Set();
    try {
      for (let page = 1; page <= LIMITS.maxPagesPerCategory; page++) {
        const r = await get(origin + c.path + (page > 1 ? '?page=' + page : ''));
        if (r.status !== 200) break;
        const list = parseProducts(r.html, origin + c.path);
        const fresh = list.filter(p => !catSeen.has(p.url || p.name));
        if (!fresh.length) break;                                    // página vacía o repetida: fin de la categoría
        fresh.forEach(p => {
          const k = p.url || p.name; catSeen.add(k);
          const ex = byUrl.get(k);
          if (ex) { if (!ex.cats.includes(c.name)) ex.cats.push(c.name); }
          else byUrl.set(k, { ...p, cat: c.name, cats: [c.name] });
        });
        count += fresh.length;
      }
    } catch (e) { errors.push(c.name + ': ' + String(e.message || e)); }
    report.push({ category: c.name, path: c.path, count, capped: count >= LIMITS.maxPagesPerCategory * 12 });
  }
  const products = [...byUrl.values()];
  if (cats.length && !products.length) throw new Error('sin productos');
  return { name: s.name, url: origin + '/', products, categories: report, allCategories: allCats, errors, requests: budget.requests };
}

// Talles: en Rumba vienen en pares ("SM" = S y M, "LXL" = L y XL). Un talle de la tienda coincide si alguno de sus componentes fue elegido.
const KNOWN_SIZES = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', 'U'];
const sizeTokens = z => String(z).toUpperCase().match(/XXXL|XXL|XXS|XL|XS|S|M|L|U/g) || [];
const sizeMatches = (z, wanted) => sizeTokens(z).some(t => wanted.includes(t));
function applySizes(products, wanted) {
  if (!wanted || !wanted.length) return { products, dropped: 0 };
  const out = []; let dropped = 0;
  for (const p of products) {
    if (!p.sz) { out.push(p); continue; }                 // la tienda no informó talles: se conserva y ella los revisa
    const ok = p.sz.filter(z => sizeMatches(z, wanted));
    if (ok.length) out.push({ ...p, sz: ok }); else dropped++;
  }
  return { products: out, dropped };
}

// Validación de la selección pegada desde el tablero ("Copiar selección"): solo rutas de primer nivel /slug/
function validateSelection(raw) {
  let j; try { j = JSON.parse(raw); } catch { throw new Error('la selección no es un JSON válido'); }
  const out = { categories: {} };
  for (const k of Object.keys(STORES)) {
    const arr = j && j.categories && j.categories[k];
    if (arr === undefined) { out.categories[k] = []; continue; }
    if (!Array.isArray(arr) || arr.length > 40 || !arr.every(x => typeof x === 'string' && /^\/[a-z0-9-]+\/$/i.test(x))) throw new Error('selección inválida en la tienda ' + k);
    out.categories[k] = [...new Set(arr)];
  }
  const t = j && j.talles;
  if (t !== undefined && (!Array.isArray(t) || !t.every(x => KNOWN_SIZES.includes(x)))) throw new Error('talles inválidos');
  out.talles = [...new Set(t || [])];
  return out;
}
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const summary = st => Object.fromEntries(Object.entries(st).map(([k, v]) => [k, v.ok ? { ok: true, count: v.count, requests: v.requests, selected: v.selected } : v]));

// PASO 1 · "categorias": lee solo la portada de cada tienda (1 pedido) y guarda los tipos de prenda. No toca el catálogo.
async function runCategories() {
  const prev = readJson(CATS, { stores: {} });
  const out = { updated: new Date().toISOString(), stores: { ...(prev.stores || {}) } };
  const status = {};
  for (const key of Object.keys(STORES)) {
    try {
      const st = await crawlStore(key, null, null, []);
      out.stores[key] = { name: st.name, categories: st.allCategories };
      status[key] = { ok: true, count: st.allCategories.length, requests: st.requests };
    } catch (e) { status[key] = { ok: false, error: String(e.message || e) }; }
  }
  if (Object.values(status).some(s => s.ok)) fs.writeFileSync(CATS, JSON.stringify(out));
  console.log(JSON.stringify({ paso: 'categorias', stores: status }));
  return Object.values(status).every(s => s.ok);
}

// PASO 2 · "catalogo": trae SOLO las categorías tildadas (data/config.json); si no hay ninguna tildada, trae todo lo que encuentra.
async function runCatalog() {
  if (process.env.SELECCION && process.env.SELECCION.trim()) fs.writeFileSync(CONFIG, JSON.stringify(validateSelection(process.env.SELECCION), null, 2));
  const cfg = readJson(CONFIG, null);
  const sel = (cfg && cfg.categories) || {};
  const wanted = (cfg && cfg.talles) || [];
  // Sin ningún tipo tildado = trae todo lo que encuentra (con los talles disponibles). Con alguno tildado = solo esos.
  const anySel = Object.values(sel).some(a => Array.isArray(a) && a.length);
  const prev = readJson(OUT, {});
  const next = { updated: new Date().toISOString(), stores: {} };
  const status = { run: next.updated, stores: {} };
  for (const key of Object.keys(STORES)) {
    const picked = anySel ? (Array.isArray(sel[key]) ? sel[key] : []) : null;      // null = todas las categorías
    if (anySel && !picked.length) { status.stores[key] = { ok: true, count: 0, requests: 0, selected: 0 }; continue; }   // tienda sin selección: no se consulta
    try {
      const st = await crawlStore(key, null, null, picked);
      const f = applySizes(st.products, wanted);
      next.stores[key] = { name: st.name, url: st.url, products: f.products };
      status.stores[key] = { ok: true, count: f.products.length, sinTalleElegido: f.dropped, talles: wanted, requests: st.requests, categories: st.categories, errors: st.errors, selected: picked ? picked.length : 'todas' };
    } catch (e) {
      status.stores[key] = { ok: false, error: String(e.message || e) };
      if (prev.stores && prev.stores[key]) next.stores[key] = prev.stores[key];     // si falla, conserva la copia anterior de esa tienda
    }
  }
  fs.writeFileSync(STATUS, JSON.stringify(status, null, 2));
  if (Object.values(status.stores).some(s => s.ok)) fs.writeFileSync(OUT, JSON.stringify(next));
  console.log(JSON.stringify({ paso: 'catalogo', run: status.run, stores: summary(status.stores) }));
  return Object.values(status.stores).every(s => s.ok);
}

async function main() {
  process.on('uncaughtException', e => { console.log(JSON.stringify({ error: String(e.message || e) })); process.exit(1); });
  const mode = process.argv[2];
  if (mode === 'producto') {   // node scraper/sync.js producto <enlace>: lee un solo producto (1 pedido). Solo enlaces de las tiendas conocidas.
    const u = new URL(process.argv[3] || '');
    if (u.protocol !== 'https:' || !Object.values(STORES).some(s => new URL(s.origin).hostname.replace(/^www\./, '') === u.hostname.replace(/^www\./, '')) || !/^\/productos\/[^/]+\/?$/.test(u.pathname)) throw new Error('enlace no válido: tiene que ser la página de un producto de Vintage BSAS o Rumba Helguera');
    const get = makeFetcher({ requests: 0, deadline: Date.now() + 60000 });
    const r = await get(u.origin + u.pathname);
    if (r.status !== 200) throw new Error('producto no disponible');
    console.log(JSON.stringify(parseProductPage(r.html, u.origin + u.pathname), null, 1)); process.exit(0);
  }
  if (mode !== 'categorias' && mode !== 'catalogo') { console.log('Uso: node scraper/sync.js categorias | catalogo'); process.exit(2); }
  const ok = mode === 'categorias' ? await runCategories() : await runCatalog();
  process.exit(ok ? 0 : 1);
}
if (require.main === module) main(); else module.exports = { parseProductPage, applySizes, parseSizes, parseProducts, discoverCategories, crawlStore, validateSelection, LIMITS };
