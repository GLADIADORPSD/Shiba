import { repoStore } from './github.mjs';
import {
  applyPermissionChange,
  ensureDraft,
  permissionChange,
  proposal,
  registry,
  review,
  verifyDraftLink,
  verifiedMember,
} from './schema.mjs';
import {
  configuration,
  cookie,
  fail,
  oauthCookie,
  random,
  readCookie,
  readJson,
  s256,
  seal,
  sessionCookie,
  snowflake,
  unseal,
  uuid,
} from './security.mjs';

const discord = 'https://discord.com';
const scopes = ['identify', 'guilds.members.read'];
const hardening = {
  'cache-control': 'no-store',
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'x-robots-tag': 'noindex, nofollow',
};
const json = (value, status = 200) =>
  Response.json(value, { status, headers: hardening });
function redirect(location, cookies) {
  const headers = new Headers({ ...hardening, location });
  for (const value of cookies) headers.append('set-cookie', value);
  return new Response(null, { status: 303, headers });
}
const registryPath = 'config/registry.json';
const memberPath = (id) => `members/${id}.json`;
const pathFor = (author, id) => `drafts/${author}/${id}.json`;
const requests = (fetcher) => (path, init) =>
  fetcher(discord + path, {
    ...init,
    redirect: 'error',
    signal: AbortSignal.timeout(8000),
  });
async function membership(env, reqDiscord, accessToken, expected) {
  const res = await reqDiscord(
    `/api/v10/users/@me/guilds/${env.DISCORD_GUILD_ID}/member`,
    {
      headers: { authorization: `Bearer ${accessToken}` },
    },
  );
  // Revocation/group loss takes effect before any access to private GitHub contents.
  if (res.status === 401) fail(401, 'Entre novamente com Discord.');
  if ([403, 404].includes(res.status))
    fail(403, 'Acesso editorial não autorizado.');
  if (!res.ok) fail(503, 'Não foi possível confirmar seu papel no Discord.');
  const member = await res.json();
  if (member.user?.id !== expected || !Array.isArray(member.roles))
    fail(403, 'Acesso editorial não autorizado.');
  if (member.roles.includes(env.DISCORD_ADMIN_ROLE_ID)) return 'admin';
  if (member.roles.includes(env.DISCORD_EDITOR_ROLE_ID)) return 'editor';
  fail(403, 'É necessário um papel editorial no Discord.');
}

