# NutriZap — bot de nutrição no WhatsApp (via API oficial da Meta)

(Nome interno do projeto/repositório continua "ZapFit" — só o nome que
aparece pro usuário no WhatsApp é "NutriZap". Não precisa renomear o
repositório, domínio, etc.)

## O que o bot faz hoje

1. Na primeira mensagem de um número novo, faz uma entrevista curta
   (objetivo, peso, altura, idade, sexo, nível de atividade) e calcula
   uma meta diária de calorias/macros.
2. Se o usuário já tiver uma dieta pronta, ele manda foto dela e a IA
   extrai as metas de lá, em vez de calcular do zero.
3. Depois disso, cada foto/texto de refeição mandado é analisado e
   comparado com a meta do dia.
4. Mensagens de "papo comum" (saudação, pergunta, agradecimento) são
   respondidas naturalmente, sem tentar analisar como se fosse comida.
5. Comandos: `/hoje` (resumo do dia), `/perfil` (ver metas),
   `/perfil refazer` (refazer a entrevista), `/nome` (trocar como o bot
   te chama), `/ajuda`.

## Como atualizar o bot

Só é preciso repetir esses passos quando eu mandar um `bot.js` novo:

1. No GitHub, abre o repositório `ZAPFIT-MVP`, edita o arquivo
   `bot.js` e substitui TODO o conteúdo pelo novo.
2. Confirma (Commit changes).
3. Espera 1-2 minutos o Railway fazer o deploy sozinho.
4. **Confirma que o deploy pegou o código novo antes de testar**:
   vai em **Deploy Logs** do serviço do bot no Railway e confere se
   aparece a linha:
   ```
   🔗 META_PHONE_NUMBER_ID configurado como: "..."
   ```
   Se essa linha não aparecer, o deploy ainda não terminou (ou
   pegou uma versão antiga) — espera mais um pouco e recarrega a
   página de logs.
5. Só depois disso, testa mandando "oi" pro número do WhatsApp.

## Variáveis de ambiente necessárias (Railway → Variables do serviço do bot)

| Nome | Valor |
|---|---|
| `OPENAI_API_KEY` | sua chave da OpenAI (platform.openai.com) |
| `META_ACCESS_TOKEN` | token de acesso gerado no Facebook Developers (permanente pra produção) |
| `META_PHONE_NUMBER_ID` | o "Phone Number ID" (não é o número de telefone) |
| `META_VERIFY_TOKEN` | uma senha que você mesmo inventa (usada só na configuração do webhook) |
| `DATABASE_URL` | string de conexão do Postgres (veja abaixo como pegar) |

## Como configurar o webhook do lado da Meta

Diferente da Evolution API, aqui o webhook é configurado direto no painel
do Facebook Developers, não no bot:

1. developers.facebook.com → Meus Apps → seu app → WhatsApp → Configuração
2. Na seção Webhook, coloca a URL: `https://SEU-DOMINIO-DO-BOT/webhook`
3. No campo "Verificar token", coloca o MESMO valor que você usou na
   variável `META_VERIFY_TOKEN` no Railway
4. Clica em Verificar - se o bot estiver no ar com a variável certa, a
   verificação passa sozinha (o bot responde automaticamente a esse
   pedido de verificação)
5. Marca o campo de eventos (webhook fields) `messages` como inscrito

## Como pegar o DATABASE_URL

O Postgres está rodando num projeto separado no Railway (aquele que também
tem a antiga Evolution API/Redis, que não são mais usados pra mensagens,
mas o Postgres continua ativo). Se estiver no mesmo projeto do bot, use uma
"Variable Reference" (`${{Postgres.DATABASE_URL}}`); se for projeto
diferente, copia o valor manualmente:

1. Vai no serviço **Postgres** no Railway
2. Aba **Variables**
3. Procura por `DATABASE_URL` (ou `DATABASE_PUBLIC_URL` se a primeira não
   conectar) e copia o valor inteiro
4. Volta pro projeto do bot, aba **Variables**, e cola esse valor numa
   variável nova chamada `DATABASE_URL`

## Sobre os dados salvos

Os dados ficam no Postgres, não somem mais a cada deploy. Na primeira vez
que o bot subir com o `DATABASE_URL` configurado, ele cria sozinho a
tabela `usuarios` no banco (não precisa fazer nada manual).
