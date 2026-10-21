// AWS Lambda entry point (API Gateway HTTP API, payload format 2.0).
// The JWT authorizer has already verified the Cognito access token; the user id comes from it.
import { createApp } from './app.js';
import { createDynamoDb } from './db-dynamo.js';
import { userFromClaims } from './claims.js';
import { createCognitoDirectory } from './directory-cognito.js';
import { createMailer } from './mail.js';

const app = createApp({
  db: createDynamoDb(),
  notify: process.env.MAIL_FROM ? createMailer(process.env.MAIL_FROM) : null,
  directory: process.env.USER_POOL_ID ? createCognitoDirectory(process.env.USER_POOL_ID) : null,
  appUrl: process.env.APP_URL || '',
});

const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

export async function handler(event) {
  let body;
  try {
    body = parseBody(event);
  } catch {
    return respond(400, { error: 'Die Anfrage konnte nicht gelesen werden.' });
  }
  const res = await app.handle({
    method: event.requestContext?.http?.method || 'GET',
    path: event.rawPath || '/',
    query: event.queryStringParameters || {},
    body,
    user: userFromClaims(event.requestContext?.authorizer?.jwt?.claims),
  });
  if (res.raw !== undefined) {
    const headers = { 'content-type': res.contentType, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
    if (res.filename) headers['content-disposition'] = `attachment; filename="${res.filename}"`;
    return { statusCode: res.status, headers, body: res.raw };
  }
  return respond(res.status, res.body);
}

// Yearly schedule (EventBridge): delete what is older than the current year plus two.
export async function retention() {
  return app.runRetention();
}

function parseBody(event) {
  if (!event.body) return undefined;
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  return JSON.parse(raw);
}

function respond(statusCode, body) {
  return { statusCode, headers: HEADERS, body: JSON.stringify(body) };
}
