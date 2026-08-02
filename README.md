# ZapFit v2 — agora com Evolution API

Essa versão não usa mais o `whatsapp-web.js` (aquele que dava problema pra
gerar QR Code). Agora o WhatsApp já é conectado direto na Evolution API,
e esse bot só conversa com ela.

## Passo a passo

### 1. Trocar os arquivos no GitHub

No seu repositório `ZAPFIT-MVP`, substitua o conteúdo de cada um desses
arquivos pelo novo (mesmo nome, mesmo lugar):

- `bot.js`
- `package.json`
- `Dockerfile`
- `.env.example`
- `README.md` (esse aqui)

### 2. Configurar as variáveis no Railway

No serviço do **bot** (o `ZAPFIT-MVP`, não o serviço "Evolution API"),
vá em **Variables** e adicione:

| Nome | Valor |
|---|---|
| `ANTHROPIC_API_KEY` | sua chave da Anthropic (a mesma de antes) |
| `EVOLUTION_API_URL` | a URL pública do serviço Evolution API, ex: `https://evolution-api-production-5e8b.up.railway.app` |
| `EVOLUTION_API_KEY` | a `AUTHENTICATION_API_KEY` que você usou pra entrar no `/manager` |
| `EVOLUTION_INSTANCE` | `ZAPFIT` (o nome da instância que você criou) |

### 3. Pegar a URL pública do bot

Depois que o bot fizer o deploy, vá em **Settings** do serviço do bot e
pegue o domínio público dele (parecido com
`zapfit-mvp-production-xxxx.up.railway.app`).

### 4. Configurar o webhook na Evolution API

Isso é o passo mais importante: é o que faz a Evolution API avisar o bot
quando chega mensagem nova.

1. Abre o `/manager` da Evolution API de novo
2. Entra na instância `ZAPFIT`
3. Vai em **Configurações** (ou **Eventos**, dependendo da versão)
4. Procura por **Webhook**
5. Ativa o webhook e cola essa URL:
   ```
   https://SEU-DOMINIO-DO-BOT.up.railway.app/webhook
   ```
   (troca pelo domínio que você pegou no passo 3, e não esquece de
   colocar `/webhook` no final)
6. Marca a opção **Base64** como ativada (isso é essencial pra receber
   fotos)
7. Nos eventos, marca pelo menos **MESSAGES_UPSERT**
8. Salva

### 5. Testar

Manda uma mensagem de texto ou uma foto de comida pro número da Vivo que
você conectou. O bot deve responder em alguns segundos com a análise.

## Comandos disponíveis

- Manda foto ou texto de uma refeição → recebe a análise de calorias e macros
- `/hoje` → resumo do que você comeu no dia
