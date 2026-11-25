import { b64url, decode64, encode64, fail } from './security.mjs';

const GH = 'https://api.github.com';
const utf8 = new TextEncoder();
const text = new TextDecoder('utf-8', { fatal: true });
const commitHash = (value) =>
  typeof value === 'string' && /^[a-f0-9]{40,64}$/.test(value);

async function sign(env, now) {
  const pem = env.GITHUB_PRIVATE_KEY.trim();
  if (
    !pem.startsWith('-----BEGIN PRIVATE KEY-----') ||
    !pem.endsWith('-----END PRIVATE KEY-----')
  )
    fail(503, 'Credencial editorial indisponível.');
  const data = pem.replace(
    /-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g,
    '',
  );
  const key = await crypto.subtle.importKey(
    'pkcs8',
    decode64(data),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const time = Math.floor(now / 1000);
  const json = (value) => b64url(utf8.encode(JSON.stringify(value)));
  const unsigned = `${json({ alg: 'RS256', typ: 'JWT' })}.${json({ iat: time - 60, exp: time + 300, iss: env.GITHUB_APP_ID })}`;
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    utf8.encode(unsigned),
  );
  return `${unsigned}.${b64url(new Uint8Array(sig))}`;
}

export async function repoStore(env, fetcher, now, writable) {
  const api = (path, token, init = {}) =>
    fetcher(GH + path, {
      ...init,
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'Shiba-Editor',
        authorization: `Bearer ${token}`,
        ...init.headers,
      },
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
    });
  const issued = await api(
    `/app/installations/${env.GITHUB_INSTALLATION_ID}/access_tokens`,
    await sign(env, now),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repository_ids: [Number(env.DRAFT_REPOSITORY_ID)],
        permissions: { contents: writable ? 'write' : 'read' },
      }),
    },
  );
  if (!issued.ok) fail(503, 'Arquivo editorial indisponível.');
  const { token } = await issued.json();
  if (typeof token !== 'string' || !token || token.length > 2048)
    fail(503, 'Arquivo editorial indisponível.');
  const repo =
    '/repos/' +
    env.DRAFT_REPOSITORY.split('/').map(encodeURIComponent).join('/');
  const metadata = await api(repo, token);
  if (!metadata.ok) fail(503, 'Arquivo editorial indisponível.');
  const actual = await metadata.json();
  if (
    String(actual.id) !== env.DRAFT_REPOSITORY_ID ||
    actual.private !== true ||
    actual.visibility !== 'private' ||
    actual.fork !== false ||
    actual.full_name?.toLowerCase() !== env.DRAFT_REPOSITORY.toLowerCase()
  )
    fail(503, 'O arquivo editorial deve ser um repositório privado dedicado.');
  const pathURL = (path) =>
    repo + '/contents/' + path.split('/').map(encodeURIComponent).join('/');
  return {
    async json(path) {
      const response = await api(pathURL(path), token);
      if (response.status === 404) fail(404, 'Registro não encontrado.');
      if (!response.ok) fail(503, 'Arquivo editorial indisponível.');
      const file = await response.json();
      if (
        file.type !== 'file' ||
        file.encoding !== 'base64' ||
        !commitHash(file.sha) ||
        !Number.isSafeInteger(file.size) ||
        file.size > 192000 ||
        typeof file.content !== 'string' ||
        file.content.length > 265000
      )
        fail(503, 'Registro editorial indisponível.');
      return {
        value: JSON.parse(text.decode(decode64(file.content))),
        sha: file.sha,
      };
    },
    async list(path) {
      const response = await api(pathURL(path), token);
      if (response.status === 404) return [];
      if (!response.ok) fail(503, 'Arquivo editorial indisponível.');
      const rows = await response.json();
      if (!Array.isArray(rows) || rows.length >= 1000)
        fail(
          503,
          'Fila editorial atingiu o limite; arquive registros antigos.',
        );
      return rows.map(({ name, type }) => ({ name, type }));
    },
    async write(path, value, sha) {
      if (!writable) fail(503, 'Credencial de escrita indisponível.');
      const response = await api(pathURL(path), token, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          message: 'Atualiza registro editorial',
          content: encode64(utf8.encode(JSON.stringify(value, null, 2) + '\n')),
          ...(sha ? { sha } : {}),
        }),
      });
      if ([409, 422].includes(response.status))
        fail(409, 'Registro alterado; recarregue antes de tentar novamente.');
      if (!response.ok) fail(503, 'Arquivo editorial indisponível.');
    },
  };
}
