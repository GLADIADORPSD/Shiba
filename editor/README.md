# Oficina editorial Shiba

Painel separado do site público. Cada pessoa edita a **proposta** da própria biografia e pode propor um novo integrante ligado a alguém da árvore. Um administrador diferente do autor registra a decisão. Aceitar um rascunho não publica nem altera o site: o mantenedor copia apenas as mudanças aprovadas para um PR do site público, preservando árvore, retratos, álbuns, links e vídeo. Não inclua IDs Discord, notas ou JSON privados no PR público.

### Revisar agora, sem conta e sem custo

Node.js 22+:

```sh
npm --prefix editor test
npm --prefix editor run preview
```

Abra `http://127.0.0.1:4242`. Na prévia, **Entrar com Discord** leva a um editor sintético; o link no banner permite revisar como um segundo usuário sintético. O Worker, a validação de campos e as telas são os mesmos; Discord e GitHub são simulados em memória. Reiniciar apaga a demonstração. O adaptador escuta apenas na máquina local e fica em `test/`; o deploy só usa `src/` e `public/`. O login/autorização de teste não existe no Worker.

O [formato versionado do rascunho](examples/draft.schema.json) usa texto simples. O servidor também valida autoria, papéis e vínculos contra o registro privado.

### Conceder ou remover acesso sem mexer no código

1. A pessoa precisa ter o papel editor ou administrador no servidor Discord. No painel, entra e clica **Registrar minha conta**. O servidor verifica a identidade e registra somente o ID Discord e a data no repositório privado. Ela pode informar o ID recebido ao administrador por canal privado.
2. Em **Permissões de biografia**, o administrador informa o ID exato, escolhe uma pessoa já cadastrada e confirma o vínculo. Qualquer conta ou pessoa já vinculada precisa ser desvinculada primeiro. Nunca use nomes de exibição como identificação.
3. Para retirar o acesso à biografia, o administrador usa **Revogar** ao lado do vínculo e confirma. A revogação vale no próximo envio dessa conta, sem esperar o cookie expirar; uma proposta de biografia pendente com vínculo removido não pode ser aceita. O papel Discord é independente: remova também o papel no servidor para bloquear todo o painel.
4. Cada concessão ou revogação grava o evento de auditoria privado (quem, conta, pessoa, horário e operação) junto do vínculo, protegidos pelo mesmo SHA do GitHub. Em caso de alteração concorrente, atualize a lista; nada é gravado parcialmente. Apenas administradores veem vínculos e auditoria; o painel mostra os 20 recentes, o arquivo retém os 100 recentes e o histórico do Git guarda as revisões anteriores. Manutenção de cadastro da árvore continua separada; o painel só vincula pessoas já cadastradas.

### Configuração pelo dono, após revisar o PR

