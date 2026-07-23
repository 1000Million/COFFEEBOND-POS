import { execFileSync } from 'node:child_process';

const PROJECT_ID = 'coffee-bond-pos';
const DATABASE_ID = '(default)';

function readCliAccessToken() {
  execFileSync('firebase', ['projects:list', '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const response = JSON.parse(
    execFileSync('firebase', ['login:list', '--json'], { encoding: 'utf8' }),
  );
  const accessToken = response?.result?.[0]?.tokens?.access_token;
  if (!accessToken) {
    throw new Error('An active Firebase CLI login is required for this zero-write dry run.');
  }
  return accessToken;
}

function decodeValue(value) {
  if (!value || typeof value !== 'object') return null;
  if ('nullValue' in value) return null;
  if ('booleanValue' in value) return value.booleanValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return Number(value.doubleValue);
  if ('timestampValue' in value) return value.timestampValue;
  if ('stringValue' in value) return value.stringValue;
  if ('bytesValue' in value) return value.bytesValue;
  if ('referenceValue' in value) return value.referenceValue;
  if ('geoPointValue' in value) return value.geoPointValue;
  if ('arrayValue' in value) {
    return (value.arrayValue.values || []).map(decodeValue);
  }
  if ('mapValue' in value) {
    return decodeFields(value.mapValue.fields || {});
  }
  return null;
}

function decodeFields(fields) {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [key, decodeValue(value)]),
  );
}

function documentId(documentName) {
  return String(documentName || '').split('/').pop();
}

export async function readFirestoreCollection(collectionName) {
  const accessToken = readCliAccessToken();
  const documents = [];
  let pageToken = '';

  do {
    const url = new URL(
      `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents/${encodeURIComponent(collectionName)}`,
    );
    url.searchParams.set('pageSize', '1000');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
    if (!response.ok) {
      const responseText = await response.text();
      throw new Error(
        `Read-only Firestore request for ${collectionName} failed (${response.status}): ${responseText.slice(0, 300)}`,
      );
    }

    const payload = await response.json();
    documents.push(
      ...(payload.documents || []).map((document) => ({
        id: documentId(document.name),
        data: decodeFields(document.fields || {}),
      })),
    );
    pageToken = payload.nextPageToken || '';
  } while (pageToken);

  return documents;
}
