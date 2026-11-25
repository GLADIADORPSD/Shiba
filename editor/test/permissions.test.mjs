import assert from 'node:assert/strict';
import test from 'node:test';
import { ADMIN, AUTHOR, ORIGIN, VISITOR, bio, fixture } from './fixture.mjs';

const post = (session, value, origin = ORIGIN) => ({
  method: 'POST',
  headers: { cookie: session, origin, 'content-type': 'application/json' },
  body: JSON.stringify(value),
});
const get = (session) => ({ headers: { cookie: session } });
const registry = 'config/registry.json';
const permissions = '/api/permissions';
const register = '/api/account/register';
const initial = { action: 'revoke', discordId: AUTHOR, person: 'pessoa-teste' };

test('editor gets only own binding; admin authority and own enrollment are rechecked', async () => {
  const f = await fixture();
  const editor = (await f.login(AUTHOR)).session;
  const admin = (await f.login(ADMIN)).session;
  const person = { type: 'bio', person: 'pessoa-teste', bio };
  const response = await (await f.request('/api/session', get(editor))).json();
  assert.deepEqual(Object.keys(response).sort(), ['own', 'people', 'role']);
  assert.equal(response.own.id, 'pessoa-teste');
  assert.ok(!JSON.stringify(response).includes(ADMIN));
  const before = f.calls.length;
  assert.equal((await f.request(permissions, get(editor))).status, 403);
  assert.equal(f.calls.slice(before).length, 1);
  assert.equal((await f.request(permissions, post(editor, {}))).status, 403);
  assert.equal(
    (await f.request(register, post(editor, { discordId: VISITOR }))).status,
    400,
  );
  assert.equal((await f.request(register, post(editor, {}))).status, 201);
  assert.equal((await f.request(register, post(editor, {}))).status, 200);
  assert.deepEqual(
    Object.keys(f.records.get('members/' + AUTHOR + '.json')).sort(),
    ['discordId', 'registeredAt', 'version'],
  );
  assert.equal(f.records.has('members/' + VISITOR + '.json'), false);
  const { revision } = await (await f.request(permissions, get(admin))).json();
  f.roles.set(ADMIN, []);
  const count = f.calls.length;
  assert.equal(
    (await f.request(permissions, post(admin, { ...initial, revision })))
      .status,
    403,
  );
  assert.equal(f.calls.length, count + 1);
  assert.equal(
    (await f.request('/api/drafts', post(editor, person))).status,
    201,
  );
});

test('binding and private audit commit together; stale/revoked writes fail closed', async () => {
  const f = await fixture();
  const editor = (await f.login(AUTHOR)).session;
  const admin = (await f.login(ADMIN)).session;
  const person = { type: 'bio', person: 'pessoa-teste', bio };
  const getPermissions = async () =>
    (await f.request(permissions, get(admin))).json();
  const existing = await (
    await f.request('/api/drafts', post(editor, person))
  ).json();
  const snapshot = await getPermissions();
  const penalty = { ...initial, revision: snapshot.revision };
  assert.equal(
    (
      await f.request(
        permissions,
        post(admin, penalty, 'https://other.invalid'),
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request(
        permissions,
        post(admin, { ...penalty, discordId: Number(AUTHOR) }),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request(
        permissions,
        post(admin, { ...penalty, discordId: ' ' + AUTHOR }),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request(
        permissions,
        post(admin, { ...penalty, person: 'outra-pessoa' }),
      )
    ).status,
    409,
  );
  f.race.nextRegistryWrite = true;
  assert.equal(
    (await f.request(permissions, post(admin, penalty))).status,
    409,
  );
  assert.equal(f.records.get(registry).permissionAudit, undefined);
  assert.equal(
    (await f.request(permissions, post(admin, penalty))).status,
    204,
  );
  const pending = await getPermissions();
  assert.notEqual(pending.revision, snapshot.revision);
  const staleDraft = await f.request(
    `/api/drafts/${AUTHOR}/${existing.id}/review`,
    post(admin, { decision: 'accepted', note: '' }),
  );
  assert.equal(staleDraft.status, 409);
  assert.deepEqual(pending.audit[0], {
    action: 'revoke',
    discordId: AUTHOR,
    person: 'pessoa-teste',
    by: ADMIN,
    at: new Date(f.now.value).toISOString(),
  });
  assert.equal(
    (await f.request('/api/drafts', post(editor, person))).status,
    403,
  );
  assert.equal(
    (await f.request(permissions, post(admin, penalty))).status,
    409,
  );
  const grant = { ...initial, action: 'grant', revision: pending.revision };
  assert.equal((await f.request(permissions, post(admin, grant))).status, 400);
  assert.equal((await f.request(register, post(editor, {}))).status, 201);
  assert.equal((await f.request(permissions, post(admin, grant))).status, 204);
  assert.equal(
    (await f.request('/api/drafts', post(editor, person))).status,
    201,
  );
  const done = await getPermissions();
  assert.deepEqual(
    done.audit.map((item) => item.action),
    ['grant', 'revoke'],
  );
  const registryWrites = f.calls.filter(
    (item) => item.method === 'PUT' && item.target.endsWith('/' + registry),
  );
  assert.deepEqual(
    registryWrites.map((item) => item.body.sha),
    [snapshot.revision, snapshot.revision, pending.revision],
  );
  assert.ok(
    registryWrites.every((item) =>
      new URL(item.target).pathname.startsWith(
        '/repos/Example/Editor-Private/',
      ),
    ),
  );
});
