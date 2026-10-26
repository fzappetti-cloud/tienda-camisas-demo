'use strict';
// Verifica que el servidor sirve el demo (tienda/demo) y NO expone código ni datos.
const { createServer } = require('./server'); const fs = require('fs'), os = require('os'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-'));
const s = createServer({ mpToken: 'T', baseUrl: 'http://x', frontUrl: 'https://f', webhookSecret: 'x', adminToken: 'admin-token-de-prueba-largo-123456', dataDir: dir });
const esperado = [['/', 302], ['/tienda/', 200], ['/demo/', 200], ['/demo/logo-adriana-shop.jpg', 200], ['/health', 200],
  ['/server/server.js', 404], ['/data/catalog.json', 404], ['/tienda/../server/server.js', 404], ['/%2e%2e/server/server.js', 404], ['/tienda/.env', 404], ['/.git/config', 404], ['/nada', 404]];
s.listen(0, '127.0.0.1', async () => {
  const A = 'http://127.0.0.1:' + s.address().port; let mal = 0;
  for (const [u, code] of esperado) { const r = await fetch(A + u, { redirect: 'manual' }); const ok = r.status === code; if (!ok) mal++; console.log((ok ? '  ✔ ' : '  ✘ ') + u + ' → ' + r.status); }
  s.close(); console.log(mal ? '\n✘ FALLÓ ' + mal : '\n✔ SITIO OK · ' + esperado.length + ' controles'); process.exit(mal ? 1 : 0);
});
