const http = require('http');
const { URL } = require('url');
const crypto = require('crypto');

// ---- Utilities ----
const USERS = new Map();
let NEXT_ID = 1;
const PORT = process.env.PORT || 3000;

const DICTIONARY = {
  pagination: {
    canonical: ['page', 'limit', 'offset'],
    synonyms: ['pg', 'p', 'pagina', 'pag', 'per_page', 'size', 'qtd', 'quantity', 'skip', 'lmt']
  },
  sort: {
    canonical: ['sort', 'order', 'orderBy'],
    synonyms: ['srt', 'ordenar', 'classificar', 'by', 'direction', 'dir']
  },
  search: {
    canonical: ['q', 'search', 'query'],
    synonyms: ['busca', 'procurar', 'find', 'keyword', 'termo', 's']
  },
  fields: {
    canonical: ['fields', 'select', 'attributes'],
    synonyms: ['campos', 'cols', 'columns', 'only', 'project', 'show']
  }
};

const CANONICAL_KEYS = [
  ...DICTIONARY.pagination.canonical,
  ...DICTIONARY.sort.canonical,
  ...DICTIONARY.search.canonical,
  ...DICTIONARY.fields.canonical
];

function levenshtein(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const matrix = Array.from({ length: b.length + 1 }, (_, i) => Array(a.length + 1).fill(0));
  for (let i = 0; i <= b.length; i++) matrix[i][0] = i;
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      const cost = b.charAt(i - 1) === a.charAt(j - 1) ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }
  return matrix[b.length][a.length];
}

function soundex(s) {
  const a = s.toLowerCase().split('');
  const f = a.shift();
  const codes = { a: 0, e: 0, i: 0, o: 0, u: 0, y: 0, h: 0, w: 0, b: 1, f: 1, p: 1, v: 1, c: 2, g: 2, j: 2, k: 2, q: 2, s: 2, x: 2, z: 2, d: 3, t: 3, l: 4, m: 5, n: 5, r: 6 };
  const r = f + a.map((v) => codes[v]).filter((v, i, arr) => (i === 0 ? v !== codes[f] : v !== arr[i - 1])).filter((v) => v !== 0).join('');
  return (r + '000').slice(0, 4).toUpperCase();
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(err);
      }
    });
  });
}

function createAon(req, res) {
  const accept = req.headers['accept'] || '';
  const streaming = accept.includes('application/x-ndjson');
  const events = [];

  const log = (event) => {
    const payload = { timestamp: Date.now(), ...event };
    if (streaming) {
      if (!res.headersSent) {
        res.writeHead(200, {
          'Content-Type': 'application/x-ndjson',
          'Transfer-Encoding': 'chunked',
          Connection: 'keep-alive'
        });
      }
      res.write(JSON.stringify(payload) + '\n');
    } else {
      events.push(payload);
    }
  };

  const finalize = (payload, status = 200) => {
    if (streaming) {
      if (payload !== undefined) log({ type: 'result', data: payload, status });
      return res.end();
    }

    const headers = { 'Content-Type': 'application/json' };
    if (events.length) headers['x-aon-report'] = Buffer.from(JSON.stringify(events)).toString('base64');
    res.writeHead(status, headers);
    res.end(payload !== undefined ? JSON.stringify(payload) : '');
  };

  return { streaming, log, finalize, events };
}

// ---- Intent-aware GET parser ----
function parseIntentQuery(rawQuery, aon) {
  if (!rawQuery) return {};
  const decoded = decodeURIComponent(rawQuery.startsWith('?') ? rawQuery.slice(1) : rawQuery);
  const parts = decoded.split('&');
  const healed = {};

  for (const part of parts) {
    if (!part) continue;
    const match = part.match(/^([a-zA-Z0-9._\[\]]+)([^a-zA-Z0-9._\[\]]+)(.*)$/);
    let rawKey;
    let separator;
    let rawValue;

    if (match) {
      [, rawKey, separator, rawValue] = match;
    } else {
      rawKey = part;
      separator = '=';
      rawValue = 'true';
    }

    const { finalKey, correction } = healKey(rawKey);
    if (correction) aon.log({ type: 'healing', action: 'query_correction', detail: correction });

    const value = parseValue(finalKey, rawValue);
    setDeep(healed, finalKey, value);

    if (separator !== '=' && separator !== ':') {
      aon.log({ type: 'healing', action: 'operator_detection', detail: `Captured operator '${separator}' for ${finalKey}` });
      healed._operators = healed._operators || {};
      healed._operators[finalKey] = separator;
    }
  }

  aon.log({ type: 'status', message: 'Intent query parsed with fuzzy healing.' });
  return healed;
}

