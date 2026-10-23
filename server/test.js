'use strict';
/** Pruebas automáticas del cobro, con Mercado Pago FALSO. Uso: node server/test.js */
const os = require('os'), fs = require('fs'), path = require('path'), crypto = require('crypto');
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
  const srv = createServer({ mpToken: 'TEST-token', mpApi: 'http://127.0.0.1:' + mp, baseUrl: 'http://127.0.0.1:0', frontUrl: 'https://tienda.test', webhookSecret: SECRET, adminToken: 'admin-token-de-prueba-largo-123456', dataDir: dir, fetchTimeoutMs: 2000, maxRetries: 1, retryPauseMs: 10 });
  const port = await listen(srv); const A = 'http://127.0.0.1:' + port;
  // el servidor necesita saber su URL pública para el aviso: la ajustamos al puerto real
  srv.close(); const srv2 = createServer({ mpToken: 'TEST-token', mpApi: 'http://127.0.0.1:' + mp, baseUrl: A, frontUrl: 'https://tienda.test', webhookSecret: SECRET, adminToken: 'admin-token-de-prueba-largo-123456', dataDir: dir, fetchTimeoutMs: 2000, maxRetries: 1, retryPauseMs: 10, checkoutLimit: 1000 });
  await new Promise(r => srv2.listen(port, '127.0.0.1', r));
  // freno de pedidos: el 21.º en un minuto desde la misma IP se rechaza
  const dirL = fs.mkdtempSync(path.join(os.tmpdir(), 'cobroL-')); const lim = createServer({ mpToken: 'T', mpApi: 'http://127.0.0.1:1', baseUrl: A, frontUrl: 'https://tienda.test', webhookSecret: 'x', adminToken: 'x', dataDir: dirL, fetchTimeoutMs: 200, maxRetries: 0 });
  const pL = await listen(lim); let c429 = 0; for (let i = 0; i < 25; i++) if ((await J('http://127.0.0.1:' + pL + '/api/checkout', { method: 'POST', body: { items: [{ id: 1, qty: 1 }] } })).status === 429) c429++; lim.close();
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
  const ts = '1', rid = 'r1', id = '987654';
  const v1 = crypto.createHmac('sha256', SECRET).update(`id:${id};request-id:${rid};ts:${ts};`).digest('hex');
  const g = await J(A + '/webhook/mp?type=payment&data.id=' + id, { method: 'POST', headers: { 'x-signature': `ts=${ts},v1=${v1}`, 'x-request-id': rid }, body: {} });
  check('pago desconocido para MP → se ignora', g.status === 200 && g.data.result === 'pago_desconocido');
  check('el pedido sigue sin pagar', (await status(o5)) === 'pendiente');

  console.log('\n8) Datos internos y acceso');
  check('/api/orders sin clave → 403', (await J(A + '/api/orders')).status === 403);
  check('/api/orders con clave → 200', (await J(A + '/api/orders', { headers: { 'x-admin-token': 'admin-token-de-prueba-largo-123456' } })).status === 200);
  check('/api/alerts sin clave → 403', (await J(A + '/api/alerts')).status === 403);
  const all = JSON.stringify([(await J(A + '/api/order/' + o1)).data, (await buy([{ id: 1, qty: 1 }])).data, (await J(A + '/health')).data]);
  check('ninguna respuesta pública contiene la clave de Mercado Pago', !all.includes('TEST-token') && !all.includes(SECRET));
  check('el estado guardado no contiene la clave', !fs.readFileSync(path.join(dir, 'state.json'), 'utf8').includes('TEST-token'));

  console.log('\n8b) Conciliación protegida (sin depender del aviso)');
  const rec = (id, tok) => J(A + '/api/admin/reconcile', { method: 'POST', headers: tok ? { 'x-admin-token': tok } : {}, body: { orderId: id } });
  const o6 = (await buy([{ id: 1, qty: 1, size: 'M' }])).data.orderId; await pay(o6, { status: 'approved', notify: false });
  check('sin clave de administrador → 403', (await rec(o6)).status === 403);
  check('clave incorrecta → 403', (await rec(o6, 'mala')).status === 403);
  check('sin avisos, el pedido sigue pendiente', (await status(o6)) === 'pendiente');
  const rr = await rec(o6, 'admin-token-de-prueba-largo-123456');
  check('con clave: concilia y queda "pagado"', rr.status === 200 && (await status(o6)) === 'pagado', JSON.stringify(rr.data));
  const o7 = (await buy([{ id: 1, qty: 1, size: 'M' }])).data.orderId; await pay(o7, { status: 'approved', amount: 5, notify: false });
  await rec(o7, 'admin-token-de-prueba-largo-123456');
  check('conciliar con monto distinto → "revisar", nunca "pagado"', (await status(o7)) === 'revisar');
  check('pedido inexistente → 404', (await rec('Ainexistente', 'admin-token-de-prueba-largo-123456')).status === 404);
  const o8 = (await buy([{ id: 1, qty: 1, size: 'M' }])).data.orderId; await pay(o8, { status: 'rejected', notify: false }); await rec(o8, 'admin-token-de-prueba-largo-123456');
  check('conciliar un pago rechazado → no queda "pagado"', (await status(o8)) !== 'pagado');

  console.log('\n9a) Endurecimiento extra');
  check('más de 20 pedidos por minuto desde una IP → 429', c429 >= 4, c429);
  const hdr = await fetch(A + '/health');
  check('respuestas con cabeceras de seguridad (no-store, HSTS, sin marcos)', hdr.headers.get('cache-control') === 'no-store' && !!hdr.headers.get('strict-transport-security') && hdr.headers.get('x-frame-options') === 'DENY');
  check('id "constructor" no es una prenda', (await buy([{ id: 'constructor', qty: 1 }])).status === 400);
  check('id "__proto__" no es una prenda', (await buy([{ id: '__proto__', qty: 1 }])).status === 400);
  check('cuerpo "null" → 400 (no cae el servidor)', (await J(A + '/api/checkout', { method: 'POST', body: null })).status === 400);
  check('talle con caracteres raros → 400', (await buy([{ id: 1, qty: 1, size: '<script>' }])).status === 400);
  check('pedido "constructor" → 404', (await J(A + '/api/order/constructor')).status === 404);
  const rawNull = await fetch(A + '/api/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'null' });
  check('JSON "null" crudo → 400', rawNull.status === 400);
  // sin clave de webhook configurada: se rechaza (no se acepta todo)
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cobro2-'));
  const open_ = createServer({ mpToken: 'T', mpApi: 'http://127.0.0.1:1', baseUrl: A, frontUrl: 'https://tienda.test', webhookSecret: '', adminToken: 'x', dataDir: dir2 });
  const p2 = await listen(open_);
  const wh = await J('http://127.0.0.1:' + p2 + '/webhook/mp?type=payment&data.id=123', { method: 'POST', body: {} });
  check('sin WEBHOOK_SECRET el aviso se rechaza (401), no se acepta', wh.status === 401);
  check('ADMIN_TOKEN corta → rutas de administrador deshabilitadas', (await J('http://127.0.0.1:' + p2 + '/api/orders', { headers: { 'x-admin-token': 'x' } })).status === 403);
  open_.close();
  // clave de aviso de los dos modos (prueba y productivo)
  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'cobro3-'));
  const two = createServer({ mpToken: 'TEST-token', mpApi: M, baseUrl: A, frontUrl: 'https://tienda.test', webhookSecret: 'clave-prueba', webhookSecret2: SECRET, adminToken: 'x', dataDir: dir3 });
  const p3 = await listen(two);
  const sign = sec => { const t = '1', ri = 'r9', i = '4242'; return { 'x-signature': `ts=${t},v1=${crypto.createHmac('sha256', sec).update(`id:${i};request-id:${ri};ts:${t};`).digest('hex')}`, 'x-request-id': ri }; };
  const w2 = await J('http://127.0.0.1:' + p3 + '/webhook/mp?type=payment&data.id=4242', { method: 'POST', headers: sign('clave-prueba'), body: {} });
  const w3 = await J('http://127.0.0.1:' + p3 + '/webhook/mp?type=payment&data.id=4242', { method: 'POST', headers: sign('otra-clave-falsa'), body: {} });
  check('firma con la clave del 2.º modo es aceptada (pasa a verificar con MP)', w2.status !== 401);
  check('firma con una clave ajena → 401', w3.status === 401);
  two.close();
  // freno de intentos de clave de administrador
  let last = 0; for (let i = 0; i < 14; i++) last = (await J(A + '/api/orders', { headers: { 'x-admin-token': 'mala-' + i } })).status;
  check('muchos intentos fallidos de clave de administrador → 429', last === 429);
  check('el bloqueo también frena a la clave correcta (mientras dura)', (await J(A + '/api/orders', { headers: { 'x-admin-token': 'admin-token-de-prueba-largo-123456' } })).status === 429);

  console.log('\n9) Mercado Pago caído');
  mock.close();
  const down = await buy([{ id: 1, qty: 1, size: 'M' }]);
  check('si MP no responde → 502 y no queda pedido colgado como pendiente', down.status === 502 && (Object.values(srv2._state.orders).filter(o => o.status === 'error_mp').length === 1));

  console.log('\n' + (fail ? '✘ FALLARON ' + fail : '✔ TODO OK') + ' · ' + ok + ' controles correctos');
  srv2.close(); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR en la prueba:', e); process.exit(2); });
