'use strict';

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function json(res, status, value, extra = {}) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store, max-age=0',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...extra,
  });
  res.end(body);
}

async function readJson(req, limit = 65536) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
    throw new HttpError(415, 'content_type', 'Send an application/json request.');
  }
  if (Number(req.headers['content-length']) > limit) throw new HttpError(413, 'body_too_large', 'The request is too large.');
  let parsed;
  try {
    const provided = req.body;
    if (provided !== undefined) {
      if (Buffer.isBuffer(provided) || typeof provided === 'string') {
        if (Buffer.byteLength(provided) > limit) throw new HttpError(413, 'body_too_large', 'The request is too large.');
        parsed = JSON.parse(provided.toString());
      } else {
        if (Buffer.byteLength(JSON.stringify(provided)) > limit) throw new HttpError(413, 'body_too_large', 'The request is too large.');
        parsed = provided;
      }
    } else {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > limit) throw new HttpError(413, 'body_too_large', 'The request is too large.');
        chunks.push(bytes);
      }
      parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'bad_json', 'The request contains invalid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, 'bad_json', 'Send a JSON object.');
  return parsed;
}

function query(req) {
  let url;
  try { url = new URL(req.url, 'http://localhost'); }
  catch { throw new HttpError(400, 'bad_url', 'Invalid request URL.'); }
  const params = url.searchParams;
  for (const key of params.keys()) {
    if (params.getAll(key).length > 1) throw new HttpError(400, 'duplicate_parameter', 'A query parameter was supplied more than once.');
  }
  return params;
}

function requireMethod(req, res, method) {
  if (req.method !== method) {
    res.setHeader('Allow', method);
    throw new HttpError(405, 'method_not_allowed', 'This request method is not supported.');
  }
}

function requireReady(config) {
  if (!config.configured) throw new HttpError(503, 'not_configured', 'Payments are not available yet. Please contact the merchant.');
}

function handleError(res, error) {
  if (res.headersSent) { res.end(); return; }
  if (error instanceof HttpError) return json(res, error.status, { error: error.code, message: error.message });
  console.error('[checkout] request failed', error?.name || 'Error');
  return json(res, 503, { error: 'temporarily_unavailable', message: 'Payments are temporarily unavailable. Please try again shortly.' });
}

module.exports = { HttpError, json, readJson, query, requireMethod, requireReady, handleError };
