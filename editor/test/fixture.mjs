/* Synthetic development-only dependency injection; no Discord/GitHub network or credentials. */
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createEditor } from '../src/worker.mjs';
import { encode64, random, s256 } from '../src/security.mjs';

export const ORIGIN = 'https://editor.shiba.test';
export const AUTHOR = '100000000000000001';
export const ADMIN = '100000000000000002';
export const VISITOR = '100000000000000003';
export const COOKIE = '__Host-shiba_session';
export const summary = 'Resumo sintético para teste.';
export const bio = {
  summary,
  sections: [{ heading: 'Início', content: 'História sintética.' }],
};
const testData = {
  version: 1,
  people: [
    { id: 'pessoa-teste', name: 'Pessoa de Teste', bio },
    { id: 'outra-pessoa', name: 'Outra Pessoa' },
  ],
  owners: { [AUTHOR]: 'pessoa-teste', [ADMIN]: 'outra-pessoa' },
};
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const hash = (value) =>
  createHash('sha1').update(JSON.stringify(value)).digest('hex');

export async function fixture() {
  const now = { value: Date.now() };
  const race = { nextRegistryWrite: false };
  const roles = new Map([
    [AUTHOR, ['100000000000000010']],
    [ADMIN, ['100000000000000011']],
    [VISITOR, []],
  ]);
  const calls = [];
  const records = new Map([
    ['config/registry.json', structuredClone(testData)],
  ]);
  const challenges = new Map();
  const meta = {
    id: 4321,
    private: true,
    visibility: 'private',
    fork: false,
    full_name: 'Example/Editor-Private',
  };
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  const key = encode64(
    new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey)),
  );
  const env = {
    APP_ORIGIN: ORIGIN,
    DISCORD_CLIENT_ID: '100000000000000009',
    DISCORD_CLIENT_SECRET: 'synthetic-secret',
    DISCORD_GUILD_ID: '100000000000000007',
    DISCORD_EDITOR_ROLE_ID: '100000000000000010',
    DISCORD_ADMIN_ROLE_ID: '100000000000000011',
    DISCORD_PKCE_MODE: 'required',
    SESSION_KEY: random(),
    GITHUB_APP_ID: '21',
    GITHUB_INSTALLATION_ID: '1234',
    GITHUB_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${key}\n-----END PRIVATE KEY-----`,
    DRAFT_REPOSITORY: 'Example/Editor-Private',
    DRAFT_REPOSITORY_ID: '4321',
    ASSETS: {
      async fetch(request) {
        const path = new URL(request.url).pathname;
        const files = {
          '/': ['index.html', 'text/html'],
          '/style.css': ['style.css', 'text/css'],
          '/app.js': ['app.js', 'text/javascript'],
        };
        const [file, type] = files[path] ?? [];
        return file
          ? new Response(
              await readFile(new URL('../public/' + file, import.meta.url)),
              { headers: { 'content-type': type } },
            )
          : new Response(null, { status: 404 });
      },
    },
  };
  const ok = (value) => Response.json(value);
  const missing = () => new Response(null, { status: 404 });
  const repo = '/repos/Example/Editor-Private';
  const api = createEditor({
    clock: () => now.value,
    async fetcher(target, opts = {}) {
      const url = new URL(target);
      const path = url.pathname;
      const method = opts.method || 'GET';
      calls.push({
        target,
        method,
        ...(url.hostname === 'api.github.com' && opts.body
          ? { body: JSON.parse(opts.body) }
          : {}),
      });
      if (url.hostname === 'discord.com') {
        if (path === '/api/v10/oauth2/token') {
          const id = opts.body.get('code');
          const challenge = challenges.get(id);
          const verifier = opts.body.get('code_verifier');
          if (!challenge || !verifier || challenge !== (await s256(verifier)))
            return missing();
          challenges.delete(id);
          return ok({
            access_token: 'test-' + id,
            token_type: 'Bearer',
            expires_in: 3600,
            scope: 'identify guilds.members.read',
          });
        }
        const id = (opts.headers?.authorization || '').replace(
          /^Bearer test-/,
          '',
        );
        if (!roles.has(id)) return missing();
        if (path === '/api/v10/users/@me') return ok({ id });
        if (path === '/api/v10/users/@me/guilds/100000000000000007/member')
          return ok({ user: { id }, roles: roles.get(id) });
      }
      if (url.hostname === 'api.github.com') {
        if (path === '/app/installations/1234/access_tokens') {
          const data = JSON.parse(opts.body);
          const parts = opts.headers.authorization
            .replace(/^Bearer /, '')
            .split('.');
          const signature = Uint8Array.from(
            atob(parts[2].replace(/-/g, '+').replace(/_/g, '/')),
            (c) => c.charCodeAt(0),
          );
          if (
            !(await crypto.subtle.verify(
              'RSASSA-PKCS1-v1_5',
              pair.publicKey,
              signature,
              encoder.encode(parts[0] + '.' + parts[1]),
            ))
          )
            return missing();
          if (
            JSON.stringify(data.repository_ids) !== '[4321]' ||
            !['read', 'write'].includes(data.permissions.contents)
          )
            throw new Error('unscoped token');
          return ok({
            token: 'fixture-installation-' + data.permissions.contents,
          });
        }
        if (path === repo) return ok(meta);
        if (path.startsWith(repo + '/contents/')) {
          const key = path.slice((repo + '/contents/').length);
          if (method === 'PUT') {
            if (
              opts.headers.authorization !== 'Bearer fixture-installation-write'
            )
              throw Error('unscoped write');
            const { sha, content } = JSON.parse(opts.body);
            if (key === 'config/registry.json' && race.nextRegistryWrite) {
              race.nextRegistryWrite = false;
              return new Response(null, { status: 409 });
            }
            if (
              records.has(key) !== Boolean(sha) ||
              (sha && sha !== hash(records.get(key)))
            )
              return new Response(null, { status: 409 });
            records.set(
              key,
              JSON.parse(
                decoder.decode(
                  Uint8Array.from(atob(content), (c) => c.charCodeAt(0)),
                ),
              ),
            );
            return ok({});
          }
          if (records.has(key)) {
            const data = encoder.encode(JSON.stringify(records.get(key)));
            return ok({
              type: 'file',
              sha: hash(records.get(key)),
              encoding: 'base64',
              content: encode64(data),
              size: data.length,
            });
          }
          const files = new Map(
            [...records.keys()]
              .filter((p) => p.startsWith(key + '/'))
              .map((p) => {
                const [name, sub] = p.slice(key.length + 1).split('/');
                return [name, { name, type: sub ? 'dir' : 'file' }];
              }),
          );
          return files.size ? ok([...files.values()]) : missing();
        }
      }
      throw Error('Unexpected fixture request');
    },
  });
  const request = (path, init) =>
    api.fetch(new Request(ORIGIN + path, init), env);
  const cookiePair = (headers, name) =>
    headers
      .getSetCookie()
      .find((part) => part.startsWith(name + '='))
      ?.split(';')[0];
  async function login(id, { overrideState } = {}) {
    // state override is for negative test fixtures
    const res = await request('/login');
    const authorization = new URL(res.headers.get('location'));
    challenges.set(id, authorization.searchParams.get('code_challenge'));
    const query = new URLSearchParams({
      code: id,
      state: overrideState ?? authorization.searchParams.get('state'),
    });
    const callback = await request('/oauth/callback?' + query, {
      headers: { cookie: cookiePair(res.headers, '__Host-shiba_oauth') },
    });
    return {
      authorization,
      initial: res,
      callback,
      session: cookiePair(callback.headers, COOKIE),
    };
  }
  return { env, api, request, login, records, calls, roles, meta, now, race };
}
