const $ = (id) => document.getElementById(id);
const form = $('draft');
const reviewForm = $('review-form');
const permissionForm = $('permissions-form');
const statusText = {
  pending: 'Em revisão',
  accepted: 'Aceito, aguarda publicação manual',
  rejected: 'Recusado',
};
const roleText = { admin: 'Administração', editor: 'Editor' };
let session,
  self,
  current,
  saving = false;
const notice = (text = '') => {
  $('notice').textContent = text;
};
const field = (name) => form.elements.namedItem(name);
async function api(path, value) {
  const result = await fetch(
    path,
    value === undefined
      ? undefined
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(value),
        },
  );
  if (result.status === 204) return null;
  const data = await result.json();
  if (!result.ok) throw Error(data.error || 'Operação indisponível.');
  return data;
}
const optionList = (element, rows) => {
  element.replaceChildren(
    new Option('Selecione', ''),
    ...rows.map(([id, label]) => new Option(label, id)),
  );
};
function section(values = {}) {
  if ($('sections').children.length === 6) return;
  const pack = document.createElement('fieldset');
  const legend = document.createElement('legend');
  legend.textContent = 'Seção da biografia';
  const heading = document.createElement('input');
  const content = document.createElement('textarea');
  function label(text, input, limit, value) {
    const node = document.createElement('label');
    node.textContent = text;
    input.maxLength = limit;
    input.required = true;
    input.value = value || '';
    node.append(input);
    return node;
  }
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.textContent = 'Remover seção';
  remove.addEventListener('click', () => {
    if ($('sections').children.length > 1) pack.remove();
  });
  content.rows = 4;
  pack.append(
    legend,
    label('Título', heading, 90, values.heading),
    label('Texto', content, 1400, values.content),
    remove,
  );
  $('sections').append(pack);
}
function fields() {
  return {
    summary: field('summary').value,
    sections: [...$('sections').querySelectorAll('fieldset')].map((item) => ({
      heading: item.querySelector('input').value,
      content: item.querySelector('textarea').value,
    })),
  };
}
function drawBio(container, bio) {
  container.replaceChildren();
  const p = document.createElement('p');
  p.textContent = bio.summary;
  container.append(p);
  for (const item of bio.sections) {
    const title = document.createElement('h3');
    title.textContent = item.heading;
    const p = document.createElement('p');
    p.textContent = item.content;
    container.append(title, p);
  }
}
function changeType() {
  const isPerson = field('type').value === 'person';
  $('new-person').hidden = !isPerson;
  $('own-hint').textContent = isPerson
    ? 'A administração revisa o novo vínculo antes da publicação.'
    : session.own
      ? `Biografia vinculada a ${session.own.name}.`
      : 'Sua conta não está vinculada a uma biografia.';
  field('personName').required = isPerson;
  field('relatedPerson').required = isPerson;
  $('preview').hidden = true;
}
async function mine() {
  const data = await api('/api/drafts/mine');
  self = data.own;
  optionList(
    $('mine'),
    data.ids.map((id) => [id, id]),
  );
}
async function queue() {
  const data = await api('/api/review');
  optionList(
    $('authors'),
    data.authors.map((id) => [id, id]),
  );
  optionList($('author-drafts'), []);
}
let permissionState,
  changingPermissions = false;
const personName = (id) =>
  session.people.find((person) => person.id === id)?.name || id;
async function loadPermissions() {
  permissionState = await api('/api/permissions');
  const { links, audit } = permissionState;
  const occupied = new Set(links.map(({ person }) => person));
  optionList(
    permissionForm.elements.namedItem('person'),
    session.people
      .filter(({ id }) => !occupied.has(id))
      .map(({ id, name }) => [id, name]),
  );
  const list = $('permission-links');
  list.replaceChildren();
  if (!links.length) {
    const empty = document.createElement('li');
    empty.textContent = 'Nenhum vínculo cadastrado.';
    list.append(empty);
  }
  for (const link of links) {
    const row = document.createElement('li');
    const text = document.createElement('span');
    text.textContent = `${personName(link.person)} · ${link.discordId}`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Revogar';
    remove.setAttribute(
      'aria-label',
      'Revogar vínculo de ' + personName(link.person),
    );
    remove.addEventListener(
      'click',
      safe(async () => {
        if (
          !confirm(
            `Revogar o acesso de ${link.discordId} à biografia de ${personName(link.person)}?`,
          )
        )
          return;
        await changePermission({ action: 'revoke', ...link }, remove);
      }),
    );
    row.append(text, remove);
    list.append(row);
  }
  $('permission-audit').replaceChildren(
    ...audit.map((item) => {
      const row = document.createElement('li');
      const date = new Date(item.at).toLocaleString('pt-BR');
      row.textContent = `${date} · ${item.action === 'grant' ? 'Vinculado' : 'Revogado'}: ${personName(item.person)} · ${item.discordId} · por ${item.by}`;
      return row;
    }),
  );
}
async function changePermission(change, button) {
  if (changingPermissions || !permissionState) return;
  changingPermissions = true;
  if (button) button.disabled = true;
  try {
    await api('/api/permissions', {
      ...change,
      revision: permissionState.revision,
    });
    notice(
      change.action === 'grant' ? 'Vínculo concedido.' : 'Vínculo revogado.',
    );
    try {
      await loadPermissions();
    } catch {
      notice(
        'Alteração salva. Atualize a lista de permissões para conferi-la.',
      );
    }
  } finally {
    changingPermissions = false;
    if (button) button.disabled = false;
  }
}
async function chooseAuthor() {
  const author = $('authors').value;
  const data = author ? await api('/api/drafts/' + author) : { ids: [] };
  optionList(
    $('author-drafts'),
    data.ids.map((id) => [id, id]),
  );
}
function openDraft(draft) {
  current = draft;
  $('opened').hidden = false;
  const body = $('opened-body');
  drawBio(body, draft.bio);
  const details = document.createElement('p');
  const named = (id) =>
    session.people.find((person) => person.id === id)?.name || id;
  details.textContent =
    draft.type === 'bio'
      ? `${named(draft.person)} · ${statusText[draft.status]}`
      : `${draft.name} · ${draft.relation} de ${named(draft.relatedPerson)} · ${statusText[draft.status]}`;
  body.prepend(details);
  if (draft.review?.note) {
    const note = document.createElement('p');
    note.textContent = 'Nota: ' + draft.review.note;
    body.append(note);
  }
  reviewForm.reset();
  reviewForm.hidden = !(
    session.role === 'admin' &&
    self &&
    draft.author !== self &&
    draft.status === 'pending'
  );
}
async function loadDraft(author, id) {
  if (author && id) openDraft(await api(`/api/drafts/${author}/${id}`));
}
const safe =
  (run) =>
  (...args) => {
    Promise.resolve()
      .then(() => run(...args))
      .catch((error) => notice(error.message));
  };
