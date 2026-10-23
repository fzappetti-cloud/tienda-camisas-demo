'use strict';
/**
 * Servidor mínimo de cobro (ambiente de prueba) · ADRIANA-SHOP
 * - Sin dependencias (Node 18+).
 * - Corre "por demanda": no hay tareas en bucle. Toda llamada externa tiene
 *   tiempo máximo y un número fijo de reintentos (nunca infinitos).
 * Reglas de seguridad que este servidor hace cumplir:
 *   1) El precio SIEMPRE lo calcula el servidor (se ignora cualquier precio del navegador).
 *   2) Un pedido pasa a "pagado" solo si Mercado Pago confirma el pago consultándolo
 *      directamente a su API y el monto coincide con el pedido.
 *   3) Las claves vienen de variables de entorno y nunca se devuelven ni se registran.
 *   4) Un mismo aviso de pago repetido se procesa una sola vez.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_PRICES = JSON.parse(fs.readFileSync(path.join(__dirname, 'prices.json'), 'utf8'));

function loadConfig(env = process.env) {
  return {
    port: +env.PORT || 3000,
    mpToken: env.MP_ACCESS_TOKEN || '',
    mpApi: (env.MP_API || 'https://api.mercadopago.com').replace(/\/$/, ''),
    baseUrl: (env.BASE_URL || '').replace(/\/$/, ''),
    frontUrl: (env.FRONT_URL || '').replace(/\/$/, ''),
    backUrl: (env.BACK_URL || '').replace(/\/$/, ''),
    webhookSecret: (env.WEBHOOK_SECRET || '').trim().replace(/^["']|["']$/g, ''),
    adminToken: env.ADMIN_TOKEN || '',
    dataDir: env.DATA_DIR || path.join(__dirname, 'data'),
    fetchTimeoutMs: +env.FETCH_TIMEOUT_MS || 15000,
    maxRetries: Math.min(+env.MAX_RETRIES || 2, 3), // tope duro: 3
    retryPauseMs: +env.RETRY_PAUSE_MS || 400,
    prices: DEFAULT_PRICES,
  };
}

const MAX_BODY = 20 * 1024;
const MAX_ITEMS = 20, MAX_QTY = 10;

function createServer(cfgIn) {
  const cfg = { ...loadConfig(), ...cfgIn };
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const FILE = path.join(cfg.dataDir, 'state.json');
  let state = { orders: {}, processed: {}, alerts: [] };
  try { state = { ...state, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch (_) { /* primer arranque */ }
  const save = () => { try { fs.writeFileSync(FILE, JSON.stringify(state)); } catch (e) { console.error('no se pudo guardar estado'); } };

  /* ---- alertas (en producción se conecta a mail / WhatsApp) ---- */
  function alert(type, msg, order) {
    const a = { at: new Date().toISOString(), type, msg, order: order ? order.id : null };
    state.alerts.push(a); if (state.alerts.length > 500) state.alerts.shift();
    console.log('[ALERTA]', type, msg);
    save();
  }

  /* ---- llamadas a Mercado Pago: tiempo máximo + reintentos acotados ---- */
  async function mp(method, pathname, body) {
    let last;
    for (let i = 0; i <= cfg.maxRetries; i++) {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), cfg.fetchTimeoutMs);
      try {
        const r = await fetch(cfg.mpApi + pathname, {
          method,
          headers: { Authorization: 'Bearer ' + cfg.mpToken, 'Content-Type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined,
          signal: ctl.signal,
        });
        clearTimeout(t);
        if (r.status >= 500 && i < cfg.maxRetries) { last = new Error('MP ' + r.status); await new Promise(z => setTimeout(z, cfg.retryPauseMs * (i + 1))); continue; }
        let data = null; try { data = await r.json(); } catch (_) {}
        return { status: r.status, data };
      } catch (e) {
        clearTimeout(t); last = e;
        if (i < cfg.maxRetries) await new Promise(z => setTimeout(z, cfg.retryPauseMs * (i + 1)));
      }
    }
    throw last || new Error('MP sin respuesta');
  }

  /* ---- utilidades http ---- */
  const send = (res, code, obj, extra = {}) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', ...extra });
    res.end(JSON.stringify(obj));
  };
  const readBody = req => new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    const timer = setTimeout(() => { reject(new Error('timeout')); req.destroy(); }, 10000);
    req.on('data', c => { n += c.length; if (n > MAX_BODY) { clearTimeout(timer); reject(new Error('grande')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { clearTimeout(timer); const s = Buffer.concat(chunks).toString('utf8'); if (!s) return resolve({}); try { resolve(JSON.parse(s)); } catch (_) { reject(new Error('json')); } });
    req.on('error', e => { clearTimeout(timer); reject(e); });
  });
  const hits = new Map();
  function limited(ip, max = 20, win = 60000) {
    const now = Date.now(), arr = (hits.get(ip) || []).filter(t => now - t < win);
    arr.push(now); hits.set(ip, arr);
    if (hits.size > 2000) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > win) hits.delete(k);
    return arr.length > max;
  }
  const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
  const isAdmin = req => cfg.adminToken && safeEq(req.headers['x-admin-token'] || '', cfg.adminToken);
  const cors = req => (cfg.frontUrl && req.headers.origin === cfg.frontUrl) ? { 'Access-Control-Allow-Origin': cfg.frontUrl, 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST,GET,OPTIONS' } : {};

  /* ---- 1) crear pedido: el precio sale de la lista del servidor ---- */
  async function checkout(req, res) {
    if (!cfg.mpToken || !cfg.baseUrl || !cfg.frontUrl) return send(res, 503, { error: 'cobro no configurado' }, cors(req));
    let b; try { b = await readBody(req); } catch (e) { return send(res, 400, { error: 'pedido inválido' }); }
    const items = b.items;
    if (!Array.isArray(items) || !items.length || items.length > MAX_ITEMS) return send(res, 400, { error: 'items inválidos' });
    const lines = []; let total = 0;
    for (const it of items) {
      const id = String(it && it.id), qty = it && it.qty, size = String((it && it.size) || '').slice(0, 10);
      const prod = cfg.prices[id];
      if (!prod) return send(res, 400, { error: 'prenda inexistente' });
      if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) return send(res, 400, { error: 'cantidad inválida' });
      lines.push({ id, n: prod.n, size, qty, unit: prod.p }); // se ignora cualquier precio enviado por el navegador
      total += prod.p * qty;
    }
    const order = { id: 'A' + crypto.randomBytes(5).toString('hex'), lines, total, status: 'pendiente', createdAt: new Date().toISOString() };
    state.orders[order.id] = order; save();
    const pref = {
      items: lines.map(l => ({ id: l.id, title: l.n + (l.size ? ' · talle ' + l.size : ''), quantity: l.qty, unit_price: l.unit, currency_id: 'ARS' })),
      external_reference: order.id,
      notification_url: cfg.baseUrl + '/webhook/mp',
      back_urls: { success: (cfg.backUrl || cfg.frontUrl) + '?pedido=' + order.id, failure: (cfg.backUrl || cfg.frontUrl) + '?pedido=' + order.id, pending: (cfg.backUrl || cfg.frontUrl) + '?pedido=' + order.id },
      auto_return: 'approved',
    };
    try {
      const r = await mp('POST', '/checkout/preferences', pref);
      if (r.status >= 300 || !r.data || !r.data.init_point) throw new Error('MP respondió ' + r.status);
      order.prefId = r.data.id; save();
      return send(res, 200, { orderId: order.id, total, init_point: r.data.init_point }, cors(req));
    } catch (e) {
      order.status = 'error_mp'; save();
      alert('error', 'No se pudo crear el link de pago del pedido ' + order.id, order);
      return send(res, 502, { error: 'no se pudo iniciar el pago' }, cors(req));
    }
  }

  /* ---- 2) aviso de pago (webhook): nunca se confía en el aviso, se consulta a MP ---- */
  function signatureOk(req, dataId) {
    if (!cfg.webhookSecret) return true;
    const sig = String(req.headers['x-signature'] || ''), rid = String(req.headers['x-request-id'] || '');
    const ts = (sig.match(/ts=([^,]+)/) || [])[1], v1 = (sig.match(/v1=([a-f0-9]+)/) || [])[1];
    if (!ts || !v1) return false;
    const manifest = `id:${String(dataId).toLowerCase()};request-id:${rid};ts:${ts};`;
    const h = crypto.createHmac('sha256', cfg.webhookSecret).update(manifest).digest('hex');
    return safeEq(h, v1);
  }
  function sigVariants(req, dataId, body) {
    if (!cfg.webhookSecret) return 'sin_clave';
    const sig = String(req.headers['x-signature'] || '');
    const ts = (sig.match(/ts=([^,]+)/) || [])[1], v1 = (sig.match(/v1=([a-f0-9]+)/) || [])[1];
    if (!ts || !v1) return 'sin_ts_v1';
    const ids = { query: String(dataId), query_min: String(dataId).toLowerCase(), cuerpo_data: String((body && body.data && body.data.id) || ''), cuerpo_id: String((body && body.id) || '') };
    // candidatos para "request-id": cada valor de cada encabezado (los separados por coma se prueban uno a uno)
    const rids = [['(vacío)', '']];
    for (const [k, v] of Object.entries(req.headers)) { if (k === 'x-signature') continue; for (const part of String(v).split(',')) { const t = part.trim(); if (t && t.length <= 120) rids.push([k, t]); } }
    const hit = [];
    for (const [n, id] of Object.entries(ids)) {
      if (!id) continue;
      for (const [hn, rid] of rids) {
        const man = hn === '(vacío)' ? `id:${id};ts:${ts};` : `id:${id};request-id:${rid};ts:${ts};`;
        const h = crypto.createHmac('sha256', cfg.webhookSecret).update(man).digest('hex');
        if (safeEq(h, v1)) hit.push(n + '/' + hn);
      }
    }
    return (hit.length ? 'COINCIDE:' + hit.join('|') : 'ninguna_coincide') + ' · encabezados=[' + Object.keys(req.headers).join(',') + '] · largo x-request-id=' + String(req.headers['x-request-id'] || '').length;
  }
  async function webhook(req, res, url) {
    let body = {}; if (req.method === 'POST') { try { body = await readBody(req); } catch (_) { body = {}; } }
    const q = url.searchParams;
    const type = q.get('type') || q.get('topic') || body.type || body.topic;
    const dataId = q.get('data.id') || q.get('id') || (body.data && body.data.id) || body.id;
    if (type !== 'payment' || !dataId || !/^[A-Za-z0-9_-]{1,40}$/.test(String(dataId))) return send(res, 200, { ok: true, ignored: 'no_es_pago' });
    if (!signatureOk(req, dataId)) {
      const sig = String(req.headers['x-signature'] || '');
      alert('seguridad', 'Aviso con firma inválida ignorado · diag: x-signature=' + (sig ? 'sí(' + sig.split(',').map(x => x.split('=')[0]).join('+') + ')' : 'no') + ', x-request-id=' + (req.headers['x-request-id'] ? 'sí' : 'no') + ', query=[' + [...q.keys()].join(',') + '], tipo=' + type + ', método=' + req.method + ', dataId=' + dataId + ', largoClave=' + cfg.webhookSecret.length + ', ts=' + ((sig.match(/ts=([^,]+)/) || [])[1] || '?') + ', variantes=' + sigVariants(req, dataId, body));
      return send(res, 401, { error: 'firma inválida' });
    }
    try {
      const out = await processPayment(String(dataId));
      return send(res, 200, { ok: true, result: out });
    } catch (e) {
      return send(res, 500, { error: 'reintentar' }); // MP reintenta solo, con sus propios límites
    }
  }
  async function processPayment(pid) {
    const r = await mp('GET', '/v1/payments/' + encodeURIComponent(pid));
    if (r.status === 404 || !r.data) return 'pago_desconocido'; // aviso falso o inexistente
    if (r.status >= 300) throw new Error('MP ' + r.status);
    const pay = r.data, order = state.orders[pay.external_reference];
    if (!order) return 'pedido_desconocido';
    const key = pid + ':' + pay.status;
    if (state.processed[key]) return 'duplicado';
    state.processed[key] = true;
    const amount = Number(pay.transaction_amount);
    if (pay.status === 'approved') {
      if (order.status === 'pagado') { alert('revisar', `Pedido ${order.id} ya estaba pagado y llegó otro pago aprobado (${pid})`, order); save(); return 'pago_extra'; }
      if (amount !== order.total || (pay.currency_id && pay.currency_id !== 'ARS')) {
        order.status = 'revisar'; order.paidAmount = amount; save();
        alert('revisar', `Pedido ${order.id}: MP cobró $${amount} y el total esperado era $${order.total}. NO comprar al mayorista hasta revisar.`, order);
        return 'monto_distinto';
      }
      order.status = 'pagado'; order.paymentId = pid; order.paidAmount = amount; order.paidAt = new Date().toISOString(); save();
      alert('venta', `Venta ${order.id} cobrada: $${amount} (esperado $${order.total}) · ${order.lines.map(l => l.qty + '× ' + l.n + ' ' + l.size).join(', ')}`, order);
      return 'pagado';
    }
    if (pay.status === 'rejected' || pay.status === 'cancelled') { if (order.status === 'pendiente') order.status = 'rechazado'; save(); return 'rechazado'; }
    if (pay.status === 'refunded' || pay.status === 'charged_back') { if (order.status === 'pagado') { order.status = 'revisar'; alert('revisar', `Pedido ${order.id}: pago ${pay.status}`, order); } save(); return pay.status; }
    save(); return 'pendiente'; // pending / in_process: sigue sin pagar
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x'), p = url.pathname, ip = req.socket.remoteAddress || '';
    try {
      if (req.method === 'OPTIONS') { res.writeHead(204, cors(req)); return res.end(); }
      if (p === '/health') return send(res, 200, { ok: true });
      if (p === '/api/checkout' && req.method === 'POST') { if (limited(ip)) return send(res, 429, { error: 'demasiados intentos' }); return checkout(req, res); }
      if (p === '/webhook/mp' && (req.method === 'POST' || req.method === 'GET')) return webhook(req, res, url);
      let m = p.match(/^\/api\/order\/([A-Za-z0-9]+)$/);
      if (m && req.method === 'GET') { const o = state.orders[m[1]]; return o ? send(res, 200, { id: o.id, status: o.status, total: o.total }, cors(req)) : send(res, 404, { error: 'no existe' }); }
      if (p === '/api/orders' && req.method === 'GET') return isAdmin(req) ? send(res, 200, Object.values(state.orders)) : send(res, 403, { error: 'no autorizado' });
      if (p === '/api/alerts' && req.method === 'GET') return isAdmin(req) ? send(res, 200, state.alerts) : send(res, 403, { error: 'no autorizado' });
      return send(res, 404, { error: 'no encontrado' });
    } catch (e) { console.error('error interno'); return send(res, 500, { error: 'error interno' }); }
  });
  server._state = state;
  return server;
}

if (require.main === module) {
  const cfg = loadConfig();
  if (!cfg.mpToken || !cfg.baseUrl || !cfg.frontUrl) console.warn('AVISO: faltan variables (MP_ACCESS_TOKEN, BASE_URL, FRONT_URL). El servidor arranca, pero no cobra hasta que estén cargadas.');
  createServer(cfg).listen(cfg.port, () => console.log('Servidor de cobro escuchando en puerto', cfg.port));
}
module.exports = { createServer, loadConfig };
