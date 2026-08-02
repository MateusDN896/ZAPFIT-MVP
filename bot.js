/**
 * ZapFit - Protótipo (MVP)
 * ------------------------
 * Bot de WhatsApp que recebe foto ou texto de uma refeição e devolve
 * uma estimativa de calorias e macros usando a API da Anthropic (Claude).
 *
 * Este é um protótipo GRATUITO usando whatsapp-web.js (conexão via QR Code,
 * igual ao WhatsApp Web). Serve para TESTAR a ideia antes de migrar para
 * a API oficial da Meta.
 *
 * IMPORTANTE: use um número separado do seu WhatsApp pessoal para testar,
 * se possível, para reduzir risco de bloqueio.
 */

require('dotenv').config();
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

// ---------- Configuração ----------

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('\n❌ Faltando ANTHROPIC_API_KEY no arquivo .env. Veja o README.md.\n');
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Onde vamos guardar o histórico de cada usuário (arquivo simples em JSON,
// só para o protótipo -- num produto de verdade isso vira um banco de dados)
const DATA_FILE = path.join(__dirname, 'historico.json');
function carregarHistorico() {
  if (!fs.existsSync(DATA_FILE)) return {};
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
}
function salvarHistorico(historico) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(historico, null, 2));
}

// ---------- Prompt que instrui o Claude a analisar a refeição ----------

const SYSTEM_PROMPT = `Você é o ZapFit, um assistente nutricional que analisa refeições descritas
por foto ou texto e estima valores nutricionais.

Responda SEMPRE em formato JSON puro, sem markdown, sem texto antes ou depois, seguindo
exatamente este formato:

{
  "alimentos": [{"nome": "string", "porcao_estimada": "string"}],
  "calorias_kcal": number,
  "proteina_g": number,
  "carboidrato_g": number,
  "gordura_g": number,
  "confianca": "alta" | "media" | "baixa",
  "observacao": "string curta, opcional, ex: porção estimada visualmente"
}

Se não conseguir identificar comida na imagem/texto, responda com "confianca": "baixa"
e uma observação explicando o motivo, mas ainda assim tente estimar.`;

// ---------- Função que chama o Claude para analisar a refeição ----------

async function analisarRefeicao({ texto, imagemBase64, mimeType }) {
  const content = [];

  if (imagemBase64) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: mimeType, data: imagemBase64 },
    });
  }

  content.push({
    type: 'text',
    text: texto
      ? `O usuário descreveu a refeição assim: "${texto}". Analise e retorne o JSON.`
      : 'Analise a refeição na imagem e retorne o JSON.',
  });

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6', // pode trocar para 'claude-haiku-4-5' para economizar
    max_tokens: 500,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content }],
  });

  const textoResposta = response.content.find((b) => b.type === 'text')?.text || '{}';

  try {
    return JSON.parse(textoResposta);
  } catch (e) {
    console.error('Não consegui interpretar a resposta do Claude:', textoResposta);
    return null;
  }
}

// ---------- Formatar a resposta que o usuário vai receber no WhatsApp ----------

function formatarResposta(analise) {
  if (!analise) {
    return '⚠️ Não consegui analisar essa refeição. Pode tentar descrever em texto ou mandar outra foto?';
  }

  const alimentos = analise.alimentos?.map((a) => `• ${a.nome} (${a.porcao_estimada})`).join('\n') || '';

  return (
    `🍽️ *Análise da refeição*\n\n${alimentos}\n\n` +
    `🔥 Calorias: *${analise.calorias_kcal} kcal*\n` +
    `🥩 Proteína: ${analise.proteina_g}g\n` +
    `🍞 Carboidrato: ${analise.carboidrato_g}g\n` +
    `🥑 Gordura: ${analise.gordura_g}g\n\n` +
    (analise.observacao ? `_${analise.observacao}_\n\n` : '') +
    `Confiança da estimativa: ${analise.confianca}`
  );
}

