import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ADMIN,
  AUTHOR,
  COOKIE,
  ORIGIN,
  VISITOR,
  bio,
  fixture,
} from './fixture.mjs';

const post = (session, value, origin = ORIGIN) => ({
  method: 'POST',
  headers: { cookie: session, origin, 'content-type': 'application/json' },
  body: JSON.stringify(value),
});
const get = (session) => ({ headers: { cookie: session } });

test('default deny; OAuth state, exact scopes, S256 and stable guild identity', async () => {
  const f = await fixture();
  const deny = await f.api.fetch(new Request(ORIGIN + '/'), {});
  assert.equal(deny.status, 503);
  const invalid = await f.login(AUTHOR, { overrideState: 'mismatch' });
  assert.equal(invalid.callback.headers.get('location'), '/?login=falhou');
  assert.equal(f.calls.length, 0);
  const visitor = await f.login(VISITOR);
  assert.equal(visitor.callback.headers.get('location'), '/?login=falhou');
  const editor = await f.login(AUTHOR);
  assert.equal(editor.authorization.origin, 'https://discord.com');
  assert.equal(
    editor.authorization.searchParams.get('scope'),
    'identify guilds.members.read',
  );
  assert.equal(
    editor.authorization.searchParams.get('code_challenge_method'),
    'S256',
  );
  assert.match(
    editor.initial.headers.getSetCookie()[0],
    /Path=\/; Max-Age=300; Secure; HttpOnly; SameSite=Lax/,
  );
  assert.equal(editor.callback.headers.get('location'), '/');
  assert.match(
    editor.callback.headers.getSetCookie()[1],
    /Path=\/; Max-Age=600; Secure; HttpOnly; SameSite=Lax/,
  );
  assert.ok(editor.session.startsWith(COOKIE + '='));
  assert.ok(!editor.session.includes('test-' + AUTHOR));
  const panel = await f.request('/');
  assert.equal(panel.status, 200);
  assert.match(
    panel.headers.get('content-security-policy'),
    /frame-ancestors 'none'/,
  );
  assert.match(await panel.text(), /Oficina Shiba/);
  assert.equal((await f.request('/api/session')).status, 401);
  assert.equal(
    (await f.request('/api/session', get(editor.session))).status,
    200,
  );
  f.now.value += 600 * 1000;
  assert.equal(
    (await f.request('/api/session', get(editor.session))).status,
    401,
  );
});

test('only own biography; validate links and text; fresh role/Origin checks before mutating', async () => {
  const f = await fixture();
  const login = await f.login(AUTHOR);
  const session = login.session;
  const payload = { type: 'bio', person: 'pessoa-teste', bio };
  const before = f.calls.length;
  assert.equal(
    (
      await f.request(
        '/api/drafts',
        post(session, payload, 'https://wrong.invalid'),
      )
    ).status,
    403,
  );
  assert.equal(f.calls.length, before);
  assert.equal(
    (
      await f.request(
        '/api/drafts',
        post(session, { ...payload, person: 'outra-pessoa' }),
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request(
        '/api/drafts',
        post(session, { ...payload, path: 'index.html' }),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request(
        '/api/drafts',
        post(session, { ...payload, bio: { ...bio, summary: '<marcação>' } }),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request(
        '/api/drafts',
        post(session, {
          type: 'person',
          name: 'Nova',
          relatedPerson: 'nao-existe',
          relation: 'familiar',
          bio,
        }),
      )
    ).status,
    400,
  );
  assert.equal(f.records.size, 1);
  const created = await f.request('/api/drafts', post(session, payload));
  assert.equal(created.status, 201);
  const draft = await created.json();
  assert.equal(draft.status, 'pending');
  assert.equal(draft.author, AUTHOR);
  assert.equal(
    f.records.get(`drafts/${AUTHOR}/${draft.id}.json`).bio.summary,
    bio.summary,
  );
  const other = (await f.login(ADMIN)).session;
  assert.equal(
    (await f.request(`/api/drafts/${ADMIN}/${draft.id}`, get(session))).status,
    403,
  );
  assert.equal(
    (
      await f.request(
        `/api/drafts/${AUTHOR}/${draft.id}/review`,
        post(session, { decision: 'accepted', note: '' }),
      )
    ).status,
    403,
  );
  const mine = await (await f.request('/api/drafts/mine', get(session))).json();
  assert.deepEqual(mine, { own: AUTHOR, ids: [draft.id] });
  f.roles.set(AUTHOR, []);
  const expired = f.calls.length;
  assert.equal(
    (await f.request('/api/drafts', post(session, payload))).status,
    403,
  );
  assert.equal(f.calls.length, expired + 1);
  assert.equal((await f.request('/api/review', get(other))).status, 200);
});

test('only admin reviews new person and private records; no public publishing', async () => {
  const f = await fixture();
  const author = (await f.login(AUTHOR)).session;
  const admin = (await f.login(ADMIN)).session;
  const payload = {
    type: 'person',
    name: 'Nova personagem',
    relatedPerson: 'pessoa-teste',
    relation: 'amigo',
    bio,
  };
  const draft = await (
    await f.request('/api/drafts', post(author, payload))
  ).json();
  const path = `/api/drafts/${AUTHOR}/${draft.id}`;
  const createdPath = `drafts/${AUTHOR}/${draft.id}.json`;
  assert.equal((await f.request(path)).status, 401);
  assert.equal((await f.request('/api/review', get(author))).status, 403);
  assert.equal(
    (
      await f.request(
        path + '/review',
        post(admin, { decision: 'accepted', note: 'Revisado' }),
      )
    ).status,
    200,
  );
  assert.equal(f.records.get(createdPath).status, 'accepted');
  assert.equal(f.records.get(createdPath).review.reviewer, ADMIN);
  assert.equal(
    (
      await f.request(
        path + '/review',
        post(admin, { decision: 'accepted', note: '' }),
      )
    ).status,
    409,
  );
  const writes = f.calls.filter((i) => i.method === 'PUT');
  assert.equal(writes.length, 2);
  assert.ok(
    writes.every(
      (w) =>
        new URL(w.target).pathname ===
        '/repos/Example/Editor-Private/contents/' + createdPath,
    ),
  );
  assert.match(writes[1].body.sha, /^[a-f0-9]{40}$/u);
  assert.deepEqual(
    [...f.records.keys()],
    ['config/registry.json', createdPath],
  );
  const own = await (
    await f.request(
      '/api/drafts',
      post(admin, { type: 'bio', person: 'outra-pessoa', bio }),
    )
  ).json();
  assert.equal(
    (
      await f.request(
        `/api/drafts/${ADMIN}/${own.id}/review`,
        post(admin, { decision: 'accepted', note: '' }),
      )
    ).status,
    403,
  );
});

test('GitHub App fails closed for public, mismatched or forked storage, without content requests', async () => {
  const f = await fixture();
  const session = (await f.login(AUTHOR)).session;
  const payload = { type: 'bio', person: 'pessoa-teste', bio };
  for (const trans of [
    { private: false, visibility: 'public' },
    { private: true, visibility: 'private', id: 9876 },
    { id: 4321, fork: true },
  ]) {
    Object.assign(f.meta, trans);
    assert.equal(
      (await f.request('/api/drafts', post(session, payload))).status,
      503,
    );
  }
  assert.ok(!f.calls.some((item) => item.target.includes('/contents/')));
  f.env.DRAFT_REPOSITORY = 'GLADIADORPSD/Shiba';
  assert.equal(
    (await f.request('/api/drafts', post(session, payload))).status,
    503,
  );
});