function healKey(rawKey) {
  const cleanBase = rawKey.split('[')[0].split('.')[0];

  for (const category of Object.values(DICTIONARY)) {
    if (category.canonical.includes(cleanBase)) return { finalKey: rawKey };
    const synonymIndex = category.synonyms.indexOf(cleanBase);
    if (synonymIndex > -1) {
      const corrected = rawKey.replace(cleanBase, category.canonical[0]);
      return { finalKey: corrected, correction: `Synonym mapped: '${rawKey}' -> '${corrected}'` };
    }
  }

  let best = null;
  let bestScore = Infinity;
  for (const candidate of CANONICAL_KEYS) {
    const distance = levenshtein(cleanBase, candidate);
    if (distance < bestScore && distance <= 2) {
      best = candidate;
      bestScore = distance;
    }
    if (soundex(cleanBase) === soundex(candidate)) {
      best = candidate;
      bestScore = 0; // prefer phonetic equality
    }
  }

  if (best) {
    const corrected = rawKey.replace(cleanBase, best);
    return { finalKey: corrected, correction: `Fuzzy typo fixed: '${rawKey}' -> '${corrected}'` };
  }

  return { finalKey: rawKey };
}

function parseValue(key, value) {
  if (DICTIONARY.fields.canonical.some((k) => key.startsWith(k))) {
    const matches = value.match(/[a-zA-Z0-9]+/g);
    return matches || [];
  }

  if (value.startsWith('[') && value.endsWith(']')) {
    return value.slice(1, -1).split(',').map((v) => v.trim());
  }

  if (value.includes(',') && !value.includes(' ')) {
    return value.split(',');
  }

  if (value === 'true') return true;
  if (value === 'false') return false;
  if (!Number.isNaN(Number(value)) && value.trim() !== '') return Number(value);

  return value;
}

function setDeep(obj, path, value) {
  const cleanPath = path.replace(/\[(\d+)\]/g, '.$1');
  const parts = cleanPath.split('.');
  let current = obj;
  for (let i = 0; i < parts.length; i++) {
    const key = parts[i];
    const last = i === parts.length - 1;
    if (last) {
      if (Object.prototype.hasOwnProperty.call(current, key)) {
        if (!Array.isArray(current[key])) current[key] = [current[key]];
        current[key].push(value);
      } else {
        current[key] = value;
      }
    } else {
      if (!current[key]) {
        const nextKey = parts[i + 1];
        current[key] = Number.isNaN(Number(nextKey)) ? {} : [];
      }
      current = current[key];
    }
  }
}

// ---- Route helpers ----
function normalizeRoute(req, aon) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let method = req.method.toUpperCase();
  let pathname = url.pathname.replace(/\/$/, '');
  if (pathname === '') pathname = '/';

  const idMatch = pathname.match(/^\/user\/(.+)$/);

  if (method === 'POST' && idMatch) {
    aon.log({ type: 'intent_analysis', decision: 'reroute', message: 'POST with id detected, rerouting to PUT.' });
    method = 'PUT';
  }

  if (method === 'PUT' && !idMatch) {
    aon.log({ type: 'intent_analysis', decision: 'reroute', message: 'PUT without id detected, rerouting to POST.' });
    method = 'POST';
  }

  req.normalizedMethod = method;
  req.normalizedPath = pathname;
  req.normalizedId = idMatch ? idMatch[1] : null;
  req.rawQuery = url.search;
}

