const { parseSizes, parseProducts, discoverCategories, crawlStore, LIMITS } = require('./sync.js');
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
