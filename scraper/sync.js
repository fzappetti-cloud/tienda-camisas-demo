// Lee el catálogo público de cada distribuidora (datos estructurados JSON-LD que la tienda
// publica para Google) y guarda data/catalog.json. Sin dependencias (Node 18+).
// Reglas: timeout por pedido, máx. reintentos, sin bucles; si falla, conserva la copia anterior.
const fs = require('fs');
const path = require('path');

const STORES = {
  A: { name: 'Vintage BSAS', url: 'https://www.vintagebsas.com.ar/' },
  B: { name: 'Rumba Helguera', url: 'https://www.rumbahelguera.com.ar/' },
};
const TIMEOUT_MS = 20000;
const MAX_RETRIES = 2;     // reintentos extra por tienda
const MAX_PRODUCTS = 8;    // por tienda
const OUT = path.join(__dirname, '..', 'data', 'catalog.json');
const STATUS = path.join(__dirname, '..', 'data', 'status.json');

function parseProducts(html, baseUrl) {
  const seen = new Set(); const out = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let j; try { j = JSON.parse(m[1]); } catch { continue; }
    for (const x of (Array.isArray(j) ? j : [j])) {
      if (!x || x['@type'] !== 'Product' || !/camis/i.test(x.name || '') || seen.has(x.name)) continue;
      const off = Array.isArray(x.offers) ? x.offers[0] : x.offers;
      const price = Number(off && off.price);
      const image = Array.isArray(x.image) ? x.image[0] : x.image;
      if (!price || !image) continue;
      seen.add(x.name);
      out.push({ name: x.name.replace(/\s*[-(]\s*[\w ]*\d{3,}\)?\s*$/, '').trim(), price, image, url: x.url || (off && off.url) || baseUrl });
    }
  }
  return out;
}

async function fetchStore(key) {
  const s = STORES[key]; let lastErr;
  for (let i = 0; i <= MAX_RETRIES; i++) {
    try {
      const r = await fetch(s.url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; catalogo-sync/1.0)', 'Accept-Language': 'es-AR' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const products = parseProducts(await r.text(), s.url).slice(0, MAX_PRODUCTS);
      if (!products.length) throw new Error('sin productos en la página');
      return { name: s.name, url: s.url, products };
    } catch (e) { lastErr = e; await new Promise(res => setTimeout(res, 1500 * (i + 1))); }
  }
  throw lastErr;
}

async function main() {
  let prev = {}; try { prev = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch {}
  const next = { updated: new Date().toISOString(), stores: { ...(prev.stores || {}) } };
  const status = { run: next.updated, stores: {} };
  for (const key of Object.keys(STORES)) {
    try { next.stores[key] = await fetchStore(key); status.stores[key] = { ok: true, count: next.stores[key].products.length }; }
    catch (e) { status.stores[key] = { ok: false, error: String(e.message || e) }; }
  }
  fs.writeFileSync(STATUS, JSON.stringify(status, null, 2));
  if (Object.values(status.stores).some(s => s.ok)) fs.writeFileSync(OUT, JSON.stringify(next, null, 2));
  console.log(JSON.stringify(status));
  process.exit(Object.values(status.stores).every(s => s.ok) ? 0 : 1);
}
if (require.main === module) main(); else module.exports = { parseProducts };
