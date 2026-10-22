'use strict';
/** Mercado Pago FALSO para pruebas locales: no usa internet ni dinero. */
const http = require('http');
const crypto = require('crypto');

function createMock({ token = 'TEST-token', secret = '' } = {}) {
  const prefs = {}, pays = {}; let n = 1000;
  const body = req => new Promise(r => { let s = ''; req.on('data', c => s += c); req.on('end', () => { try { r(JSON.parse(s || '{}')); } catch (_) { r({}); } }); });
  const send = (res, c, o) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  async function notify(pay, { sign = true } = {}) {
    const pref = Object.values(prefs).find(p => p.external_reference === pay.external_reference);
    const url = new URL(pref.notification_url); url.searchParams.set('data.id', pay.id); url.searchParams.set('type', 'payment');
    const headers = { 'Content-Type': 'application/json', 'x-request-id': 'req-' + pay.id };
    if (secret && sign) { const ts = String(Date.now()); const v1 = crypto.createHmac('sha256', secret).update(`id:${pay.id};request-id:${headers['x-request-id']};ts:${ts};`).digest('hex'); headers['x-signature'] = `ts=${ts},v1=${v1}`; }
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ type: 'payment', data: { id: pay.id } }) });
    return r.status;
  }
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (req.headers.authorization !== 'Bearer ' + token && !u.pathname.startsWith('/_sim')) return send(res, 401, { message: 'invalid token' });
    if (u.pathname === '/checkout/preferences' && req.method === 'POST') {
      const b = await body(req), id = 'PREF-' + (++n);
      prefs[id] = { ...b, id, init_point: 'http://mock/pagar/' + id }; return send(res, 201, prefs[id]);
    }
    let m = u.pathname.match(/^\/v1\/payments\/(\w+)$/);
    if (m && req.method === 'GET') return pays[m[1]] ? send(res, 200, pays[m[1]]) : send(res, 404, { message: 'not found' });
    if (u.pathname === '/_sim/pay' && req.method === 'POST') { // simula que la compradora pagó
      const b = await body(req), pref = prefs[b.pref];
      const total = pref.items.reduce((a, i) => a + i.unit_price * i.quantity, 0);
      const pay = { id: String(++n), status: b.status || 'approved', transaction_amount: b.amount != null ? b.amount : total, currency_id: 'ARS', external_reference: pref.external_reference };
      pays[pay.id] = pay; const code = b.notify === false ? null : await notify(pay); return send(res, 200, { pay, webhookStatus: code });
    }
    if (u.pathname === '/_sim/replay' && req.method === 'POST') { const b = await body(req); return send(res, 200, { webhookStatus: await notify(pays[b.id]) }); }
    send(res, 404, { message: 'nope' });
  });
  return server;
}
module.exports = { createMock };
