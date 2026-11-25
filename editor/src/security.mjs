const utf8 = new TextEncoder();
const text = new TextDecoder();
export const oauthCookie = '__Host-shiba_oauth';
export const sessionCookie = '__Host-shiba_session';
export const snowflake = (value) =>
  typeof value === 'string' && /^[1-9][0-9]{15,21}$/.test(value);
export const uuid = (value) =>
  typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
    value,
  );
export const slug = (value) =>
  typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value);
export function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}
export const encode64 = (bytes) =>
  btoa(Array.from(bytes, (i) => String.fromCharCode(i)).join(''));
export const decode64 = (value) =>
  Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
export const b64url = (bytes) =>
  encode64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromUrl = (value) =>
  decode64(value.replace(/-/g, '+').replace(/_/g, '/'));
export const random = (size = 32) =>
  b64url(crypto.getRandomValues(new Uint8Array(size)));
const aad = (purpose, origin) =>
  utf8.encode(`shiba-editor/v1:${purpose}:${origin}`);
const keyFor = (key) =>
  crypto.subtle.importKey('raw', fromUrl(key), 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);

export async function seal(key, origin, purpose, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad(purpose, origin) },
    await keyFor(key),
    utf8.encode(JSON.stringify(value)),
  );
  return `${b64url(iv)}.${b64url(new Uint8Array(encrypted))}`;
}
export async function unseal(key, origin, purpose, value, now) {
  if (!value || value.length > 3600 || !/^[\w-]+\.[\w-]+$/.test(value))
    return null;
  try {
    const [iv, encrypted] = value.split('.').map(fromUrl);
    if (iv.length !== 12) return null;
    const decoded = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: aad(purpose, origin) },
      await keyFor(key),
      encrypted,
    );
    const payload = JSON.parse(text.decode(decoded));
    return Number.isSafeInteger(payload?.expires) && payload.expires > now
      ? payload
      : null;
  } catch {
    return null;
  }
}
export async function s256(value) {
  return b64url(
    new Uint8Array(await crypto.subtle.digest('SHA-256', utf8.encode(value))),
  );
}
export function cookie(name, value, seconds) {
  return `${name}=${value}; Path=/; Max-Age=${seconds}; Secure; HttpOnly; SameSite=Lax`;
}
export function readCookie(req, name) {
  const values = (req.headers.get('cookie') ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  return values.length === 1 ? values[0].slice(name.length + 1) : '';
}
export function configuration(env) {
  const required = [
    'APP_ORIGIN',
    'DISCORD_CLIENT_ID',
    'DISCORD_CLIENT_SECRET',
    'DISCORD_GUILD_ID',
    'DISCORD_EDITOR_ROLE_ID',
    'DISCORD_ADMIN_ROLE_ID',
    'SESSION_KEY',
    'GITHUB_APP_ID',
    'GITHUB_INSTALLATION_ID',
    'GITHUB_PRIVATE_KEY',
    'DRAFT_REPOSITORY',
    'DRAFT_REPOSITORY_ID',
  ];
  if (required.some((name) => typeof env[name] !== 'string' || !env[name]))
    fail(503, 'Painel ainda não configurado.');
  let origin;
  try {
    origin = new URL(env.APP_ORIGIN);
  } catch {
    fail(503, 'Painel ainda não configurado.');
  }
  const repo = env.DRAFT_REPOSITORY;
  const numeric = (value) => /^[1-9][0-9]{0,14}$/.test(value);
  if (
    origin.protocol !== 'https:' ||
    origin.origin !== env.APP_ORIGIN ||
    ![
      env.DISCORD_CLIENT_ID,
      env.DISCORD_GUILD_ID,
      env.DISCORD_EDITOR_ROLE_ID,
      env.DISCORD_ADMIN_ROLE_ID,
    ].every(snowflake) ||
    env.DISCORD_EDITOR_ROLE_ID === env.DISCORD_ADMIN_ROLE_ID ||
    [env.DISCORD_EDITOR_ROLE_ID, env.DISCORD_ADMIN_ROLE_ID].includes(
      env.DISCORD_GUILD_ID,
    ) ||
    ![
      env.GITHUB_APP_ID,
      env.GITHUB_INSTALLATION_ID,
      env.DRAFT_REPOSITORY_ID,
    ].every(numeric) ||
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(
      repo,
    ) ||
    repo.toLowerCase() === 'gladiadorpsd/shiba' ||
    !/^[\w-]{43}$/.test(env.SESSION_KEY) ||
    fromUrl(env.SESSION_KEY).length !== 32 ||
    !['required', 'unavailable'].includes(env.DISCORD_PKCE_MODE)
  )
    fail(503, 'Painel ainda não configurado.');
  return env;
}
export async function readJson(req) {
  if (
    req.headers.get('content-type')?.split(';')[0].trim() !== 'application/json'
  )
    fail(415, 'Envie JSON.');
  const limit = 16000;
  if (!req.body || Number(req.headers.get('content-length') || 0) > limit)
    fail(413, 'Rascunho muito grande.');
  const reader = req.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0,
    value = '';
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        fail(413, 'Rascunho muito grande.');
      }
      value += decoder.decode(result.value, { stream: true });
    }
    return JSON.parse(value + decoder.decode());
  } catch (error) {
    if (error.status) throw error;
    fail(400, 'JSON inválido.');
  }
}