$('add-section').addEventListener('click', () => section());
$('show-preview').addEventListener('click', () => {
  drawBio($('preview'), fields());
  $('preview').hidden = false;
});
field('type').addEventListener('change', () => changeType());
$('my-refresh').addEventListener('click', safe(mine));
$('review-refresh').addEventListener('click', safe(queue));
$('register-account').addEventListener(
  'click',
  safe(async () => {
    const result = await api('/api/account/register', {});
    const id = $('account-id');
    id.textContent = 'ID registrado: ' + result.discordId;
    id.hidden = false;
    notice(
      'Conta registrada. Informe este ID a um administrador por um canal privado.',
    );
  }),
);
$('permissions-refresh').addEventListener('click', safe(loadPermissions));
permissionForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const discordId = permissionForm.elements.namedItem('discordId').value;
  const person = permissionForm.elements.namedItem('person').value;
  void changePermission(
    { action: 'grant', discordId, person },
    event.submitter,
  ).catch((error) => notice(error.message));
});
$('authors').addEventListener('change', safe(chooseAuthor));
$('open-mine').addEventListener(
  'click',
  safe(() => loadDraft(self, $('mine').value)),
);
$('open-review').addEventListener(
  'click',
  safe(() => loadDraft($('authors').value, $('author-drafts').value)),
);
$('logout').addEventListener(
  'click',
  safe(async () => {
    await api('/api/logout', {});
    location.replace('/');
  }),
);
form.addEventListener('submit', (event) => {
  event.preventDefault();
  if (saving) return;
  saving = true;
  const button = event.submitter;
  const bio = fields();
  const payload =
    field('type').value === 'bio'
      ? { type: 'bio', person: session.own?.id, bio }
      : {
          type: 'person',
          name: field('personName').value,
          relatedPerson: field('relatedPerson').value,
          relation: field('relation').value,
          bio,
        };
  if (button) button.disabled = true;
  void api('/api/drafts', payload)
    .then((draft) => {
      self = draft.author;
      openDraft(draft);
      // A secondary read failure must not make an already recorded submit look unsaved.
      notice('Rascunho enviado para revisão privada.');
      void mine().catch(() => {});
    })
    .catch((error) => notice(error.message))
    .finally(() => {
      saving = false;
      if (button) button.disabled = false;
    });
});
reviewForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (saving || !current || !event.submitter) return;
  saving = true;
  const button = event.submitter;
  button.disabled = true;
  void api(`/api/drafts/${current.author}/${current.id}/review`, {
    decision: button.value,
    note: reviewForm.elements.namedItem('note').value,
  })
    .then((draft) => {
      openDraft(draft);
      notice('Revisão registrada. Nada foi publicado.');
    })
    .catch((error) => notice(error.message))
    .finally(() => {
      saving = false;
      button.disabled = false;
    });
});
await (async () => {
  try {
    session = await api('/api/session');
  } catch (error) {
    if (new URLSearchParams(location.search).get('login') === 'falhou')
      notice(
        'Não foi possível entrar. Confirme seu acesso no Discord e tente novamente.',
      );
    else if (error.message !== 'Entre com Discord.') notice(error.message);
    return;
  }
  $('sign-in').hidden = true;
  $('desk').hidden = false;
  $('identity').textContent = `Área editorial · ${roleText[session.role]}`;
  if (!session.own) {
    field('type').value = 'person';
    field('type').querySelector('[value=bio]').disabled = true;
  }
  optionList(
    field('relatedPerson'),
    session.people.map((person) => [person.id, person.name]),
  );
  const initial = session.own?.bio;
  field('summary').value = initial?.summary ?? '';
  (initial?.sections ?? [{}]).forEach(section);
  changeType();
  try {
    await mine();
  } catch (error) {
    notice(error.message);
  }
  if (session.role === 'admin') {
    $('review').hidden = false;
    $('permissions').hidden = false;
    const results = await Promise.allSettled([queue(), loadPermissions()]);
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) notice(failed.reason.message);
  }
})();