1. **Cloudflare:** confirme que a conta está no [Workers Free](https://developers.cloudflare.com/workers/platform/pricing/), sem habilitar Workers Paid. Use o subdomínio HTTPS gratuito `workers.dev`; não compre domínio. Não são necessários banco, KV, R2, inteligência artificial nem webhook. O limite do plano gratuito continua valendo; indisponibilidade não vira upgrade. Não use GitHub Pages para a parte privada.
2. **Discord:** cadastre uma aplicação OAuth2 confidencial no [Developer Portal](https://discord.com/developers/applications) e uma URL exata de callback: `https://<subdomínio-do-editor>/oauth/callback`. No servidor da família crie ou escolha dois papéis diferentes, editor e administrador, e anote os IDs do servidor, dos papéis e dos usuários no modo desenvolvedor. Nunca use `@everyone`. Escolha administradores de confiança para que um possa revisar a contribuição do outro. O login usa somente `identify` e `guilds.members.read`; sem bot, senha no painel, e-mail ou leitura de mensagens.
3. **GitHub:** crie um [repositório privado](https://docs.github.com/en/get-started/learning-about-github/githubs-plans), dedicado, sem fork, sem Pages, sem workflows e sem colaboradores que não devam ver os rascunhos. Copie `examples/registry.example.json` para `config/registry.json` **nesse repositório privado**, usando os IDs da árvore já presentes no exemplo. Mantenha `owners` vazio no começo e use **Permissões de biografia** para conceder acesso após a configuração. Opcionalmente, em cada objeto `people`, acrescente `bio: { "summary": "...", "sections": [{ "heading": "...", "content": "..." }] }` com a versão editorial de partida. A lista pública não contém esses vínculos de Discord. Somente o cadastro de pessoas e as biografias de partida são mantidos manualmente no registro.
4. **GitHub App:** registre um app privado, sem webhook, com permissões de repositório **Contents: Read & write** e **Metadata: Read** (obrigatória). Sem Pull requests, Actions, administração ou autorização de usuário. Instale usando **Only select repositories**, selecione somente o repositório privado e confirme seu ID. **Não** instale no Shiba público. Gere e mantenha a chave fora da pasta do projeto; se ela vier em PKCS#1, converta-a localmente para PKCS#8:
   `openssl pkcs8 -topk8 -nocrypt -in arquivo-app.pem -out chave-editor-pkcs8.pem`.
5. **Worker:** configure os bindings abaixo no Dashboard/secret manager, sem colar chaves no chat, em issue, em Git ou no navegador do painel. Em `editor/`, faça `npx wrangler deploy --dry-run` e, só depois da revisão, do aceite do dono e da configuração, o deploy. Para gerar `SESSION_KEY` localmente, use `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"` em terminal privado e grave o valor diretamente como secret.
6. **Teste com contas reais autorizadas** em um arquivo privado inicial de teste: primeiro confirmar editor, depois administrador distinto, registro privado de ID, conceder e retirar o vínculo pelo painel, além de ausência de papel e revogação após login. Confirme o S256 com a aplicação real (`DISCORD_PKCE_MODE=required`). A documentação do fluxo HTTP de aplicação confidencial do Discord não documenta S256: **se e somente se o provedor rejeitar de forma comprovada, escolha explicitamente** `unavailable`. Não há fallback automático: nessa configuração continuam obrigatórios state imprevisível, cookie seguro e client secret usado só no servidor. Ao publicar o painel, compartilhe o link diretamente com os editores; nenhum link foi inserido no GitHub Pages.

| Tipo     | Binding                                       | Valor                                                                |
| -------- | --------------------------------------------- | -------------------------------------------------------------------- |
| Variável | APP_ORIGIN                                    | Origem HTTPS exata, sem barra final                                  |
| Variável | DISCORD_CLIENT_ID, DISCORD_GUILD_ID           | IDs Discord da aplicação e servidor                                  |
| Variável | DISCORD_EDITOR_ROLE_ID, DISCORD_ADMIN_ROLE_ID | IDs dos dois papéis exclusivos                                       |
| Variável | DISCORD_PKCE_MODE                             | `required` normalmente; `unavailable` somente após verificação acima |
| Variável | GITHUB_APP_ID, GITHUB_INSTALLATION_ID         | IDs do App e sua instalação selecionada                              |
| Variável | DRAFT_REPOSITORY, DRAFT_REPOSITORY_ID         | `dono/repositorio` e ID numérico do repositório privado              |
| Secret   | DISCORD_CLIENT_SECRET                         | Segredo do aplicativo OAuth2                                         |
| Secret   | SESSION_KEY                                   | 32 bytes aleatórios como base64url sem padding                       |
| Secret   | GITHUB_PRIVATE_KEY                            | PEM completo em PKCS#8                                               |

**Limites e operação.** Sessão de até dez minutos, cookie cifrado HttpOnly, Secure, SameSite=Lax, sem refresh token. A remoção do papel corta acesso mesmo antes do vencimento. Logout remove o cookie deste navegador; para invalidar todas as sessões, rotacione `SESSION_KEY`. Se o GitHub estiver fora, não há gravação parcial garantida nem retry automático: consulte “Meus rascunhos” antes de reenviar. A revisão usa o SHA da versão privada para não sobrescrever outra decisão. Nunca mude a visibilidade do repositório privado: embora a API recuse acessar um repositório público, alterar a visibilidade no próprio GitHub pode tornar seu histórico legível. Só mantenedores do arquivo privado devem acessá-lo; a revisão não replica dados para GitHub Pages. Sem edição visual irrestrita, uploads ou publicação automática neste MVP.
