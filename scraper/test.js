const { parseProductPage, applySizes, validateSelection, parseSizes, parseProducts, discoverCategories, crawlStore, LIMITS } = require('./sync.js');
LIMITS.pauseMs = 0;
const assert = (c, m) => { if (!c) { console.log('FALLÓ:', m); process.exit(1); } };
const ld = (items) => '<html>' + items.map(i => `<script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name: i.n, image: ['https://x/' + i.n + '.webp'], offers: { price: String(i.p) }, url: 'https://t/p/' + i.n })}</script>`).join('') + '</html>';
// 1) parser
const r = parseProducts(ld([{ n: 'Camisa Bordada VINARA - 70234', p: 31240 }, { n: 'Remera X', p: 100 }]), 'https://t/');
assert(r.length === 2 && r[0].name === 'Camisa Bordada VINARA' && r[0].price === 31240, 'parser');
// 1b) talles: Vintage (color+talle) y Rumba (talle en par), solo disponibles
const vv = (arr) => JSON.stringify(arr).replace(/"/g, '&quot;');
const cardV = `<div class="item" data-variants="${vv([{option0:'Blanco',option1:'L',available:true},{option0:'Blanco',option1:'M',available:true},{option0:'Celeste',option1:'M',available:true},{option0:'Celeste',option1:'S',available:false},{option0:'Negro',option1:'XL',available:true}])}" data-quickshop-id="1"><a href="https://t/productos/camisa-a/">x</a></div>`;
const cardR = `<div data-variants="${vv([{option0:'SM',available:true},{option0:'LXL',available:true}])}"><a href="/productos/camisa-b/">x</a></div>`;
const big = vv(Array.from({length: 300}, (_, i) => ({ option0: 'Rojo', option1: i === 0 ? 'M' : 'L', available: i < 2, image_url: 'https://x/' + 'y'.repeat(150) + i })));
const cardBig = `<div data-variants="${big}"><div>${'<span>x</span>'.repeat(300)}<a href="/productos/camisa-c/">x</a></div></div>`;
assert(parseSizes(cardBig)['/productos/camisa-c/'].join() === 'M,L', 'atributo largo (~40KB): ' + JSON.stringify(parseSizes(cardBig)));
const sz = parseSizes(cardV + cardR);
assert(JSON.stringify(sz['/productos/camisa-a/']) === '["M","L","XL"]', 'talles Vintage: ' + JSON.stringify(sz));
assert(JSON.stringify(sz['/productos/camisa-b/']) === '["LXL","SM"]', 'talles Rumba: ' + JSON.stringify(sz));
const withSz = parseProducts(cardV + '<script type="application/ld+json">' + JSON.stringify({'@type':'Product',name:'Camisa A',image:'https://x/a.webp',offers:{price:'10'},url:'https://t/productos/camisa-a/'}) + '</script>', 'https://t/');
assert(withSz[0] && withSz[0].sz.join() === 'M,L,XL', 'talles asociados al producto');
// 1c) selección pegada desde el tablero
assert(JSON.stringify(validateSelection('{"categories":{"A":["/camisas/"]}}').categories) === '{"A":["/camisas/"],"B":[]}', 'selección válida');
for (const bad of ['no json', '{"categories":{"A":["http://x.com"]}}', '{"categories":{"A":["/a/b/"]}}', '{"categories":{"A":"/camisas/"}}']) { let e = false; try { validateSelection(bad); } catch { e = true; } assert(e, 'debe rechazar: ' + bad); }
// 1d) cotejo con los talles elegidos (incluye pares de Rumba y productos sin información de talles)
const ap = applySizes([{ name: 'a', sz: ['S', 'M', 'XL'] }, { name: 'b', sz: ['XXL'] }, { name: 'c', sz: ['SM', 'LXL'] }, { name: 'd' }, { name: 'e', sz: [] }], ['M', 'L']);
assert(ap.products.map(p => p.name).join() === 'a,c,d' && ap.dropped === 2, 'cotejo de talles: ' + JSON.stringify(ap));
assert(ap.products[0].sz.join() === 'M', 'solo deja los talles elegidos');
assert(applySizes([{ name: 'z', sz: ['S'] }], []).products.length === 1, 'sin talles elegidos no filtra');
assert(validateSelection('{"categories":{"A":["/a/"]},"talles":["S","M"]}').talles.join() === 'S,M', 'talles en selección');
let eT = false; try { validateSelection('{"talles":["ZZ"]}'); } catch { eT = true; } assert(eT, 'rechaza talles raros');
// 1e) página de un producto: el principal sale de og:title/og:image/#single-product; el JSON-LD es de relacionados
const mainV = vv([{ option0: 'Blanco', option1: 'M', available: true, price_number: 22490 }, { option0: 'Blanco', option1: 'L', available: true, price_number: 22490 }, { option0: 'Blanco', option1: 'S', available: false, price_number: 22490 }]);
const relCard = `<div data-variants="${vv([{ option0: 'S', available: true }])}"><a href="/productos/otra-1/">x</a></div>`;
const pageHtml = `<html><head><meta property="og:title" content="Camisa NINAF - 70212"><meta property="og:image" content="http://x/ninaf.webp"></head><body>
<div class="js-product-detail" id="single-product" data-variants="${mainV}"><a href="/productos/otra-1/">breadcrumb</a></div>${relCard}
<script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name: 'Top RELACIONADO - 3020', image: 'https://x/r.webp', offers: { price: '31240' }, url: 'https://t/productos/otra-1/' })}</script></body></html>`;
const pp = parseProductPage(pageHtml, 'https://t/productos/ninaf/');
assert(pp.name === 'Camisa NINAF' && pp.price === 22490 && pp.sz.join() === 'M,L', 'producto principal: ' + JSON.stringify(pp));
assert(pp.image === 'https://x/ninaf.webp', 'imagen en https');
assert(pp.related.length === 1 && pp.related[0].name === 'Top RELACIONADO' && pp.related[0].sz.join() === 'S', 'relacionados separados: ' + JSON.stringify(pp.related));
let eP = false; try { parseProductPage('<html>no es un producto</html>', 'https://t/productos/x/'); } catch { eP = true; } assert(eP, 'rechaza páginas que no son de producto');
// 2) descubrimiento de categorías
const nav = '<a href="/productos/">Ver colección</a><a href="/camisas/">CAMISAS</a><a href="/todo/">Productos</a><a href="https://www.t.com/remeras/">REMERAS Y TOPS</a><a href="/remeras/tops/">Tops</a><a href="/descuentos/">Descuentos</a><a href="/contacto/">Contacto</a><a href="/kids/">Kids</a><a href="/productos/x/">Prod</a><a href="/camisas/">CAMISAS</a>';
const cats = discoverCategories(nav);
assert(cats.length === 2 && cats[0].name === 'Camisas' && cats[1].path === '/remeras/', 'categorías: ' + JSON.stringify(cats));
// 3) recorrido con paginación, 404 con productos de relleno y tope por categoría
const pages = {
  '/': { status: 200, html: nav },
  '/camisas/': { status: 200, html: ld([{ n: 'a1', p: 1 }, { n: 'a2', p: 2 }]) },
  '/camisas/?page=2': { status: 200, html: ld([{ n: 'a3', p: 3 }]) },
  '/camisas/?page=3': { status: 200, html: ld([{ n: 'a3', p: 3 }]) },       // repetida => corta
  '/remeras/': { status: 404, html: ld([{ n: 'relleno', p: 9 }]) },        // 404 => se ignora
};
let calls = 0;
const get = async (url) => { calls++; const k = url.replace('http://s', ''); const p = pages[k]; return p ? { status: p.status, html: p.status === 200 ? p.html : '' } : { status: 404, html: '' }; };
crawlStore('A', get, 'http://s').then(st => {
  assert(st.products.length === 3, 'productos: ' + st.products.length);
  assert(st.products.every(p => p.cat === 'Camisas'), 'categoría asignada');
  assert(!st.products.find(p => p.name === 'relleno'), 'no debe tomar productos de una página 404');
  assert(calls <= 8, 'pocos pedidos: ' + calls);
  return crawlStore('A', get, 'http://s', ['/camisas/']).then(st2 => { assert(st2.products.length === 3 && st2.categories.length === 1 && st2.allCategories.length === 2, 'solo lo tildado: ' + st2.products.length); return crawlStore('A', get, 'http://s', []); }).then(st3 => { assert(st3.products.length === 0 && st3.allCategories.length === 2, 'sin selección: solo detecta'); console.log('TEST OK (' + calls + ' pedidos simulados)'); });
}).catch(e => { console.log('FALLÓ', e); process.exit(1); });
