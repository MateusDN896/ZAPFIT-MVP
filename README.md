# ZapFit — Protótipo (MVP grátis)

Bot de WhatsApp que analisa fotos/textos de refeições e devolve calorias e macros,
usando a API da Anthropic (Claude). Conecta via QR Code (como o WhatsApp Web),
sem precisar da API oficial da Meta — ideal para testar a ideia primeiro.

## O que você precisa antes de começar

1. **Node.js instalado** no seu computador (versão 18 ou mais nova).
   - Baixe em: https://nodejs.org (escolha a versão "LTS")
   - Para checar se já tem instalado, abra o terminal e digite: `node --version`

2. **Uma chave de API da Anthropic** (para o Claude analisar as fotos).
   - Crie uma conta em: https://console.anthropic.com
   - Vá em "API Keys" e crie uma nova chave
   - Adicione créditos na conta (uns R$ 20-30 já dão pra testar bastante)

3. **Um número de WhatsApp para o bot** (pode ser um chip novo/reserva, ou seu
   número pessoal se você só quiser testar sozinho).

## Passo a passo

### 1. Baixe os arquivos e abra o terminal na pasta do projeto

### 2. Instale as dependências
```
npm install
```
Isso baixa as bibliotecas que o projeto precisa (pode demorar 1-2 minutos).

### 3. Configure sua chave de API
Copie o arquivo `.env.example` e renomeie a cópia para `.env`. Abra o `.env`
e coloque sua chave real:
```
ANTHROPIC_API_KEY=sk-ant-sua-chave-aqui
```

### 4. Rode o bot
```
npm start
```

### 5. Escaneie o QR Code
Vai aparecer um QR Code no terminal. No celular que vai virar o ZapFit:
- Abra o WhatsApp → Configurações → Aparelhos conectados → Conectar um aparelho
- Escaneie o QR Code que apareceu no terminal

Pronto! Agora é só mandar uma mensagem para esse número (de outro celular/número)
com uma foto de comida ou um texto descrevendo a refeição.

## Comandos disponíveis
- Mandar **foto** de uma refeição → recebe a análise
- Mandar **texto** descrevendo o que comeu → recebe a análise
- `/hoje` → resumo de tudo que foi registrado no dia
- `/ajuda` → mensagem de boas-vindas

## Limitações desta versão (é um protótipo!)
- Não entende áudio ainda (fica pra próxima versão — precisa de um passo extra
  de transcrição)
- Histórico é salvo num arquivo simples (`historico.json`) — bom pra testar,
  mas não serve pra produção de verdade
- Só funciona em conversas individuais, ignora grupos
- Usando biblioteca não-oficial — não use em grande volume nem deixe isso
  como versão final do produto (risco de bloqueio pelo WhatsApp)

## Trocar o modelo de IA (economizar mais)
No arquivo `bot.js`, procure por `claude-sonnet-4-6` e troque para
`claude-haiku-4-5` se quiser um modelo mais barato (um pouco menos preciso,
mas ainda bom para esse tipo de tarefa).

## Rodando 24h sem depender do seu computador (Railway)

Se você não quer deixar o Mac ligado o tempo todo, dá pra colocar o bot
num servidor bem barato que fica sempre ligado, chamado **Railway**
(https://railway.app). É um serviço "no site mesmo", sem terminal.

### 1. Coloque o código no GitHub
- Crie uma conta grátis em https://github.com (se ainda não tiver)
- Crie um repositório novo (pode ser privado) e suba todos os arquivos
  desta pasta (pode arrastar e soltar direto no site do GitHub, em
  "Add file" → "Upload files")

### 2. Crie uma conta no Railway
- Vá em https://railway.app e crie uma conta (dá pra entrar com o GitHub)
- Clique em "New Project" → "Deploy from GitHub repo" → escolha o
  repositório que você acabou de criar
- O Railway vai detectar o `Dockerfile` sozinho e começar a "buildar"

### 3. Configure a chave de API
- No painel do projeto, vá em "Variables"
- Adicione: `ANTHROPIC_API_KEY` = sua chave (a mesma do `.env`)

### 4. Escaneie o QR Code pelos logs
- Vá na aba "Deployments" → clique no deploy ativo → "View Logs"
- O QR Code vai aparecer ali em texto (ASCII). Escaneie com o WhatsApp
  do número que vai virar o bot (Configurações → Aparelhos conectados)

### 5. Pronto
O bot agora fica rodando 24h no servidor da Railway, sem depender do
seu computador estar ligado.

### Sobre custo
Railway tem um plano de teste com um valor pequeno de créditos grátis
por mês, e depois cobra por uso (geralmente uns R$ 25-50/mês para um
bot rodando o tempo todo, dependendo do uso). Se preferir, Render.com
funciona de forma parecida e também tem opções de baixo custo.

### Atenção com a sessão salva
Por padrão, se o servidor reiniciar, a sessão do WhatsApp (`.wwebjs_auth`)
pode se perder e você precisa escanear o QR Code de novo. Se isso
acontecer com frequência e incomodar, me avisa que eu te ajudo a
configurar um "volume" (armazenamento permanente) no Railway pra
guardar essa sessão.

## Próximos passos (quando validar a ideia)
1. Migrar para a API oficial da Meta (WhatsApp Cloud API)
2. Trocar o `historico.json` por um banco de dados de verdade (Postgres/Supabase)
3. Adicionar suporte a áudio (transcrição)
4. Hospedar num servidor (Railway, Render, etc.) para ficar 24h no ar