function validateRoute(req, aon) {
  const allowed = ['GET', 'POST', 'PUT', 'DELETE'];
  if (!allowed.includes(req.normalizedMethod)) {
    aon.log({ type: 'error', code: 'METHOD_NOT_ALLOWED', message: `Method ${req.normalizedMethod} not allowed.` });
    return false;
  }

  if (!['/user', '/user/' + req.normalizedId].includes(req.normalizedPath) && !req.normalizedPath.startsWith('/user')) {
    aon.log({ type: 'error', code: 'NOT_FOUND', message: 'Route not found.' });
    return false;
  }

  return true;
}

function validateUserPayload(payload, aon, requireId = false) {
  if (requireId && !payload.id) {
    aon.log({ type: 'error', code: 'INVALID_SCHEMA', message: 'Missing id field for update/delete.' });
    return false;
  }

  if (!payload.name || typeof payload.name !== 'string') {
    aon.log({ type: 'error', code: 'INVALID_SCHEMA', message: 'name is required as string.' });
    return false;
  }

  if (!payload.email || typeof payload.email !== 'string') {
    aon.log({ type: 'error', code: 'INVALID_SCHEMA', message: 'email is required as string.' });
    return false;
  }

  return true;
}

// ---- Handlers ----
async function handleRequest(req, res) {
  const aon = createAon(req, res);
  req.aon = aon;

  normalizeRoute(req, aon);
  if (!validateRoute(req, aon)) return aon.finalize({ error: 'Invalid route' }, 404);

  if (req.normalizedMethod === 'GET') {
    const healedQuery = parseIntentQuery(req.rawQuery, aon);
    req.intentQuery = healedQuery;
  }

  try {
    if (req.normalizedMethod === 'GET') {
      return handleGet(req, res, aon);
    }
    if (req.normalizedMethod === 'POST') {
      const body = await parseJsonBody(req);
      req.body = body;
      if (!validateUserPayload(body, aon, false)) return aon.finalize({ error: 'Invalid payload' }, 400);
      return handlePost(req, res, aon);
    }
    if (req.normalizedMethod === 'PUT') {
      const body = await parseJsonBody(req);
      req.body = body;
      const id = req.normalizedId || body.id;
      if (!id) return aon.finalize({ error: 'Missing id for update' }, 400);
      if (!validateUserPayload({ ...body, id }, aon, true)) return aon.finalize({ error: 'Invalid payload' }, 400);
      return handlePut(req, res, aon, id);
    }
    if (req.normalizedMethod === 'DELETE') {
      const id = req.normalizedId;
      if (!id) return aon.finalize({ error: 'Missing id for delete' }, 400);
      return handleDelete(req, res, aon, id);
    }
  } catch (err) {
    aon.log({ type: 'error', code: 'SERVER_ERROR', message: err.message });
    return aon.finalize({ error: 'Server error' }, 500);
  }
}

function handleGet(req, res, aon) {
  const id = req.normalizedId;
  aon.log({ type: 'status', message: 'GET handler engaged. AON is available on GET routes.' });

  if (id) {
    const user = USERS.get(id);
    if (!user) return aon.finalize({ error: 'User not found' }, 404);
    return aon.finalize({ user, query: req.intentQuery || {} });
  }

  const all = Array.from(USERS.values());
  return aon.finalize({ users: all, query: req.intentQuery || {} });
}

function handlePost(req, res, aon) {
  const id = String(NEXT_ID++);
  const user = { id, name: req.body.name, email: req.body.email };
  USERS.set(id, user);
  aon.log({ type: 'result', message: 'User created via POST' });
  return aon.finalize(user, 201);
}

function handlePut(req, res, aon, id) {
  if (!USERS.has(id)) {
    aon.log({ type: 'healing', action: 'upsert', detail: 'User not found, creating instead.' });
  }
  const user = { id, name: req.body.name, email: req.body.email };
  USERS.set(id, user);
  aon.log({ type: 'result', message: 'User updated via PUT' });
  return aon.finalize(user);
}

function handleDelete(req, res, aon, id) {
  if (!USERS.has(id)) {
    aon.log({ type: 'error', code: 'NOT_FOUND', message: 'User not found for delete.' });
    return aon.finalize({ error: 'User not found' }, 404);
  }
  USERS.delete(id);
  aon.log({ type: 'status', message: 'User deleted.' });
  return aon.finalize({ success: true });
}

