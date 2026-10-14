const { parseProducts } = require('./sync.js');
const html = `<html><script type="application/ld+json">{"@type":"Product","name":"Camisa Bordada VINARA - 70234","image":["https://x/y-480-0.webp"],"offers":{"price":"31240"},"url":"https://t/p1"}</script>
<script type="application/ld+json">{"@type":"Product","name":"Remera X","image":"https://x/r.webp","offers":{"price":"100"}}</script>
<script type="application/ld+json">[{"@type":"Product","name":"Camisa SORCHA jeans c/piedras (ruk70013)","image":"https://x/s.webp","offers":[{"price":43750}]}]</script>
<script type="application/ld+json">{roto</script></html>`;
const r = parseProducts(html, 'https://t/');
const ok = r.length === 2 && r[0].name === 'Camisa Bordada VINARA' && r[0].price === 31240 && r[1].name.startsWith('Camisa SORCHA') && r[1].price === 43750;
console.log(JSON.stringify(r)); console.log(ok ? 'TEST OK' : 'TEST FALLÓ'); process.exit(ok ? 0 : 1);
