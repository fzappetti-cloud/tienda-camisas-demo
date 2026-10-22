// Pruebas de "3 · Sumar un mayorista": validación del enlace y prueba de compatibilidad (sin red: pedidos simulados).
const { checkPublicHttps, probeStore, cleanStoreName, LIMITS } = require('./sync.js');
LIMITS.pauseMs = 0;
const assert = (c, m) => { if (!c) { console.log('FALLÓ:', m); process.exit(1); } };
const bad = ['http://tienda.com.ar', 'https://localhost', 'https://127.0.0.1', 'https://10.0.0.5', 'https://[::1]', 'https://user:pass@tienda.com.ar', 'https://tienda.com.ar:8443', 'https://intranet', 'https://algo.local', 'no es un enlace', ''];
for (const b of bad) { let e = false; try { checkPublicHttps(b); } catch { e = true; } assert(e, 'debe rechazar: ' + b); }
assert(checkPublicHttps('https://www.modaotra.com.ar/productos/x/?a=1') === 'https://www.modaotra.com.ar', 'origen limpio');
assert(cleanStoreName('<b>Moda</b> Otra!!', 'x.com') === 'Moda Otra', 'nombre limpio: ' + cleanStoreName('<b>Moda</b> Otra!!', 'x.com'));
assert(cleanStoreName('', 'www.modaotra.com.ar') === 'Modaotra', 'nombre desde el dominio');
const ld = n => '<html>' + Array.from({ length: n }, (_, i) => `<script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name: 'P' + i, image: 'https://x/' + i + '.webp', offers: { price: '100' }, url: 'https://t/productos/p' + i + '/' })}</script>`).join('') + '</html>';
const nav = '<a href="/camisas/">Camisas</a><a href="/remeras/">Remeras</a>';
let calls = 0;
const mk = pages => async url => { calls++; const k = url.replace('https://t', ''); const p = pages[k]; return p ? { status: 200, html: p } : { status: 404, html: '' }; };
(async () => {
  let r = await probeStore('https://t', mk({ '/': nav, '/camisas/': ld(3) }));
  assert(r.categories.length === 2 && r.sampleCount === 3 && r.probe === 'Camisas' && calls === 2, 'compatible: ' + JSON.stringify(r) + ' calls=' + calls);
  r = await probeStore('https://t', mk({ '/': nav, '/camisas/': '<html></html>', '/remeras/': ld(2) }));
  assert(r.probe === 'Remeras', 'prueba la segunda categoría');
  for (const [pages, why] of [[{ '/': '<html>sin menú</html>' }, 'sin categorías'], [{ '/': nav, '/camisas/': '<html></html>', '/remeras/': '<html></html>' }, 'sin productos'], [{}, 'sin portada']]) {
    let e = false; try { await probeStore('https://t', mk(pages)); } catch { e = true; } assert(e, 'debe rechazar: ' + why);
  }
  calls = 0; try { await probeStore('https://t', mk({ '/': nav + '<a href="/a/">A</a><a href="/b/">B</a><a href="/c/">C</a><a href="/d/">D</a>' })); } catch {}
  assert(calls <= 4, 'máximo 4 pedidos: ' + calls);
  console.log('OK test-tienda');
})();
