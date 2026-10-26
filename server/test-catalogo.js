'use strict';
// Verifica la actualización del catálogo por orden: clave obligatoria, una a la vez, pausa, tienda caída conserva la copia anterior.
const { createServer } = require('./server'); const fs = require('fs'), os = require('os'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-')); const T = 'admin-token-de-prueba-largo-123456';
const { comparar } = require('./catalogo');
let fallaB = false, calls = 0;
const crawlStore = async (k) => { calls++; await new Promise(r => setTimeout(r, 150)); if (k === 'B' && fallaB) throw new Error('portada no disponible');
  return { name: k === 'A' ? 'Vintage BSAS' : 'Rumba Helguera', url: 'https://x/', products: [{ name: 'Prenda ' + k, price: 1000, image: 'https://i/x.webp', url: 'https://x/p/', sz: ['M'], cat: 'Blusas', cats: ['Blusas'] }], allCategories: [{ name: 'Blusas', path: '/blusas/' }], errors: [], requests: 3 }; };
const s = createServer({ mpToken: 'T', baseUrl: 'http://x', frontUrl: 'https://f', webhookSecret: 'x', adminToken: T, dataDir: dir, crawlStore });
let mal = 0; const chk = (n, ok) => { if (!ok) mal++; console.log((ok ? '  ✔ ' : '  ✘ ') + n); };
s.listen(0, '127.0.0.1', async () => {
  const A = 'http://127.0.0.1:' + s.address().port, H = { 'Content-Type': 'application/json', 'x-admin-token': T };
  const post = (b, h = H) => fetch(A + '/api/catalogo/actualizar', { method: 'POST', headers: h, body: JSON.stringify(b) });
  chk('sin clave → 403 y no corre nada', (await post({ stores: ['A'] }, { 'Content-Type': 'application/json' })).status === 403 && calls === 0);
  chk('clave incorrecta → 403', (await post({ stores: ['A'] }, { ...H, 'x-admin-token': 'otra-clave-larga-incorrecta-123' })).status === 403);
  chk('tienda inválida → 400', (await post({ stores: ['Z'] })).status === 400);
  chk('sin tiendas → 400', (await post({ stores: [] })).status === 400);
  const r1 = await post({ stores: ['A', 'B'] }); chk('actualizar A y B → 202', r1.status === 202);
  chk('segunda orden mientras corre → 409', (await post({ stores: ['A'] })).status === 409);
  chk('estado: en curso', (await (await fetch(A + '/api/catalogo/estado')).json()).running === true);
  for (let i = 0; i < 40; i++) { const e = await (await fetch(A + '/api/catalogo/estado')).json(); if (!e.running) break; await new Promise(r => setTimeout(r, 100)); }
  const e = await (await fetch(A + '/api/catalogo/estado')).json();
  chk('terminó con A y B ok', !e.running && e.stores.A.state === 'ok' && e.stores.B.state === 'ok');
  const d = await (await fetch(A + '/api/catalogo')).json(); chk('catálogo guardado con ambas tiendas', d.updated && d.stores.A.products.length === 1 && d.stores.B.products.length === 1);
  chk('pausa entre actualizaciones → 429', (await post({ stores: ['A'] })).status === 429);
  chk('el catálogo es de lectura pública y sin claves', !JSON.stringify(d).includes(T));
  // macheo contra la copia anterior
  const ant = { products: [{ name: 'A', price: 100, url: 'u1', first: '2026-01-01' }, { name: 'B', price: 200, url: 'u2', first: '2026-01-01' }, { name: 'C', price: 300, url: 'u3' }] };
  const c = comparar(ant, [{ name: 'A', price: 100, url: 'u1' }, { name: 'B', price: 250, url: 'u2' }, { name: 'D', price: 50, url: 'u4' }], 'AHORA');
  chk('macheo: 1 nueva (D)', c.nuevas === 1 && c.products.find(p => p.url === 'u4').nuevo === true);
  chk('macheo: 1 cambio de precio (B 200→250)', c.precio === 1 && c.products.find(p => p.url === 'u2').prevPrice === 200);
  chk('macheo: 1 ya no está (C)', c.quitadas.length === 1 && c.quitadas[0].url === 'u3');
  chk('macheo: conserva la fecha en que se vio por primera vez', c.products.find(p => p.url === 'u1').first === '2026-01-01');
  chk('primera carga: nada se marca como nueva', comparar(null, [{ name: 'X', price: 1, url: 'u9' }], 'AHORA').nuevas === 0);
  s.close(); console.log(mal ? '\n✘ FALLÓ ' + mal : '\n✔ CATÁLOGO OK'); process.exit(mal ? 1 : 0);
});
