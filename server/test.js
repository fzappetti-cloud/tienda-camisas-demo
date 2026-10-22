'use strict';
/** Pruebas automáticas del cobro, con Mercado Pago FALSO. Uso: node server/test.js */
const os = require('os'), fs = require('fs'), path = require('path');
const { createServer } = require('./server');
const { createMock } = require('./mock-mp');

let ok = 0, fail = 0;
const check = (name, cond, extra) => { cond ? ok++ : fail++; console.log((cond ? '  ✔ ' : '  ✘ ') + name + (cond ? '' : '  → ' + (extra || ''))); };
const listen = s => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const J = (url, o = {}) => fetch(url, { ...o, headers: { 'Content-Type': 'application/json', ...(o.headers || {}) }, body: o.body && JSON.stringify(o.body) }).then(async r => ({ status: r.status, data: await r.json().catch(() => null) }));

(async () => {
  const SECRET = 'secreto-de-prueba';
  const mock = createMock({ token: 'TEST-token', secret: SECRET }); const mp = await listen(mock);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobro-'));
  const holder = {};
  const srv = createServer({ mpToken: 'TEST-token', mpApi: 'http://127.0.0.1:' + mp, baseUrl: 'http://127.0.0.1:0', frontUrl: 'https://tienda.test', webhookSecret: SECRET, adminToken: 'admin-123', dataDir: dir, fetchTimeoutMs: 2000, maxRetries: 1, retryPauseMs: 10 });
  const port = await listen(srv); const A = 'http://127.0.0.1:' + port;
  // el servidor necesita saber su URL pública para el aviso: la ajustamos al puerto real
  srv.close(); const srv2 = createServer({ mpToken: 'TEST-token', mpApi: 'http://127.0.0.1:' + mp, baseUrl: A, frontUrl: 'https://tienda.test', webhookSecret: SECRET, adminToken: 'admin-123', dataDir: dir, fetchTimeoutMs: 2000, maxRetries: 1, retryPauseMs: 10 });
  await new Promise(r => srv2.listen(port, '127.0.0.1', r));
  const M = 'http://127.0.0.1:' + mp, price1 = require('./prices.json')['1'].p;
  const buy = (items) => J(A + '/api/checkout', { method: 'POST', body: { items } });
  const prefOf = orderId => Object.values(srv2._state.orders).find(o => o.id === orderId).prefId;
  const pay = (orderId, extra = {}) => J(M + '/_sim/pay', { method: 'POST', body: { pref: prefOf(orderId), ...extra } });
  const status = id => J(A + '/api/order/' + id).then(r => r.data.status);

  console.log('\n1) El precio lo calcula el servidor');
  let r = await J(A + '/api/checkout', { method: 'POST', body: { items: [{ id: 1, qty: 2, size: 'M', price: 1, unit_price: 1 }], total: 1 } });
  check('el precio enviado por el navegador se ignora', r.status === 200 && r.data.total === price1 * 2, JSON.stringify(r.data));
  const o1 = r.data.orderId;

  console.log('\n2) Entradas inválidas');
  check('prenda inexistente → 400', (await buy([{ id: 99999, qty: 1 }])).status === 400);
  check('cantidad 0 → 400', (await buy([{ id: 1, qty: 0 }])).status === 400);
  check('cantidad negativa → 400', (await buy([{ id: 1, qty: -3 }])).status === 400);
  check('cantidad decimal → 400', (await buy([{ id: 1, qty: 1.5 }])).status === 400);
  check('cantidad enorme → 400', (await buy([{ id: 1, qty: 100000 }])).status === 400);
  check('lista vacía → 400', (await buy([])).status === 400);

  console.log('\n3) Pagado solo con confirmación real');
  check('pedido nuevo está "pendiente"', (await status(o1)) === 'pendiente');
  const fake = await J(A + '/webhook/mp?type=payment&data.id=555555', { method: 'POST', headers: { 'x-signature': 'ts=1,v1=00', 'x-request-id': 'x' }, body: {} });
  check('aviso falso sin firma válida → rechazado (401)', fake.status === 401);
  check('el pedido sigue "pendiente"', (await status(o1)) === 'pendiente');
  const rp = await pay(o1, { status: 'approved' });
  check('pago aprobado y bien firmado → 200', rp.data.webhookStatus === 200);
  check('el pedido pasa a "pagado"', (await status(o1)) === 'pagado');

  console.log('\n4) Aviso repetido');
  const alertsBefore = srv2._state.alerts.length;
  const rep = await J(M + '/_sim/replay', { method: 'POST', body: { id: rp.data.pay.id } });
  check('el aviso repetido responde 200', rep.data.webhookStatus === 200);
  check('no genera una segunda alerta de venta', srv2._state.alerts.length === alertsBefore);

  console.log('\n5) Monto distinto');
  const o2 = (await buy([{ id: 1, qty: 1, size: 'L' }])).data.orderId;
  await pay(o2, { status: 'approved', amount: 1 });
  check('cobraron $1 de un total mayor → "revisar", no "pagado"', (await status(o2)) === 'revisar');
  check('hay alerta "NO comprar al mayorista"', srv2._state.alerts.some(a => a.order === o2 && /NO comprar/.test(a.msg)));

  console.log('\n6) Otros estados de pago');
  const o3 = (await buy([{ id: 2, qty: 1, size: 'M' }])).data.orderId; await pay(o3, { status: 'rejected' });
  check('pago rechazado → "rechazado"', (await status(o3)) === 'rechazado');
  const o4 = (await buy([{ id: 3, qty: 1, size: 'M' }])).data.orderId; await pay(o4, { status: 'in_process' });
  check('pago pendiente → sigue "pendiente"', (await status(o4)) === 'pendiente');
  await pay(o4, { status: 'approved' });
  check('luego aprobado → "pagado"', (await status(o4)) === 'pagado');

  console.log('\n7) Pago inexistente y pagos ajenos');
  const o5 = (await buy([{ id: 4, qty: 1, size: 'M' }])).data.orderId;
  const ghost = await pay(o5, { status: 'approved', notify: false });
  // aviso con firma válida pero id de pago que MP no conoce
  const crypto = require('crypto'), ts = '1', rid = 'r1', id = '987654';
  const v1 = crypto.createHmac('sha256', SECRET).update(`id:${id};request-id:${rid};ts:${ts};`).digest('hex');
  const g = await J(A + '/webhook/mp?type=payment&data.id=' + id, { method: 'POST', headers: { 'x-signature': `ts=${ts},v1=${v1}`, 'x-request-id': rid }, body: {} });
  check('pago desconocido para MP → se ignora', g.status === 200 && g.data.result === 'pago_desconocido');
  check('el pedido sigue sin pagar', (await status(o5)) === 'pendiente');

  console.log('\n8) Datos internos y acceso');
  check('/api/orders sin clave → 403', (await J(A + '/api/orders')).status === 403);
  check('/api/orders con clave → 200', (await J(A + '/api/orders', { headers: { 'x-admin-token': 'admin-123' } })).status === 200);
  check('/api/alerts sin clave → 403', (await J(A + '/api/alerts')).status === 403);
  const all = JSON.stringify([(await J(A + '/api/order/' + o1)).data, (await buy([{ id: 1, qty: 1 }])).data, (await J(A + '/health')).data]);
  check('ninguna respuesta pública contiene la clave de Mercado Pago', !all.includes('TEST-token') && !all.includes(SECRET));
  check('el estado guardado no contiene la clave', !fs.readFileSync(path.join(dir, 'state.json'), 'utf8').includes('TEST-token'));

  console.log('\n9) Mercado Pago caído');
  mock.close();
  const down = await buy([{ id: 1, qty: 1, size: 'M' }]);
  check('si MP no responde → 502 y no queda pedido colgado como pendiente', down.status === 502 && (Object.values(srv2._state.orders).filter(o => o.status === 'error_mp').length === 1));

  console.log('\n' + (fail ? '✘ FALLARON ' + fail : '✔ TODO OK') + ' · ' + ok + ' controles correctos');
  srv2.close(); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR en la prueba:', e); process.exit(2); });