export function createEditor({ fetcher = fetch, clock = Date.now } = {}) {
  const reqDiscord = requests(fetcher);
  return {
    async fetch(req, bindings) {
      const url = new URL(req.url);
      const path = url.pathname;
      try {
        const env = configuration(bindings);
        if (url.origin !== env.APP_ORIGIN) fail(404, 'Página não encontrada.');
        const now = clock();
        if (
          req.method === 'GET' &&
          ['/', '/app.js', '/style.css'].includes(path)
        ) {
          const asset = await env.ASSETS.fetch(req);
          const headers = new Headers(asset.headers);
          for (const [name, value] of Object.entries(hardening))
            headers.set(name, value);
          return new Response(asset.body, { status: asset.status, headers });
        }
        if (path === '/login' && req.method === 'GET') {
          const state = random();
          const verifier =
            env.DISCORD_PKCE_MODE === 'required' ? random(48) : null;
          const authorization = new URL(discord + '/oauth2/authorize');
          authorization.search = new URLSearchParams({
            client_id: env.DISCORD_CLIENT_ID,
            response_type: 'code',
            redirect_uri: env.APP_ORIGIN + '/oauth/callback',
            scope: scopes.join(' '),
            state,
            ...(verifier
              ? {
                  code_challenge_method: 'S256',
                  code_challenge: await s256(verifier),
                }
              : {}),
          });
          return redirect(authorization.href, [
            cookie(
              oauthCookie,
              await seal(env.SESSION_KEY, env.APP_ORIGIN, 'oauth', {
                state,
                verifier,
                expires: now + 5 * 60_000,
              }),
              300,
            ),
          ]);
        }
        if (path === '/oauth/callback' && req.method === 'GET') {
          const clear = cookie(oauthCookie, '', 0);
          try {
            const auth = await unseal(
              env.SESSION_KEY,
              env.APP_ORIGIN,
              'oauth',
              readCookie(req, oauthCookie),
              now,
            );
            const code = url.searchParams.get('code');
            const state = url.searchParams.get('state');
            if (
              !auth ||
              state !== auth.state ||
              !code ||
              code.length > 512 ||
              url.searchParams.getAll('state').length !== 1 ||
              url.searchParams.getAll('code').length !== 1 ||
              (env.DISCORD_PKCE_MODE === 'required' && !auth.verifier) ||
              url.searchParams.has('error')
            )
              fail(403, 'Não foi possível entrar.');
            const result = await reqDiscord('/api/v10/oauth2/token', {
              method: 'POST',
              headers: { 'content-type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({
                client_id: env.DISCORD_CLIENT_ID,
                client_secret: env.DISCORD_CLIENT_SECRET,
                code,
                grant_type: 'authorization_code',
                redirect_uri: env.APP_ORIGIN + '/oauth/callback',
                ...(auth.verifier ? { code_verifier: auth.verifier } : {}),
              }),
            });
            if (!result.ok) fail(403, 'Não foi possível entrar.');
            const grant = await result.json();
            const oauthScopes = new Set(
              String(grant.scope ?? '').split(/\s+/u),
            );
            const token = grant.access_token;
            if (
              typeof token !== 'string' ||
              token.length < 1 ||
              token.length > 1800 ||
              grant.token_type?.toLowerCase() !== 'bearer' ||
              oauthScopes.size !== scopes.length ||
              !scopes.every((item) => oauthScopes.has(item)) ||
              !Number.isFinite(grant.expires_in) ||
              grant.expires_in < 1
            )
              fail(403, 'Não foi possível entrar.');
            const identity = await reqDiscord('/api/v10/users/@me', {
              headers: { authorization: `Bearer ${token}` },
            });
            if (!identity.ok) fail(403, 'Não foi possível entrar.');
            const { id } = await identity.json();
            if (!snowflake(id)) fail(403, 'Não foi possível entrar.');
            await membership(env, reqDiscord, token, id);
            const seconds = Math.min(600, Math.floor(grant.expires_in));
            const sealed = await seal(
              env.SESSION_KEY,
              env.APP_ORIGIN,
              'session',
              { id, token, expires: now + seconds * 1000 },
            );
            return redirect('/', [
              clear,
              cookie(sessionCookie, sealed, seconds),
            ]);
          } catch {
            return redirect('/?login=falhou', [
              clear,
              cookie(sessionCookie, '', 0),
            ]);
          }
        }
        if (!path.startsWith('/api/')) fail(404, 'Página não encontrada.');
        const mutating = req.method !== 'GET';
        if (
          mutating &&
          (req.method !== 'POST' ||
            req.headers.get('origin') !== env.APP_ORIGIN)
        )
          fail(403, 'Origem da solicitação não autorizada.');
        if (path === '/api/logout' && req.method === 'POST')
          return new Response(null, {
            status: 204,
            headers: {
              ...hardening,
              'set-cookie': cookie(sessionCookie, '', 0),
            },
          });
        const session = await unseal(
          env.SESSION_KEY,
          env.APP_ORIGIN,
          'session',
          readCookie(req, sessionCookie),
          now,
        );
        if (!snowflake(session?.id) || typeof session.token !== 'string')
          fail(401, 'Entre com Discord.');
        const role = await membership(
          env,
          reqDiscord,
          session.token,
          session.id,
        );
        const match = path.match(
          /^\/api\/drafts\/([^/]+)(?:\/([^/]+))?(?:\/(review))?$/u,
        );
        if (path === '/api/session' && req.method === 'GET') {
          const store = await repoStore(env, fetcher, now, false);
          const catalog = registry((await store.json(registryPath)).value);
          const assigned =
            catalog.people.get(catalog.owners.get(session.id)) ?? null;
          return json({
            role,
            own: assigned,
            people: [...catalog.people.values()].map(({ id, name }) => ({
              id,
              name,
            })),
          });
        }
        if (path === '/api/account/register' && req.method === 'POST') {
          const body = await readJson(req);
          if (
            !body ||
            typeof body !== 'object' ||
            Array.isArray(body) ||
            Object.keys(body).length
          )
            fail(400, 'A conta é obtida somente da sessão autenticada.');
          const store = await repoStore(env, fetcher, now, true);
          const path = memberPath(session.id);
          const existing = await store.json(path).catch((error) => {
            if (error.status === 404) return null;
            throw error;
          });
          if (existing) verifiedMember(existing.value, session.id);
          else
            await store.write(path, {
              version: 1,
              discordId: session.id,
              registeredAt: new Date(now).toISOString(),
            });
          return json({ discordId: session.id }, existing ? 200 : 201);
        }
        if (
          path === '/api/permissions' &&
          (req.method === 'GET' || req.method === 'POST')
        ) {
          if (role !== 'admin')
            fail(403, 'Apenas administradores gerenciam permissões.');
          const change =
            req.method === 'POST'
              ? permissionChange(await readJson(req))
              : null;
          const store = await repoStore(env, fetcher, now, Boolean(change));
          const stored = await store.json(registryPath);
          const catalog = registry(stored.value);
          if (!change)
            return json({
              revision: stored.sha,
              links: [...catalog.owners].map(([discordId, person]) => ({
                discordId,
                person,
              })),
              audit: catalog.permissionAudit.slice(-20).reverse(),
            });
          if (change.revision !== stored.sha)
            fail(
              409,
              'Permissões mudaram. Atualize a lista antes de tentar de novo.',
            );
          if (change.action === 'grant') {
            const target = await store
              .json(memberPath(change.discordId))
              .catch((error) => {
                if (error.status === 404)
                  fail(
                    400,
                    'Peça a essa pessoa para registrar a própria conta no painel antes de vincular.',
                  );
                throw error;
              });
            verifiedMember(target.value, change.discordId);
          }
          const updated = applyPermissionChange(
            change,
            stored.value,
            catalog,
            session.id,
            now,
          );
          await store.write(registryPath, updated, stored.sha);
          return new Response(null, { status: 204, headers: hardening });
        }
        if (path === '/api/drafts' && req.method === 'POST') {
          const body = await readJson(req);
          const store = await repoStore(env, fetcher, now, true);
          const catalog = registry((await store.json(registryPath)).value);
          const draft = proposal(body, session.id, catalog, now);
          await store.write(pathFor(session.id, draft.id), draft);
          return json(draft, 201);
        }
        if (path === '/api/drafts/mine' && req.method === 'GET') {
          const store = await repoStore(env, fetcher, now, false);
          return json({
            own: session.id,
            ids: (await store.list(`drafts/${session.id}`))
              .filter(
                (row) =>
                  row.type === 'file' &&
                  row.name.endsWith('.json') &&
                  uuid(row.name.slice(0, -5)),
              )
              .map((row) => row.name.slice(0, -5)),
          });
        }
        if (path === '/api/review' && req.method === 'GET') {
          if (role !== 'admin')
            fail(403, 'Apenas administradores revisam rascunhos.');
          const store = await repoStore(env, fetcher, now, false);
          return json({
            authors: (await store.list('drafts'))
              .filter((row) => row.type === 'dir' && snowflake(row.name))
              .map((row) => row.name),
          });
        }
        if (match) {
          const [, author, id, action] = match;
          if (!snowflake(author) || (id && !uuid(id)))
            fail(404, 'Registro não encontrado.');
          if (author !== session.id && role !== 'admin')
            fail(403, 'Rascunho privado.');
          if (action === 'review' && role !== 'admin')
            fail(403, 'Apenas administradores revisam rascunhos.');
          if (req.method === 'GET' && !action) {
            const store = await repoStore(env, fetcher, now, false);
            if (!id)
              return json({
                ids: (await store.list(`drafts/${author}`))
                  .filter(
                    (row) =>
                      row.type === 'file' &&
                      row.name.endsWith('.json') &&
                      uuid(row.name.slice(0, -5)),
                  )
                  .map((row) => row.name.slice(0, -5)),
              });
            return json(
              ensureDraft(
                (await store.json(pathFor(author, id))).value,
                author,
                id,
              ),
            );
          }
          if (action === 'review' && req.method === 'POST' && id) {
            const body = await readJson(req);
            const store = await repoStore(env, fetcher, now, true);
            const stored = await store.json(pathFor(author, id));
            const draft = ensureDraft(stored.value, author, id);
            if (body?.decision === 'accepted')
              verifyDraftLink(
                draft,
                registry((await store.json(registryPath)).value),
              );
            const updated = review(body, draft, session.id, now);
            await store.write(pathFor(author, id), updated, stored.sha);
            return json(updated);
          }
        }
        fail(404, 'Página não encontrada.');
      } catch (error) {
        const status =
          Number.isInteger(error?.status) &&
          error.status >= 400 &&
          error.status <= 599
            ? error.status
            : 503;
        return json(
          {
            error:
              status === 503 && !error.status
                ? 'Painel temporariamente indisponível.'
                : error.message,
          },
          status,
        );
      }
    },
  };
}
export default createEditor();