// ---------- Comando /hoje: resumo do dia ----------

function resumoDoDia(historicoUsuario) {
  const hoje = new Date().toISOString().slice(0, 10);
  const registrosHoje = (historicoUsuario || []).filter((r) => r.data.startsWith(hoje));

  if (registrosHoje.length === 0) {
    return 'Você ainda não registrou nenhuma refeição hoje. Manda uma foto ou descreve o que comeu! 📸';
  }

  const totais = registrosHoje.reduce(
    (acc, r) => ({
      calorias: acc.calorias + (r.analise.calorias_kcal || 0),
      proteina: acc.proteina + (r.analise.proteina_g || 0),
      carboidrato: acc.carboidrato + (r.analise.carboidrato_g || 0),
      gordura: acc.gordura + (r.analise.gordura_g || 0),
    }),
    { calorias: 0, proteina: 0, carboidrato: 0, gordura: 0 }
  );

  return (
    `📊 *Resumo de hoje* (${registrosHoje.length} refeições)\n\n` +
    `🔥 Total: *${totais.calorias} kcal*\n` +
    `🥩 Proteína: ${totais.proteina}g\n` +
    `🍞 Carboidrato: ${totais.carboidrato}g\n` +
    `🥑 Gordura: ${totais.gordura}g`
  );
}

// ---------- Inicializar o cliente do WhatsApp ----------

const client = new Client({
  authStrategy: new LocalAuth(), // salva a sessão localmente, não precisa escanear QR toda vez
  puppeteer: {
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    // Em servidores (Railway/Render), usamos o Chromium já instalado no Dockerfile.
    // No seu computador local, deixa em branco que ele baixa/usa o padrão.
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  },
});

client.on('qr', (qr) => {
  console.log('\n📱 Escaneie este QR Code com o WhatsApp do número que vai virar o ZapFit:\n');
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  console.log('\n✅ ZapFit conectado e pronto para receber mensagens!\n');
});

client.on('message', async (message) => {
  // Ignora mensagens de grupos no protótipo (foco em conversa 1:1 por enquanto)
  const chat = await message.getChat();
  if (chat.isGroup) return;

  const historico = carregarHistorico();
  const userId = message.from;
  if (!historico[userId]) historico[userId] = [];

  // Comando de resumo
  if (message.body.trim().toLowerCase() === '/hoje') {
    await message.reply(resumoDoDia(historico[userId]));
    return;
  }

  if (message.body.trim().toLowerCase() === '/ajuda' || message.body.trim() === '') {
    if (!message.hasMedia) {
      await message.reply(
        '👋 Oi! Eu sou o *ZapFit*.\n\nMe manda uma *foto* ou *descreva em texto* o que você comeu, ' +
          'que eu calculo as calorias e macros pra você.\n\nComandos:\n/hoje - resumo do dia'
      );
      return;
    }
  }

  let imagemBase64 = null;
  let mimeType = null;

  if (message.hasMedia) {
    const media = await message.downloadMedia();
    if (media && media.mimetype.startsWith('image/')) {
      imagemBase64 = media.data;
      mimeType = media.mimetype;
    } else {
      // Áudio, vídeo, etc. Transcrição de áudio fica para uma próxima versão.
      await message.reply(
        '🎤 Por enquanto eu ainda não entendo áudio nessa versão de teste — pode descrever em texto ' +
          'ou mandar uma foto da refeição?'
      );
      return;
    }
  } else if (!message.body || message.body.trim() === '') {
    return; // nada pra analisar
  }

  await chat.sendStateTyping();

  const analise = await analisarRefeicao({
    texto: message.body,
    imagemBase64,
    mimeType,
  });

  if (analise) {
    historico[userId].push({
      data: new Date().toISOString(),
      analise,
    });
    salvarHistorico(historico);
  }

  await message.reply(formatarResposta(analise));
});

client.initialize();