// ---- WebSocket (developer coaching) ----
const WS_CLIENTS = new Set();

function encodeWsFrame(message) {
  const payload = Buffer.from(typeof message === 'string' ? message : JSON.stringify(message));
  if (payload.length >= 126) throw new Error('Frame too large for simple encoder');
  const frame = Buffer.alloc(2 + payload.length);
  frame[0] = 0x81; // FIN + text frame
  frame[1] = payload.length; // no masking from server
  payload.copy(frame, 2);
  return frame;
}

function decodeWsFrame(buffer) {
  const isMasked = (buffer[1] & 0x80) === 0x80;
  let length = buffer[1] & 0x7f;
  let offset = 2;

  if (length === 126) {
    length = buffer.readUInt16BE(offset);
    offset += 2;
  }

  let mask;
  if (isMasked) {
    mask = buffer.slice(offset, offset + 4);
    offset += 4;
  }

  const payload = buffer.slice(offset, offset + length);
  if (isMasked && mask) {
    for (let i = 0; i < payload.length; i++) {
      payload[i] ^= mask[i % 4];
    }
  }

  return payload.toString('utf8');
}

function attachDeveloperWebSocket(serverInstance) {
  serverInstance.on('upgrade', (req, socket) => {
    const pathname = req.url.split('?')[0];
    if (pathname !== '/dev-ws') return socket.destroy();

    const key = req.headers['sec-websocket-key'];
    if (!key) return socket.destroy();

    const acceptKey = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    const headers = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey}`,
      '\r\n'
    ];
    socket.write(headers.join('\r\n'));

    const session = { attempt: 0 };
    WS_CLIENTS.add(socket);

    const send = (payload) => {
      try {
        socket.write(encodeWsFrame(payload));
      } catch (err) {
        socket.destroy();
      }
    };

    const prompt = () => {
      const nextAttempt = session.attempt + 1;
      send({ type: 'prompt', attempt: nextAttempt, message: `Envie um JSON com name/email (tentativa ${nextAttempt}/3)` });
    };

    prompt();

    socket.on('data', async (chunk) => {
      if (!chunk.length) return;
      const text = decodeWsFrame(chunk);
      session.attempt += 1;

      let payload;
      try {
        payload = JSON.parse(text);
      } catch (err) {
        payload = { name: '', email: text.trim() };
      }

      try {
        const result = await postThroughApi(payload);
        const success = result.status < 400;
        send({
          type: 'attempt_result',
          attempt: session.attempt,
          status: result.status,
          ok: success,
          body: result.body,
          aonReport: result.aonReport
        });

        if (success || session.attempt >= 3) {
          send({
            type: 'completed',
            ok: success,
            headerReport: result.aonReport,
            message: success ? 'Valor aceito pela API; relatório AON devolvido no cabeçalho.' : 'Limite de tentativas atingido sem sucesso.'
          });
          setTimeout(() => socket.end(), 50);
        } else {
          prompt();
        }
      } catch (err) {
        send({ type: 'error', message: err.message });
        setTimeout(() => socket.end(), 50);
      }
    });

    socket.on('end', () => WS_CLIENTS.delete(socket));
    socket.on('close', () => WS_CLIENTS.delete(socket));
    socket.on('error', () => WS_CLIENTS.delete(socket));
  });
}

function postThroughApi(payload) {
  const port = server.address().port || PORT;
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request(
      {
        method: 'POST',
        port,
        host: '127.0.0.1',
        path: '/user',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          let parsed = {};
          try {
            parsed = data ? JSON.parse(data) : {};
          } catch (err) {
            parsed = { parseError: err.message, raw: data };
          }
          resolve({ status: res.statusCode || 0, body: parsed, aonReport: res.headers['x-aon-report'] });
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ---- Server ----
const server = http.createServer(handleRequest);
attachDeveloperWebSocket(server);

server.listen(PORT, () => {
  console.log(`AON User API listening on port ${PORT}`);
});

module.exports = { server, parseIntentQuery, healKey, parseValue, setDeep, createAon, normalizeRoute, attachDeveloperWebSocket };
