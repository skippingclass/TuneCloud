// Zero-dependency Subsonic response builder (XML by default, JSON/JSONP via f=).
//
// Payload convention (shared by JSON and XML):
//   { musicFolders: { musicFolder: [ { id: 1, name: 'x' } ] } }
// In XML, primitive properties become attributes, objects become child
// elements and arrays become repeated child elements with the property name.

export const API_VERSION = '1.16.1';
export const SERVER_TYPE = 'tunecloud';
export const SERVER_VERSION = '0.1.0';

export const ErrorCode = {
  GENERIC: 0,
  MISSING_PARAM: 10,
  CLIENT_TOO_OLD: 20,
  WRONG_CREDENTIALS: 40,
  NOT_AUTHORIZED: 50,
  NOT_FOUND: 70,
};

export function escapeXml(unsafe) {
  if (unsafe === null || unsafe === undefined) return '';
  return String(unsafe).replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
    }
  });
}

function isPrimitive(v) {
  return v === null || typeof v !== 'object' || v instanceof Date;
}

function renderValue(v) {
  return v instanceof Date ? v.toISOString() : v;
}

function renderElement(name, obj) {
  let attrs = '';
  let children = '';
  let textContent = '';
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    if (k === '_text' || k === '_content') {
      textContent = escapeXml(renderValue(v));
    } else if (k === 'value' && (name === 'lyrics' || name === 'line' || name === 'genre')) {
      textContent = escapeXml(renderValue(v));
    } else if ((k === 'artists' || k === 'albumArtists') && Array.isArray(v)) {
      let inner = '';
      for (const item of v) {
        inner += isPrimitive(item) ? `<artist>${escapeXml(renderValue(item))}</artist>` : renderElement('artist', item);
      }
      children += `<${k}>${inner}</${k}>`;
    } else if (isPrimitive(v)) {
      attrs += ` ${k}="${escapeXml(renderValue(v))}"`;
    } else {
      children += renderXmlChildren({ [k]: v });
    }
  }
  const body = textContent + children;
  return body ? `<${name}${attrs}>${body}</${name}>` : `<${name}${attrs}/>`;
}

export function renderXmlChildren(data) {
  if (!data) return '';
  let out = '';
  for (const [k, v] of Object.entries(data)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) {
      for (const item of v) {
        out += isPrimitive(item) ? `<${k}>${escapeXml(renderValue(item))}</${k}>` : renderElement(k, item);
      }
    } else if (!isPrimitive(v)) {
      out += renderElement(k, v);
    }
  }
  return out;
}

function getParam(req, name) {
  return req.body?.[name] ?? req.query?.[name];
}

const LOCAL_HOST_RE = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i;

function resolveImageBaseUrl(req) {
  if (process.env.PUBLIC_URL) {
    return process.env.PUBLIC_URL.replace(/\/$/, '');
  }
  const host = typeof req?.headers?.host === 'string' ? req.headers.host.trim() : '';
  if (host && LOCAL_HOST_RE.test(host)) {
    const proto = req.protocol === 'https' ? 'https' : 'http';
    return `${proto}://${host}`;
  }
  return '';
}

function imageUrls(value, req) {
  if (Array.isArray(value)) return value.map(item => imageUrls(item, req));
  if (!value || typeof value !== 'object' || value instanceof Date) return value;
  const baseUrl = resolveImageBaseUrl(req);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    /ImageUrl$/.test(key) && typeof item === 'string' && item.startsWith('/api/cover/') && baseUrl
      ? `${baseUrl}${item}` : imageUrls(item, req)]));
}

export function buildSubsonicResponse(reply, req, data, isError = false, errorCode = 0, errorMessage = '') {
  data = imageUrls(data, req);
  const format = String(getParam(req, 'f') || 'xml').toLowerCase();
  const status = isError ? 'failed' : 'ok';

  if (format === 'json' || format === 'jsonp') {
    const res = {
      'subsonic-response': {
        status,
        version: API_VERSION,
        type: SERVER_TYPE,
        serverVersion: SERVER_VERSION,
        openSubsonic: true,
        ...(isError ? { error: { code: errorCode, message: errorMessage } } : data),
      },
    };
    const callback = getParam(req, 'callback');
    if (format === 'jsonp' && callback && /^[\w.$]+$/.test(callback)) {
      return reply.type('application/javascript; charset=utf-8').send(`${callback}(${JSON.stringify(res)});`);
    }
    return reply.type('application/json; charset=utf-8').send(res);
  }

  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<subsonic-response xmlns="http://subsonic.org/restapi" status="${status}" version="${API_VERSION}" type="${SERVER_TYPE}" serverVersion="${SERVER_VERSION}" openSubsonic="true">`;

  if (isError) {
    xml += `<error code="${errorCode}" message="${escapeXml(errorMessage)}"/>`;
  } else {
    xml += renderXmlChildren(data);
  }

  xml += `</subsonic-response>`;
  return reply.type('text/xml; charset=utf-8').send(xml);
}

export function sendOk(reply, req, data = {}) {
  return buildSubsonicResponse(reply, req, data);
}

export function sendError(reply, req, code, message) {
  return buildSubsonicResponse(reply, req, null, true, code, message);
}
