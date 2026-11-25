import { fail, slug, snowflake, uuid } from './security.mjs';

const roles = new Set(['familiar', 'amigo', 'companheiro', 'outro']);
const shape = (value, keys) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const line = (input, max, multiple = false) => {
  if (typeof input !== 'string') fail(400, 'Preencha os campos de texto.');
  const value = input.normalize('NFC').trim();
  if (
    !value ||
    value.length > max ||
    /[<>\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(
      value,
    ) ||
    (!multiple && /[\r\n\t]/u.test(value))
  )
    fail(400, 'Use texto simples dentro dos limites, sem HTML.');
  return value;
};
export function biography(value) {
  if (
    !shape(value, ['summary', 'sections']) ||
    !Array.isArray(value.sections) ||
    value.sections.length < 1 ||
    value.sections.length > 6
  )
    fail(400, 'Informe um resumo e de uma a seis seções.');
  return {
    summary: line(value.summary, 450, true),
    sections: value.sections.map((section) => {
      if (!shape(section, ['heading', 'content'])) fail(400, 'Seção inválida.');
      return {
        heading: line(section.heading, 90),
        content: line(section.content, 1400, true),
      };
    }),
  };
}
export function registry(value) {
  try {
    if (
      !shape(value, ['version', 'people', 'owners']) ||
      value.version !== 1 ||
      !Array.isArray(value.people) ||
      value.people.length < 1 ||
      value.people.length > 200 ||
      !value.owners ||
      typeof value.owners !== 'object' ||
      Array.isArray(value.owners)
    )
      throw Error();
    const people = new Map(
      value.people.map((person) => {
        if (
          !(
            shape(person, ['id', 'name']) ||
            shape(person, ['id', 'name', 'bio'])
          ) ||
          !slug(person.id)
        )
          throw Error();
        return [
          person.id,
          {
            id: person.id,
            name: line(person.name, 100),
            ...(person.bio ? { bio: biography(person.bio) } : {}),
          },
        ];
      }),
    );
    const owners = new Map(Object.entries(value.owners));
    if (
      people.size !== value.people.length ||
      owners.size > people.size ||
      new Set(owners.values()).size !== owners.size ||
      [...owners].some(([id, person]) => !snowflake(id) || !people.has(person))
    )
      throw Error();
    return { people, owners };
  } catch {
    fail(503, 'Registro editorial indisponível.');
  }
}
export function proposal(value, author, catalog, now) {
  const base = {
    version: 1,
    id: crypto.randomUUID(),
    author,
    createdAt: new Date(now).toISOString(),
    status: 'pending',
  };
  if (value?.type === 'bio' && shape(value, ['type', 'person', 'bio'])) {
    if (
      !catalog.people.has(value.person) ||
      catalog.owners.get(author) !== value.person
    )
      fail(403, 'Só é possível editar a sua própria biografia vinculada.');
    return {
      ...base,
      type: 'bio',
      person: value.person,
      bio: biography(value.bio),
    };
  }
  if (
    value?.type === 'person' &&
    shape(value, ['type', 'name', 'relatedPerson', 'relation', 'bio'])
  ) {
    if (!catalog.people.has(value.relatedPerson) || !roles.has(value.relation))
      fail(
        400,
        'Vincule a proposta a uma pessoa cadastrada com um papel válido.',
      );
    const name = line(value.name, 100);
    if (
      [...catalog.people.values()].some(
        (person) =>
          person.name.toLocaleLowerCase('pt-BR') ===
          name.toLocaleLowerCase('pt-BR'),
      )
    )
      fail(409, 'Essa pessoa já consta do registro.');
    return {
      ...base,
      type: 'person',
      name,
      relatedPerson: value.relatedPerson,
      relation: value.relation,
      bio: biography(value.bio),
    };
  }
  fail(400, 'Proposta inválida ou contém campos não permitidos.');
}
export function review(value, draft, reviewer, now) {
  if (
    !shape(value, ['decision', 'note']) ||
    !['accepted', 'rejected'].includes(value.decision)
  )
    fail(400, 'Decisão inválida.');
  if (draft.status !== 'pending') fail(409, 'Rascunho já revisado.');
  if (draft.author === reviewer)
    fail(403, 'Peça a outro administrador para revisar o próprio rascunho.');
  return {
    ...draft,
    status: value.decision,
    review: {
      reviewer,
      at: new Date(now).toISOString(),
      note: value.note === '' ? '' : line(value.note, 500, true),
    },
  };
}
export function ensureDraft(value, author, id) {
  try {
    if (
      !uuid(id) ||
      value?.version !== 1 ||
      value?.id !== id ||
      value?.author !== author ||
      !['pending', 'accepted', 'rejected'].includes(value?.status) ||
      typeof value?.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(value.createdAt)) ||
      !['bio', 'person'].includes(value?.type)
    )
      throw Error();
    const base = [
      'version',
      'id',
      'author',
      'createdAt',
      'status',
      'type',
      'bio',
    ];
    if (value.status !== 'pending') {
      base.push('review');
      if (
        !shape(value.review, ['reviewer', 'at', 'note']) ||
        !snowflake(value.review.reviewer) ||
        value.review.reviewer === author ||
        typeof value.review.at !== 'string' ||
        !Number.isFinite(Date.parse(value.review.at))
      )
        throw Error();
      if (value.review.note !== '') line(value.review.note, 500, true);
    }
    biography(value.bio);
    if (value.type === 'bio') {
      if (!shape(value, [...base, 'person']) || !slug(value.person))
        throw Error();
    } else {
      if (
        !shape(value, [...base, 'name', 'relatedPerson', 'relation']) ||
        !slug(value.relatedPerson) ||
        !roles.has(value.relation)
      )
        throw Error();
      line(value.name, 100);
    }
    return value;
  } catch {
    fail(503, 'Rascunho inconsistente.');
  }
}
export function verifyDraftLink(draft, catalog) {
  if (draft.type === 'bio' && catalog.owners.get(draft.author) === draft.person)
    return;
  if (
    draft.type === 'person' &&
    catalog.people.has(draft.relatedPerson) &&
    ![...catalog.people.values()].some(
      (person) =>
        person.name.toLocaleLowerCase('pt-BR') ===
        draft.name.toLocaleLowerCase('pt-BR'),
    )
  )
    return;
  fail(
    409,
    'O vínculo mudou desde o envio. Revise o registro antes de aceitar.',
  );
}
