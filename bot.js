/**
 * ZapFit v2 - usando Evolution API
 * ---------------------------------
 * Esse bot NÃO usa mais whatsapp-web.js. Em vez disso, ele:
 *
 * 1. Sobe um servidor web (Express) que fica esperando a Evolution API
 *    avisar quando chega uma mensagem nova (isso se chama "webhook").
 * 2. Quando chega uma mensagem, ele manda pro Claude analisar.
 * 3. Ele responde de volta pro usuário chamando a Evolution API.
 *
 * A conexão com o WhatsApp em si (QR Code, sessão, etc) já foi feita
 * direto no painel da Evolution API (aquele /manager que você já usou).
 * Esse bot só precisa SABER conversar com a Evolution API - não precisa
 * mais gerar QR Code nenhum.
 */

require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

// ---------- Configuração ----------

const REQUIRED_ENV = [
  'ANTHROPIC_API_KEY',
  'EVOLUTION_API_URL',
  'EVOLUTION_API_KEY',
  'EVOLUTION_INSTANCE',
];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`\n❌ Faltando ${key} no arquivo .env (ou nas variáveis do Railway). Veja o README.md.\n`);
    process.exit(1);
  }
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// .trim() remove espaços/quebras de linha escondidas que às vezes entram
// quando a variável é colada no Railway - isso evita erros estranhos de
// "Application not found".
const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL.trim().replace(/\/+$/, ''); // remove barra(s) no final, se tiver
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY.trim();
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE.trim();

console.log(`🔗 EVOLUTION_API_URL configurada como: "${EVOLUTION_API_URL}"`);
console.log(`🔗 EVOLUTION_INSTANCE configurada como: "${EVOLUTION_INSTANCE}"`);

const app = express();
app.use(express.json({ limit: '20mb' })); // limite maior por causa das fotos em base64

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

async function analisarRefeicao({ texto, imagemBase64, mimeType }) {
  const content = [];

  if (imagemBase64) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: mimeType || 'image/jpeg', data: imagemBase64 },
    });
  }

  content.push({
    type: 'text',
    text: texto
      ? `O usuário descreveu a refeição assim: "${texto}". Analise e retorne o JSON.`
      : 'Analise a refeição na imagem e retorne o JSON.',
  });

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 500,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content }],
  });

  let textoResposta = response.content.find((b) => b.type === 'text')?.text || '{}';

  // Às vezes o Claude devolve o JSON dentro de um bloco de código markdown
  // (```json ... ```), então removemos isso antes de tentar interpretar.
  textoResposta = textoResposta
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();

  try {
    return JSON.parse(textoResposta);
  } catch (e) {
    console.error('Não consegui interpretar a resposta do Claude:', textoResposta);
    return null;
  }
}

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

// ---------- Funções que chamam a Evolution API ----------

async function enviarTexto(numero, texto) {
  const url = `${EVOLUTION_API_URL}/message/sendText/${EVOLUTION_INSTANCE}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: EVOLUTION_API_KEY,
    },
    body: JSON.stringify({
      number: numero,
      text: texto,
    }),
  });

  if (!resp.ok) {
    const erro = await resp.text();
    console.error('Erro ao enviar mensagem pela Evolution API:', resp.status, erro);
  }
}

// ---------- Rota que recebe os eventos da Evolution API (webhook) ----------

app.post('/webhook', async (req, res) => {
  // Responde rápido pra Evolution API não ficar esperando
  res.sendStatus(200);

  try {
    const body = req.body;
    const evento = body.event;

    if (evento !== 'messages.upsert') return; // só nos importa mensagem nova

    const dados = body.data;

    // Ignora mensagens que o próprio bot mandou (eco)
    if (dados?.key?.fromMe) return;

    // Ignora mensagens de grupo (o remoteJid de grupo termina com @g.us)
    const remoteJid = dados?.key?.remoteJid || '';
    if (remoteJid.endsWith('@g.us')) return;

    const numero = remoteJid; // já vem no formato certo pra responder, ex: 5511999999999@s.whatsapp.net
    const mensagem = dados?.message || {};

    const textoRecebido =
      mensagem.conversation ||
      mensagem.extendedTextMessage?.text ||
      mensagem.imageMessage?.caption ||
      '';

    const historico = carregarHistorico();
    if (!historico[numero]) historico[numero] = [];

    // Comando /hoje
    if (textoRecebido.trim().toLowerCase() === '/hoje') {
      await enviarTexto(numero, resumoDoDia(historico[numero]));
      return;
    }

    // Boas-vindas / ajuda
    if (textoRecebido.trim().toLowerCase() === '/ajuda' && !mensagem.imageMessage) {
      await enviarTexto(
        numero,
        '👋 Oi! Eu sou o *ZapFit*.\n\nMe manda uma *foto* ou *descreva em texto* o que você comeu, ' +
          'que eu calculo as calorias e macros pra você.\n\nComandos:\n/hoje - resumo do dia'
      );
      return;
    }

    let imagemBase64 = null;
    let mimeType = null;

    // Se veio imagem, a Evolution API já manda o conteúdo em base64 direto no
    // campo message.base64 (isso só funciha se "webhook_base64" estiver
    // ativado nas configurações do webhook da instância - veja o README).
    if (mensagem.imageMessage) {
      if (dados.message.base64) {
        imagemBase64 = dados.message.base64;
        mimeType = mensagem.imageMessage.mimetype || 'image/jpeg';
      } else {
        await enviarTexto(
          numero,
          '⚠️ Recebi a imagem mas não consegui ler o conteúdo dela. Configuração do webhook precisa de "base64" ativado (veja o README).'
        );
        return;
      }
    } else if (mensagem.audioMessage) {
      await enviarTexto(
        numero,
        '🎤 Por enquanto eu ainda não entendo áudio nessa versão de teste — pode descrever em texto ' +
          'ou mandar uma foto da refeição?'
      );
      return;
    } else if (!textoRecebido.trim()) {
      return; // nada pra analisar
    }

    const analise = await analisarRefeicao({
      texto: textoRecebido,
      imagemBase64,
      mimeType,
    });

    if (analise) {
      historico[numero].push({
        data: new Date().toISOString(),
        analise,
      });
      salvarHistorico(historico);
    }

    await enviarTexto(numero, formatarResposta(analise));
  } catch (erro) {
    console.error('Erro processando webhook:', erro);
  }
});

// Rota simples só pra confirmar que o servidor tá de pé
app.get('/', (req, res) => {
  res.send('ZapFit bot rodando! ✅');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✅ ZapFit (Evolution API) rodando na porta ${PORT}\n`);
  console.log(`Configure o webhook da sua instância na Evolution API para apontar para:`);
  console.log(`https://SEU-DOMINIO-DO-RAILWAY/webhook\n`);
});
