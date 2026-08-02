/**
 * NutriZap v2 - usando Evolution API + Perfil de usuário
 * ------------------------------------------------------
 * Esse bot:
 * 1. Sobe um servidor web (Express) que fica esperando a Evolution API
 *    avisar quando chega uma mensagem nova (webhook).
 * 2. Na primeira conversa, faz uma "entrevista" (onboarding) com o usuário
 *    pra saber objetivo, peso, altura, idade, sexo e nível de atividade -
 *    e calcula uma meta diária de calorias e macros.
 * 3. Se o usuário já tiver uma dieta pronta, ele pode mandar foto/print dela
 *    e a IA extrai as metas de lá em vez de calcular do zero.
 * 4. Depois disso, cada refeição mandada é comparada contra a meta do dia.
 *
 * IA: usa a API da OpenAI (GPT-5.6).
 */

require('dotenv').config();
const express = require('express');
const OpenAI = require('openai');

// ---------- Configuração ----------

const REQUIRED_ENV = [
  'OPENAI_API_KEY',
  'EVOLUTION_API_URL',
  'EVOLUTION_API_KEY',
  'EVOLUTION_INSTANCE',
  'DATABASE_URL',
];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`\n❌ Faltando ${key} no arquivo .env (ou nas variáveis do Railway). Veja o README.md.\n`);
    process.exit(1);
  }
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Modelo mais caro/capaz - usado só pra tarefas que exigem precisão
// (analisar foto de comida, ler foto de dieta, corrigir cálculo).
const MODELO_ANALISE = 'gpt-5.6-terra';

// Modelo mais barato - usado pra conversa comum (saudação, pergunta de
// porção, papo casual) onde não precisamos do modelo mais caro.
const MODELO_CONVERSA = 'gpt-5.6-luna';

// OBS: diferente da Anthropic, a OpenAI faz cache de prompt automaticamente
// pra prompts repetidos - não precisa marcar nada no código pra ganhar esse
// desconto, então não existe mais uma função "systemComCache" aqui.

// .trim() remove espaços/quebras de linha escondidas que às vezes entram
// quando a variável é colada no Railway - isso evita erros estranhos de
// "Application not found".
const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL.trim().replace(/\/+$/, '');
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY.trim();
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE.trim();

console.log(`🔗 EVOLUTION_API_URL configurada como: "${EVOLUTION_API_URL}"`);
console.log(`🔗 EVOLUTION_INSTANCE configurada como: "${EVOLUTION_INSTANCE}"`);

const app = express();
app.use(express.json({ limit: '20mb' })); // limite maior por causa das fotos em base64

// ---------- Armazenamento (Postgres - um registro por usuário) ----------
//
// Guardamos os dados de cada usuário como um único campo JSON dentro do
// banco (coluna "dados", tipo JSONB). Isso significa que a "forma" dos
// dados em memória continua exatamente igual a antes (perfil, refeições,
// atividades, etc.) - só troca ONDE isso é lido/salvo. Assim, nenhuma
// lógica de negócio precisou ser reescrita pra essa migração.

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : undefined,
});

async function garantirTabela() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usuarios (
      numero TEXT PRIMARY KEY,
      dados JSONB NOT NULL,
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  console.log('🗄️  Tabela "usuarios" pronta no Postgres.');
}

function usuarioPadrao() {
  return {
    perfil: { completo: false, etapa: null, nome: null },
    refeicoes: [],
    atividades: [],
  };
}

// Busca o usuário no banco (ou devolve uma "ficha" nova em branco, sem
// gravar nada ainda - só grava quando salvarUsuario for chamado).
async function carregarUsuario(numero) {
  const resultado = await pool.query('SELECT dados FROM usuarios WHERE numero = $1', [numero]);

  if (resultado.rows.length === 0) {
    return usuarioPadrao();
  }

  const usuario = resultado.rows[0].dados;
  if (!usuario.atividades) usuario.atividades = []; // usuários salvos antes dessa feature
  return usuario;
}

async function salvarUsuario(numero, usuario) {
  await pool.query(
    `INSERT INTO usuarios (numero, dados, atualizado_em)
     VALUES ($1, $2, now())
     ON CONFLICT (numero) DO UPDATE SET dados = $2, atualizado_em = now()`,
    [numero, JSON.stringify(usuario)]
  );
}

// O WhatsApp manda o nome de exibição do contato (pushName) em toda
// mensagem. Guardamos o primeiro nome pra poder chamar a pessoa por ele.
function capturarNome(perfil, dadosWebhook) {
  if (!perfil.nome && dadosWebhook?.pushName) {
    perfil.nome = dadosWebhook.pushName.trim().split(' ')[0];
  }
}

// Detecta mensagens de "papo comum" (saudação, pergunta, agradecimento) que
// NÃO são descrição de refeição - pra não tentar analisar "oi" como comida.
const REGEX_SAUDACAO =
  /^(oi+|ol[áa]|opa|e\s?a[íi]|eae|salve|fala|bom\s?dia|boa\s?tarde|boa\s?noite|tudo\s?bem\??|blz|beleza|valeu|obrigad[oa]|ok|td\s?bem|como\s?vai|tranquilo|tranquila)\b/i;

function pareceConversaComum(texto) {
  const t = (texto || '').trim();
  if (!t) return false;
  if (REGEX_SAUDACAO.test(t)) return true;
  if (t.includes('?')) return true; // pergunta, não é registro de refeição
  return false;
}

// Usuário corrigindo a última refeição registrada (ex: "não era 2 ovos, era 1")
const REGEX_CORRECAO =
  /\b(na verdade|me enganei|errei|foi engano|não era|nao era|não foi|nao foi|corrige|corrigir|esquece,? era|desconsidera,? era)\b/i;

// Usuário perguntando se/quanto pode comer algo específico - tanto no
// formato "quanto posso comer" quanto "posso comer X?" (permissão)
const REGEX_PERGUNTA_PORCAO =
  /(quantidade ideal|quant[ao]s?\s+(eu\s+)?(posso|devo|deveria|d[áa] pra)|qual a por[cç][ãa]o|posso comer|ainda posso comer|d[áa] pra comer|ser[áa] que posso comer|posso tomar|ainda posso tomar|d[áa] pra tomar|ser[áa] que posso tomar)/i;

// Usuário falando que PRETENDE comer/tomar algo (ainda não consumiu), OU
// perguntando de forma hipotética/condicional ("se eu comer X", "se eu tomar
// X"). Cobre tanto comida ("comer") quanto bebida ("tomar"). Perguntas de
// permissão ("posso comer X?") já são tratadas pela REGEX_PERGUNTA_PORCAO.
const REGEX_INTENCAO_FUTURA =
  /\b(vou (comer|tomar|almo[çc]ar|jantar|lanchar|beliscar)|pretendo (comer|tomar)|quero (comer|tomar)|penso em (comer|tomar)|acho que vou (comer|tomar)|se eu (comer|comesse|tomar|tomasse)|se (comer|comesse|tomar|tomasse)|caso eu (coma|tome)|caso (coma|tome))\b/i;

// Usuário confirmando que já comeu uma refeição que tinha ficado "pendente"
const REGEX_CONFIRMACAO_REFEICAO =
  /^(sim|comi|j[áa] comi|confirmo|isso mesmo|comi sim|confere|correto|exato)\b/i;

// Sinal de que a pessoa JÁ comeu (usado só pra detectar ambiguidade quando
// aparece junto com um sinal de intenção futura na mesma mensagem)
const REGEX_JA_COMI = /\b(comi|j[áa] comi|acabei de comer|comendo agora|estou comendo)\b/i;

// Usuário contando que fez alguma atividade física (pra descontar calorias
// gastas da meta do dia, tipo "fiz uma caminhada de 40 minutos")
const REGEX_ATIVIDADE_FISICA =
  /\b(caminhei|caminhada|corri|corrida|malhei|malhação|treinei|treino|academia|pedalei|pedalada|nadei|nata[çc][ãa]o|fiz\s+(exerc[íi]cio|educa[çc][ãa]o\s+f[íi]sica|cross\s?fit|pilates|yoga|muay\s?thai|jiu-?jitsu)|joguei\s+(bola|futebol|v[oô]lei|basquete|t[eê]nis))\b/i;

// Usuário pedindo pra REMOVER um registro que foi feito por engano (ex: "eu
// não consumi isso", "não tomei ainda", "apaga esse registro"). Diferente da
// correção (que ajusta números), aqui a refeição inteira sai do histórico.
const REGEX_RETRATACAO =
  /\b(n[ãa]o consumi|n[ãa]o tomei (isso|ainda)|n[ãa]o comi (isso|ainda)|n[ãa]o foi consumido|apaga (isso|esse registro|essa refei[çc][ãa]o)|remove (isso|esse registro|essa refei[çc][ãa]o)|cancela (isso|esse registro|essa refei[çc][ãa]o)|desconsidera (isso|esse registro|essa refei[çc][ãa]o)|tira (isso|esse registro) do (registro|resumo))\b/i;

// ---------- Cálculo de meta calórica (fórmula de Mifflin-St Jeor) ----------

const FATOR_ATIVIDADE = {
  '1': 1.2, // sedentário
  '2': 1.375, // leve (1-3x/semana)
  '3': 1.55, // moderado (3-5x/semana)
  '4': 1.725, // intenso (6-7x/semana)
  '5': 1.9, // muito intenso (atleta)
};

const NOME_ATIVIDADE = {
  '1': 'Sedentário',
  '2': 'Leve (1-3x/semana)',
  '3': 'Moderado (3-5x/semana)',
  '4': 'Intenso (6-7x/semana)',
  '5': 'Muito intenso (atleta)',
};

const NOME_OBJETIVO = {
  '1': 'Emagrecer',
  '2': 'Ganhar massa',
  '3': 'Manter o peso',
  '4': 'Só registrar (sem meta)',
};

function calcularMetas(perfil) {
  const { peso_kg, altura_cm, idade, sexo, nivel_atividade, objetivo } = perfil;

  // Taxa metabólica basal (TMB)
  let tmb =
    sexo === 'M'
      ? 10 * peso_kg + 6.25 * altura_cm - 5 * idade + 5
      : 10 * peso_kg + 6.25 * altura_cm - 5 * idade - 161;

  const fator = FATOR_ATIVIDADE[nivel_atividade] || 1.375;
  let manutencao = tmb * fator;

  let metaCalorias = manutencao;
  if (objetivo === '1') metaCalorias = manutencao - 500; // déficit p/ emagrecer
  if (objetivo === '2') metaCalorias = manutencao + 300; // superávit p/ ganhar massa

  // Nunca deixamos a meta cair abaixo de um piso de segurança.
  // Emagrecimento saudável não deveria passar disso sem acompanhamento
  // profissional individualizado.
  const PISO_SEGURANCA = sexo === 'M' ? 1500 : 1200;
  if (metaCalorias < PISO_SEGURANCA) metaCalorias = PISO_SEGURANCA;

  metaCalorias = Math.round(metaCalorias);

  const metaProteina = Math.round(peso_kg * 1.8);
  const metaGordura = Math.round((metaCalorias * 0.25) / 9);
  const metaCarboidrato = Math.round(
    (metaCalorias - metaProteina * 4 - metaGordura * 9) / 4
  );

  return {
    meta_calorias: metaCalorias,
    meta_proteina_g: metaProteina,
    meta_carboidrato_g: Math.max(metaCarboidrato, 0),
    meta_gordura_g: metaGordura,
  };
}

// ---------- Onboarding (entrevista inicial) ----------

function textoBoasVindas(nome) {
  const saudacao = nome ? `👋 Oi, ${nome}! Eu sou o *NutriZap*` : '👋 Oi! Eu sou o *NutriZap*';
  return (
    `${saudacao}, seu assistente de calorias no WhatsApp.\n\n` +
    'Antes de começar, vou te fazer algumas perguntas rápidas pra calcular sua meta ' +
    'diária certinha. Isso leva menos de 1 minuto.\n\n' +
    '*Qual é o seu objetivo?*\n' +
    '1️⃣ Emagrecer\n' +
    '2️⃣ Ganhar massa muscular\n' +
    '3️⃣ Manter o peso\n' +
    '4️⃣ Só quero registrar o que como (sem meta)\n\n' +
    'Responde só com o número.'
  );
}

// Processa a resposta do usuário de acordo com a etapa atual do onboarding.
// Retorna { resposta: string, perfil: object, precisaImagemDieta: bool }
async function processarOnboarding(perfil, texto, mensagem) {
  const t = (texto || '').trim();

  switch (perfil.etapa) {
    case 'objetivo': {
      if (!['1', '2', '3', '4'].includes(t)) {
        return { resposta: '⚠️ Responde só com o número: 1, 2, 3 ou 4.', perfil };
      }
      perfil.objetivo = t;
      if (t === '4') {
        perfil.completo = true;
        perfil.etapa = null;
        return {
          resposta:
            '✅ Perfil configurado! Só vou registrar suas refeições, sem meta de calorias.\n\n' +
            'Manda uma foto ou descreve o que você comeu quando quiser. Use */hoje* pra ver o resumo do dia.',
          perfil,
        };
      }
      perfil.etapa = 'peso';
      return { resposta: '⚖️ Qual é o seu *peso atual* em kg? (ex: 78)', perfil };
    }

    case 'peso': {
      const peso = parseFloat(t.replace(',', '.').replace(/[^\d.]/g, ''));
      if (!peso || peso < 20 || peso > 400) {
        return { resposta: '⚠️ Não entendi. Manda só o número, tipo: 78', perfil };
      }
      perfil.peso_kg = peso;
      perfil.etapa = 'altura';
      return { resposta: '📏 E a sua *altura* em cm? (ex: 175)', perfil };
    }

    case 'altura': {
      const altura = parseFloat(t.replace(',', '.').replace(/[^\d.]/g, ''));
      if (!altura || altura < 100 || altura > 250) {
        return { resposta: '⚠️ Não entendi. Manda só o número, tipo: 175', perfil };
      }
      perfil.altura_cm = altura;
      perfil.etapa = 'idade';
      return { resposta: '🎂 Qual sua *idade*?', perfil };
    }

    case 'idade': {
      const idade = parseInt(t.replace(/[^\d]/g, ''), 10);
      if (!idade || idade < 10 || idade > 100) {
        return { resposta: '⚠️ Não entendi. Manda só o número, tipo: 28', perfil };
      }
      perfil.idade = idade;
      perfil.etapa = 'sexo';
      return {
        resposta:
          '🚻 *Sexo biológico* (usado só pra calcular seu gasto calórico com mais precisão):\n1️⃣ Masculino\n2️⃣ Feminino',
        perfil,
      };
    }

    case 'sexo': {
      if (!['1', '2'].includes(t)) {
        return { resposta: '⚠️ Responde só com 1 ou 2.', perfil };
      }
      perfil.sexo = t === '1' ? 'M' : 'F';
      perfil.etapa = 'atividade';
      return {
        resposta:
          '🏃 Qual seu *nível de atividade física*?\n\n' +
          '1️⃣ Sedentário (pouco ou nenhum exercício)\n' +
          '2️⃣ Leve (exercício 1-3x/semana)\n' +
          '3️⃣ Moderado (exercício 3-5x/semana)\n' +
          '4️⃣ Intenso (exercício 6-7x/semana)\n' +
          '5️⃣ Muito intenso (atleta / 2x ao dia)',
        perfil,
      };
    }

    case 'atividade': {
      if (!['1', '2', '3', '4', '5'].includes(t)) {
        return { resposta: '⚠️ Responde só com um número de 1 a 5.', perfil };
      }
      perfil.nivel_atividade = t;
      perfil.etapa = 'tem_dieta';
      return {
        resposta:
          '📋 Última pergunta: você já tem uma *dieta pronta* (de nutricionista, por exemplo) ' +
          'que quer usar como meta?\n\n1️⃣ Sim, vou mandar uma foto/print dela\n2️⃣ Não, calcula pra mim',
        perfil,
      };
    }

    case 'tem_dieta': {
      if (t === '1') {
        perfil.etapa = 'aguardando_dieta';
        return {
          resposta: '📸 Beleza! Manda uma foto ou print da sua dieta (com as calorias e macros).',
          perfil,
        };
      }
      if (t === '2') {
        const metas = calcularMetas(perfil);
        Object.assign(perfil, metas);
        perfil.completo = true;
        perfil.etapa = null;
        return { resposta: montarResumoPerfil(perfil, true), perfil };
      }
      return { resposta: '⚠️ Responde só com 1 ou 2.', perfil };
    }

    case 'aguardando_dieta': {
      if (!mensagem?.imageMessage) {
        return {
          resposta: '📸 Preciso que você mande uma *foto* da sua dieta pra eu conseguir ler as metas.',
          perfil,
        };
      }
      return { resposta: null, perfil, precisaImagemDieta: true };
    }

    default:
      perfil.completo = true;
      perfil.etapa = null;
      return { resposta: 'Perfil configurado! Pode mandar sua primeira refeição. 🍽️', perfil };
  }
}

function montarResumoPerfil(perfil, primeiraVez) {
  const cabecalho = primeiraVez
    ? '✅ *Perfil configurado!*\n\n'
    : '📋 *Seu perfil atual*\n\n';

  return (
    cabecalho +
    `Objetivo: ${NOME_OBJETIVO[perfil.objetivo] || '-'}\n` +
    `Peso: ${perfil.peso_kg ?? '-'} kg | Altura: ${perfil.altura_cm ?? '-'} cm | Idade: ${perfil.idade ?? '-'}\n` +
    `Atividade: ${NOME_ATIVIDADE[perfil.nivel_atividade] || '-'}\n\n` +
    `🎯 *Sua meta diária*\n` +
    `🔥 Calorias: ${perfil.meta_calorias} kcal\n` +
    `🥩 Proteína: ${perfil.meta_proteina_g}g\n` +
    `🍞 Carboidrato: ${perfil.meta_carboidrato_g}g\n` +
    `🥑 Gordura: ${perfil.meta_gordura_g}g\n\n` +
    `_Essa é uma estimativa geral, não substitui orientação de um nutricionista, ` +
    `principalmente se você tiver alguma condição de saúde._\n\n` +
    (primeiraVez
      ? 'Agora é só me mandar foto ou descrição das suas refeições! Use */hoje* pra ver seu progresso e */perfil* pra ver ou refazer suas metas.'
      : 'Use */perfil refazer* se quiser preencher tudo de novo.')
  );
}

// ---------- Prompts para a IA ----------

const SYSTEM_PROMPT_REFEICAO = `Você é o NutriZap, um assistente nutricional que analisa refeições descritas
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

const SYSTEM_PROMPT_DIETA = `Você vai receber a foto de uma dieta/plano alimentar (de um
nutricionista, por exemplo). Extraia a meta diária TOTAL de calorias e macronutrientes
que essa dieta representa (some todas as refeições do dia, se for o caso).

Responda SEMPRE em formato JSON puro, sem markdown, sem texto antes ou depois:

{
  "meta_calorias": number,
  "meta_proteina_g": number,
  "meta_carboidrato_g": number,
  "meta_gordura_g": number,
  "conseguiu_ler": boolean,
  "observacao": "string curta explicando como você chegou nesses números, ou por que não conseguiu ler"
}

Se não conseguir ler a imagem ou não achar números de calorias/macros, responda
"conseguiu_ler": false e explique o motivo em "observacao".`;

const SYSTEM_PROMPT_ATIVIDADE = `O usuário contou que fez uma atividade física. Estime quantas
calorias foram gastas nessa atividade, usando o peso corporal e a duração informados (quando
não vier duração explícita, assume uma duração típica pra esse tipo de atividade e deixe isso
claro na observação).

Responda SEMPRE em formato JSON puro, sem markdown, sem texto antes ou depois:

{
  "atividade": "string curta, nome da atividade",
  "duracao_min": number,
  "calorias_gastas": number,
  "confianca": "alta" | "media" | "baixa",
  "observacao": "string curta - deixe claro que é uma estimativa"
}

Seja conservador na estimativa (é melhor subestimar levemente do que superestimar
o gasto calórico, já que isso afeta quanto a pessoa "ganha" de volta pra comer).`;

const SYSTEM_PROMPT_CHAT = `Você é o NutriZap, um assistente de nutrição e hábitos alimentares que
conversa por WhatsApp. O usuário mandou uma mensagem que NÃO é uma refeição pra registrar
(é uma saudação, pergunta ou comentário casual).

Responda de forma curta (1-3 frases), calorosa e natural, como um treinador/nutricionista
que manda mensagem no WhatsApp - nada de formalidade excessiva. Use o nome do usuário se
for informado. Use emojis com moderação.

Mantenha o assunto sempre voltado a alimentação, calorias, hábitos saudáveis e o progresso
do usuário. Se o usuário perguntar sobre o dia dele (quanto já comeu, quanto falta),
use exatamente os números do resumo fornecido - nunca invente números. Se a pergunta for
sobre outro assunto totalmente fora desse tema, redirecione com gentileza de volta pra
alimentação/hábitos.

Não responda em JSON - só texto puro, pronto pra ser mandado direto no WhatsApp.`;

const SYSTEM_PROMPT_PORCAO = `Você é o NutriZap, respondendo se a pessoa PODE comer/tomar algo
específico agora, considerando quanto ela já consumiu hoje e sua meta.

Seja realista e direto, baseado exatamente nos números fornecidos:
- Se o alimento cabe folgado no que resta da meta, diga isso com tranquilidade, sem enrolar.
- Se vai deixar a pessoa no limite ou passar um pouco, avise isso claramente, sem dramatizar
  (ex: "vai passar uns 80 kcal da meta, mas não é nada grave").
- Se a pessoa JÁ passou da meta hoje, seja honesto sobre isso também, sem julgar e sem fingir
  que ainda sobra espaço.
- Quando fizer sentido, sugira uma porção parcial (ex: "metade dela", "um terço", "só um
  pedaço") em vez de simplesmente dizer sim ou não.
- Nunca invente número - use só os que foram te passados.

Responda em 2-4 frases, tom de amigo/nutricionista mandando mensagem no WhatsApp, nada de
formalidade. VARIE a estrutura da resposta entre uma pergunta e outra (às vezes comece pelo
número, às vezes por uma opinião direta, às vezes devolvendo uma pergunta) - não repita
sempre o mesmo formato de frase. Não responda em JSON, só texto puro.`;

function limparJson(texto) {
  return texto.replace(/```json/gi, '').replace(/```/g, '').trim();
}

async function chamarIATexto({ systemPrompt, texto }) {
  const response = await openai.chat.completions.create({
    model: MODELO_CONVERSA,
    max_completion_tokens: 300,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: texto },
    ],
  });

  return response.choices[0]?.message?.content?.trim() || null;
}

async function responderConversa({ numero, perfil, usuario, textoUsuario }) {
  const contexto =
    `Nome do usuário: ${perfil.nome || 'não informado'}\n` +
    `Objetivo: ${NOME_OBJETIVO[perfil.objetivo] || 'ainda não configurado'}\n` +
    `Resumo de hoje: ${resumoDoDia(usuario)}\n\n` +
    `Mensagem do usuário: "${textoUsuario}"`;

  const resposta = await chamarIATexto({ systemPrompt: SYSTEM_PROMPT_CHAT, texto: contexto });

  await enviarTexto(
    numero,
    resposta || `${perfil.nome ? `Oi, ${perfil.nome}! ` : 'Oi! '}Como posso te ajudar com sua alimentação hoje? 🍽️`
  );
}

// Usuário perguntou "quanto posso comer de X" - calcula o orçamento calórico
// que ainda resta no dia e sugere uma porção, sem registrar nada ainda.
async function sugerirPorcao({ numero, perfil, usuario, textoUsuario }) {
  const { totais } = calcularTotaisHoje(usuario);

  // Estimativa grosseira de quantas refeições ainda faltam hoje, baseada no
  // horário atual - só pra dar um contexto melhor pra IA, não é exato.
  const hora = new Date().getHours();
  let refeicoesRestantes = 3;
  if (hora >= 20) refeicoesRestantes = 1;
  else if (hora >= 15) refeicoesRestantes = 2;
  else if (hora >= 10) refeicoesRestantes = 3;
  else refeicoesRestantes = 4;

  let contextoMeta;
  if (perfil?.completo && perfil.meta_calorias && perfil.objetivo !== '4') {
    // NÃO trava em zero de propósito - se a pessoa já passou da meta, a IA
    // precisa saber disso pra ser honesta na resposta, em vez de fingir que
    // ainda sobra espaço.
    const restante = perfil.meta_calorias - totais.calorias;
    const orcamentoPorRefeicao = Math.round(Math.max(restante, 0) / refeicoesRestantes);
    contextoMeta =
      `Meta diária do usuário: ${perfil.meta_calorias} kcal. Já consumiu hoje: ${totais.calorias} kcal. ` +
      (restante >= 0
        ? `Ainda restam ${restante} kcal pro resto do dia (considerando cerca de ${refeicoesRestantes} ` +
          `refeições restantes, ~${orcamentoPorRefeicao} kcal por refeição, só como referência).`
        : `ATENÇÃO: o usuário JÁ ULTRAPASSOU a meta em ${Math.abs(restante)} kcal hoje. Seja honesto sobre isso, ` +
          `sem dramatizar - explica o impacto real de comer mais um pouco.`);
  } else {
    contextoMeta = 'O usuário não tem meta calórica configurada.';
  }

  const prompt = `${contextoMeta}\n\nO usuário perguntou: "${textoUsuario}"`;

  const resposta = await chamarIATexto({ systemPrompt: SYSTEM_PROMPT_PORCAO, texto: prompt });

  await enviarTexto(
    numero,
    resposta || 'Não consegui calcular isso agora. Pode descrever de novo o que você quer comer?'
  );
}

// Usuário corrigindo a última refeição registrada (ex: "não era 2 ovos, era 1").
// Substitui o último registro em vez de somar em cima dele.
async function corrigirUltimaRefeicao({ numero, usuario, textoCorrecao }) {
  const ultima = usuario.refeicoes[usuario.refeicoes.length - 1];

  if (!ultima) {
    await enviarTexto(
      numero,
      'Não achei nenhuma refeição recente pra corrigir. Pode descrever a refeição certinha de novo?'
    );
    return;
  }

  const contexto =
    `A última refeição registrada foi interpretada assim: ${JSON.stringify(ultima.analise.alimentos)}, ` +
    `totalizando ${ultima.analise.calorias_kcal} kcal. O usuário está corrigindo essa informação: "${textoCorrecao}". ` +
    'Refaça a análise levando em conta a correção (ex: se ele disse que era 1 ovo em vez de 2, ' +
    'recalcule considerando só 1 ovo, não os dois).';

  const analiseCorrigida = await chamarIA({ systemPrompt: SYSTEM_PROMPT_REFEICAO, texto: contexto });

  if (analiseCorrigida) {
    usuario.refeicoes[usuario.refeicoes.length - 1] = { data: ultima.data, analise: analiseCorrigida };
    await enviarTexto(numero, `✅ Corrigido!\n\n${formatarResposta(analiseCorrigida)}`);
  } else {
    await enviarTexto(numero, '⚠️ Não consegui refazer o cálculo. Pode descrever a refeição certinha, do zero?');
  }
}

// Remove a última refeição registrada por completo (diferente de corrigir -
// aqui o usuário está dizendo que aquele registro nem deveria ter existido,
// ex: "eu não consumi isso", "não tomei ainda", "apaga esse registro").
async function removerUltimaRefeicao({ numero, usuario }) {
  const ultima = usuario.refeicoes[usuario.refeicoes.length - 1];

  if (!ultima) {
    await enviarTexto(numero, 'Não encontrei nenhum registro recente pra remover.');
    return;
  }

  usuario.refeicoes.pop();

  const nomeAlimentos = ultima.analise?.alimentos?.map((a) => a.nome).join(', ') || 'essa refeição';

  await enviarTexto(
    numero,
    `🗑️ Removido! Tirei do seu registro: *${nomeAlimentos}* (${ultima.analise?.calorias_kcal || 0} kcal).\n\n` +
      'Seu resumo de hoje já está atualizado. Se quiser conferir, manda */hoje*.'
  );
}

// Mensagem ambígua (tem sinal de "já comi" E "vou comer" ao mesmo tempo) -
// em vez de adivinhar, pergunta pro usuário qual é o caso. Se tiver foto
// junto, já analisa ela agora (pra não precisar pedir a foto de novo depois).
async function perguntarSeJaComeu({ numero, usuario, textoOriginal, imagemBase64, mimeType }) {
  let analisePreCalculada = null;

  if (imagemBase64) {
    await enviarTexto(numero, '🔎 Analisando sua foto...');
    analisePreCalculada = await chamarIA({
      systemPrompt: SYSTEM_PROMPT_REFEICAO,
      texto: textoOriginal
        ? `O usuário mandou essa legenda (ainda não sabemos se já consumiu ou não): "${textoOriginal}". Analise a imagem e retorne o JSON normalmente.`
        : null,
      imagemBase64,
      mimeType,
    });
  }

  usuario.aguardandoTipoRefeicao = { textoOriginal };
  usuario.aguardandoTipoRefeicaoAnalise = analisePreCalculada;

  await enviarTexto(
    numero,
    '🤔 Só pra eu registrar certinho: você já comeu/tomou isso, ou ainda vai?'
  );
}

// Usuário disse que PRETENDE comer algo (ainda não comeu), ou perguntou de
// forma condicional/hipotética - estima os valores (podendo incluir foto)
// mas NÃO registra como refeição ainda. Fica "pendente" até ele confirmar.
async function estimarRefeicaoFutura({ numero, usuario, textoUsuario, imagemBase64, mimeType }) {
  const analise = await chamarIA({
    systemPrompt: SYSTEM_PROMPT_REFEICAO,
    texto: `O usuário disse que PRETENDE comer/tomar isso (ainda não consumiu): "${textoUsuario}". Estime os valores normalmente.`,
    imagemBase64,
    mimeType,
  });

  if (!analise) {
    await enviarTexto(numero, '⚠️ Não consegui estimar isso. Pode descrever de outro jeito?');
    return;
  }

  usuario.refeicaoPendente = { analise, criadoEm: new Date().toISOString() };

  await enviarTexto(numero, formatarRespostaHipotetica(analise));
}

// Usuário contou que fez atividade física - estima o gasto calórico e
// registra, pra somar de volta na meta do dia (a pessoa "ganha" calorias).
async function registrarAtividadeFisica({ numero, perfil, usuario, textoUsuario }) {
  const contextoPeso = perfil?.peso_kg
    ? `Peso corporal do usuário: ${perfil.peso_kg}kg.`
    : 'Peso corporal não informado - assuma uma pessoa adulta de porte médio (~70kg).';

  const analise = await chamarIA({
    systemPrompt: SYSTEM_PROMPT_ATIVIDADE,
    texto: `${contextoPeso} O usuário contou: "${textoUsuario}". Estime o gasto calórico e retorne o JSON.`,
  });

  if (!analise || !analise.calorias_gastas) {
    await enviarTexto(
      numero,
      '⚠️ Não consegui estimar o gasto dessa atividade. Pode descrever com mais detalhes (tipo e duração)?'
    );
    return;
  }

  usuario.atividades.push({ data: new Date().toISOString(), analise });

  await enviarTexto(
    numero,
    `🏃 *Atividade registrada*\n\n` +
      `${analise.atividade} (~${analise.duracao_min} min)\n` +
      `🔥 Calorias gastas: *~${analise.calorias_gastas} kcal*\n\n` +
      (analise.observacao ? `_${analise.observacao}_\n\n` : '') +
      `Isso já entrou na sua meta de hoje! Manda */hoje* pra ver o resumo atualizado. 💪`
  );
}


async function chamarIA({ systemPrompt, texto, imagemBase64, mimeType }) {
  const content = [];

  content.push({
    type: 'text',
    text: texto || 'Analise a imagem e retorne o JSON.',
  });

  if (imagemBase64) {
    content.push({
      type: 'image_url',
      image_url: { url: `data:${mimeType || 'image/jpeg'};base64,${imagemBase64}` },
    });
  }

  const response = await openai.chat.completions.create({
    model: MODELO_ANALISE,
    max_completion_tokens: 600,
    response_format: { type: 'json_object' }, // força a OpenAI a devolver JSON válido
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content },
    ],
  });

  const textoResposta = response.choices[0]?.message?.content || '{}';

  try {
    return JSON.parse(limparJson(textoResposta));
  } catch (e) {
    console.error('Não consegui interpretar a resposta da IA:', textoResposta);
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
    `🥑 Gordura: ${analise.gordura_g}g` +
    (analise.observacao ? `\n\n_${analise.observacao}_` : '')
  );
}

// Formato DIFERENTE do "cartão de registro" acima - usado só pra estimativas
// hipotéticas ("vou comer X", "se eu tomar X"), que ainda NÃO foram
// registradas. Visual mais leve/informal, pra não parecer um recibo oficial.
function formatarRespostaHipotetica(analise) {
  if (!analise) {
    return '⚠️ Não consegui estimar isso. Pode descrever de outro jeito?';
  }

  const nomes = analise.alimentos?.map((a) => a.nome).join(', ') || 'isso';

  return (
    `👀 Se você consumir *${nomes}*, a conta fica em torno de *${analise.calorias_kcal} kcal* ` +
    `(🥩 ${analise.proteina_g}g · 🍞 ${analise.carboidrato_g}g · 🥑 ${analise.gordura_g}g).\n\n` +
    `_Ainda não registrei nada — quando for de verdade, me avisa (ex: "comi" ou "confirmo")!_ 😉`
  );
}

function calcularTotaisHoje(usuario) {
  const hoje = new Date().toISOString().slice(0, 10);
  const registrosHoje = (usuario.refeicoes || []).filter((r) => r.data.startsWith(hoje));
  const atividadesHoje = (usuario.atividades || []).filter((a) => a.data.startsWith(hoje));

  const totais = registrosHoje.reduce(
    (acc, r) => ({
      calorias: acc.calorias + (r.analise.calorias_kcal || 0),
      proteina: acc.proteina + (r.analise.proteina_g || 0),
      carboidrato: acc.carboidrato + (r.analise.carboidrato_g || 0),
      gordura: acc.gordura + (r.analise.gordura_g || 0),
    }),
    { calorias: 0, proteina: 0, carboidrato: 0, gordura: 0 }
  );

  const caloriasQueimadas = atividadesHoje.reduce((soma, a) => soma + (a.analise?.calorias_gastas || 0), 0);

  return { registrosHoje, atividadesHoje, totais, caloriasQueimadas };
}

function resumoDoDia(usuario) {
  const { registrosHoje, atividadesHoje, totais, caloriasQueimadas } = calcularTotaisHoje(usuario);
  const perfil = usuario.perfil;

  if (registrosHoje.length === 0 && atividadesHoje.length === 0) {
    return 'Você ainda não registrou nenhuma refeição hoje. Manda uma foto ou descreve o que comeu! 📸';
  }

  let texto = `📊 *Resumo de hoje* (${registrosHoje.length} refeições)\n\n`;

  if (registrosHoje.length > 0) {
    texto +=
      `🔥 Calorias: *${totais.calorias} kcal*\n` +
      `🥩 Proteína: ${totais.proteina}g\n` +
      `🍞 Carboidrato: ${totais.carboidrato}g\n` +
      `🥑 Gordura: ${totais.gordura}g`;
  } else {
    texto += 'Nenhuma refeição registrada ainda hoje.';
  }

  if (caloriasQueimadas > 0) {
    texto += `\n\n🏃 Atividade física: *-${caloriasQueimadas} kcal* (${atividadesHoje.length} ${atividadesHoje.length === 1 ? 'atividade' : 'atividades'})`;
  }

  if (perfil?.completo && perfil.meta_calorias && perfil.objetivo !== '4') {
    const metaEfetiva = perfil.meta_calorias + caloriasQueimadas;
    const restante = metaEfetiva - totais.calorias;
    const percentual = Math.round((totais.calorias / metaEfetiva) * 100);

    texto +=
      `\n\n🎯 *Meta do dia: ${perfil.meta_calorias} kcal*` +
      (caloriasQueimadas > 0 ? ` (+${caloriasQueimadas} da atividade = ${metaEfetiva} kcal hoje)` : '') +
      ` (${percentual}% consumido)\n` +
      (restante >= 0
        ? `Faltam *${restante} kcal* pra bater a meta.`
        : `Você passou *${Math.abs(restante)} kcal* da meta.`);
  }

  return texto;
}

// Aviso gentil e sincero quando o uso do dia fica bem alto - é genuinamente
// pensado pro bem-estar do usuário (registrar comida de forma obsessiva não
// é saudável), aparece no máximo 1x por dia, e nunca esconde nada: só
// descreve exatamente o que está acontecendo (muitos registros hoje).
function jaAvisouUsoExcessivoHoje(usuario) {
  const hoje = new Date().toISOString().slice(0, 10);
  return usuario.avisoUsoExcessivoEm === hoje;
}

async function talvezAvisarUsoExcessivo(numero, usuario) {
  const LIMITE_DIARIO_PARA_AVISO = 8;
  const { registrosHoje } = calcularTotaisHoje(usuario);

  if (registrosHoje.length < LIMITE_DIARIO_PARA_AVISO) return;
  if (jaAvisouUsoExcessivoHoje(usuario)) return;

  usuario.avisoUsoExcessivoEm = new Date().toISOString().slice(0, 10);

  await enviarTexto(
    numero,
    '🌿 Reparei que você já registrou bastante coisa hoje! Se já bateu (ou passou) sua meta, ' +
      'fica tranquilo(a) — não precisa registrar tudo tão certinho pelo resto do dia. ' +
      'Registrar demais também pode virar mais uma fonte de estresse, e não é essa a ideia aqui. 💛'
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
    body: JSON.stringify({ number: numero, text: texto }),
  });

  if (!resp.ok) {
    const erro = await resp.text();
    console.error('Erro ao enviar mensagem pela Evolution API:', resp.status, erro);
  }
}

// ---------- Rota que recebe os eventos da Evolution API (webhook) ----------

app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // responde rápido pra Evolution API não ficar esperando

  try {
    const body = req.body;
    if (body.event !== 'messages.upsert') return;

    const dados = body.data;
    if (dados?.key?.fromMe) return; // ignora eco do próprio bot

    const remoteJid = dados?.key?.remoteJid || '';
    if (remoteJid.endsWith('@g.us')) return; // ignora grupos

    const numero = remoteJid;
    const mensagem = dados?.message || {};

    const textoRecebido =
      mensagem.conversation ||
      mensagem.extendedTextMessage?.text ||
      mensagem.imageMessage?.caption ||
      '';

    const usuario = await carregarUsuario(numero);
    const perfil = usuario.perfil;
    capturarNome(perfil, dados);
    const comando = textoRecebido.trim().toLowerCase();

    // Primeira mensagem de um usuário totalmente novo: manda boas-vindas
    // com o nome dele em vez de já disparar a primeira pergunta "seca".
    const ehPrimeiraMensagem = usuario.refeicoes.length === 0 && !perfil.completo && !perfil.etapa;
    if (ehPrimeiraMensagem) {
      perfil.etapa = 'objetivo';
      await enviarTexto(numero, textoBoasVindas(perfil.nome));
      await salvarUsuario(numero, usuario);
      return;
    }

    // --- Comandos disponíveis a qualquer momento ---
    if (comando === '/hoje') {
      await enviarTexto(numero, resumoDoDia(usuario));
      await salvarUsuario(numero, usuario);
      return;
    }

    if (comando === '/perfil') {
      if (perfil.completo) {
        await enviarTexto(numero, montarResumoPerfil(perfil, false));
      } else {
        await enviarTexto(numero, textoBoasVindas(perfil.nome));
      }
      await salvarUsuario(numero, usuario);
      return;
    }

    if (comando === '/perfil refazer') {
      usuario.perfil = { completo: false, etapa: 'objetivo', nome: perfil.nome };
      await enviarTexto(numero, textoBoasVindas(perfil.nome));
      await salvarUsuario(numero, usuario);
      return;
    }

    if (comando === '/ajuda') {
      await enviarTexto(
        numero,
        '👋 Comandos disponíveis:\n\n' +
          '📸 Manda foto/texto de uma refeição pra registrar\n' +
          '*/hoje* - resumo do dia\n' +
          '*/perfil* - ver suas metas\n' +
          '*/perfil refazer* - refazer a entrevista inicial'
      );
      await salvarUsuario(numero, usuario);
      return;
    }

    // --- Se o perfil ainda não está completo, tocamos o onboarding ---
    if (!perfil.completo) {
      if (!perfil.etapa) perfil.etapa = 'objetivo';

      const resultado = await processarOnboarding(perfil, textoRecebido, mensagem);
      usuario.perfil = resultado.perfil;

      if (resultado.precisaImagemDieta) {
        let imagemBase64 = null;
        let mimeType = null;
        if (mensagem.imageMessage && dados.message.base64) {
          imagemBase64 = dados.message.base64;
          mimeType = mensagem.imageMessage.mimetype || 'image/jpeg';
          await enviarTexto(numero, '🔎 Lendo sua dieta...');
        }

        const extraido = await chamarIA({
          systemPrompt: SYSTEM_PROMPT_DIETA,
          texto: 'Leia essa dieta e extraia a meta diária de calorias e macros.',
          imagemBase64,
          mimeType,
        });

        if (extraido?.conseguiu_ler) {
          usuario.perfil.meta_calorias = extraido.meta_calorias;
          usuario.perfil.meta_proteina_g = extraido.meta_proteina_g;
          usuario.perfil.meta_carboidrato_g = extraido.meta_carboidrato_g;
          usuario.perfil.meta_gordura_g = extraido.meta_gordura_g;
          usuario.perfil.completo = true;
          usuario.perfil.etapa = null;
          await enviarTexto(numero, montarResumoPerfil(usuario.perfil, true));
        } else {
          await enviarTexto(
            numero,
            `⚠️ ${extraido?.observacao || 'Não consegui ler as metas dessa dieta.'} ` +
              'Pode mandar outra foto mais nítida, ou responder *2* pra eu calcular sua meta automaticamente.'
          );
          usuario.perfil.etapa = 'tem_dieta';
        }
      } else if (resultado.resposta) {
        await enviarTexto(numero, resultado.resposta);
      }

      await salvarUsuario(numero, usuario);
      return;
    }

    // --- Perfil já completo: fluxos especiais primeiro ---

    // Extrai a imagem (se tiver) JÁ AQUI NO INÍCIO, porque as checagens de
    // intenção (futuro/condicional) abaixo precisam saber se tem foto ou não,
    // e - se tiver - precisam poder analisar ela também (ex: foto de bebida
    // com a legenda "se eu tomar isso hoje..." é uma pergunta, não um consumo).
    let imagemBase64 = null;
    let mimeType = null;
    let jaAvisouAnalisando = false;

    if (mensagem.imageMessage) {
      if (dados.message.base64) {
        imagemBase64 = dados.message.base64;
        mimeType = mensagem.imageMessage.mimetype || 'image/jpeg';
      } else {
        await enviarTexto(
          numero,
          '⚠️ Recebi a imagem mas não consegui ler o conteúdo dela. Configuração do webhook precisa de "base64" ativado.'
        );
        return;
      }
    } else if (mensagem.audioMessage) {
      await enviarTexto(
        numero,
        '🎤 Por enquanto eu ainda não entendo áudio — pode descrever em texto ou mandar uma foto da refeição?'
      );
      return;
    }

    async function avisarAnalisandoSeNecessario() {
      if (imagemBase64 && !jaAvisouAnalisando) {
        jaAvisouAnalisando = true;
        await enviarTexto(numero, '🔎 Analisando sua foto...');
      }
    }

    // Resposta a uma pergunta de "você já comeu ou ainda vai comer?" que
    // ficou pendente de uma mensagem ambígua anterior.
    if (usuario.aguardandoTipoRefeicao) {
      const textoOriginal = usuario.aguardandoTipoRefeicao.textoOriginal;
      const disseQueJaComeu = !/^(n[ãa]o|ainda n[ãa]o|vou comer|depois|mais tarde|ainda vou)/i.test(comando);
      usuario.aguardandoTipoRefeicao = null;

      if (disseQueJaComeu) {
        const analiseJaSalva = usuario.aguardandoTipoRefeicaoAnalise || null;
        const analise =
          analiseJaSalva ||
          (await chamarIA({
            systemPrompt: SYSTEM_PROMPT_REFEICAO,
            texto: `O usuário confirmou que já comeu isso: "${textoOriginal}". Analise e retorne o JSON.`,
          }));
        if (analise) usuario.refeicoes.push({ data: new Date().toISOString(), analise });
        await enviarTexto(numero, formatarResposta(analise));
        await talvezAvisarUsoExcessivo(numero, usuario);
      } else {
        await estimarRefeicaoFutura({ numero, usuario, textoUsuario: textoOriginal });
      }
      usuario.aguardandoTipoRefeicaoAnalise = null;
      await salvarUsuario(numero, usuario);
      return;
    }

    // Confirmação de uma refeição que tinha ficado "pendente" (ex: usuário
    // disse "vou comer X" antes, e agora confirma que comeu de verdade)
    if (usuario.refeicaoPendente && REGEX_CONFIRMACAO_REFEICAO.test(comando)) {
      usuario.refeicoes.push({ data: new Date().toISOString(), analise: usuario.refeicaoPendente.analise });
      await enviarTexto(numero, `✅ Registrado!\n\n${formatarResposta(usuario.refeicaoPendente.analise)}`);
      usuario.refeicaoPendente = null;
      await talvezAvisarUsoExcessivo(numero, usuario);
      await salvarUsuario(numero, usuario);
      return;
    }

    // Usuário pedindo pra REMOVER/RETRATAR o último registro (ex: "eu não
    // consumi isso", "não tomei ainda", "apaga esse registro"). Diferente da
    // correção (que ajusta a quantidade), aqui a refeição inteira é removida.
    if (REGEX_RETRATACAO.test(textoRecebido) && usuario.refeicoes.length > 0) {
      await removerUltimaRefeicao({ numero, usuario });
      await salvarUsuario(numero, usuario);
      return;
    }

    // Correção da última refeição registrada (ex: "não era 2 ovos, era 1")
    if (!mensagem.imageMessage && REGEX_CORRECAO.test(textoRecebido) && usuario.refeicoes.length > 0) {
      await corrigirUltimaRefeicao({ numero, usuario, textoCorrecao: textoRecebido });
      await salvarUsuario(numero, usuario);
      return;
    }

    // Usuário contando que fez atividade física - registra o gasto calórico
    // e soma de volta na meta do dia
    if (!mensagem.imageMessage && REGEX_ATIVIDADE_FISICA.test(textoRecebido)) {
      await registrarAtividadeFisica({ numero, perfil, usuario, textoUsuario: textoRecebido });
      await salvarUsuario(numero, usuario);
      return;
    }

    // Pergunta sobre porção/quantidade ideal (checa ANTES do filtro de "papo
    // comum" genérico, já que essas perguntas também têm "?")
    if (!mensagem.imageMessage && REGEX_PERGUNTA_PORCAO.test(textoRecebido)) {
      await sugerirPorcao({ numero, perfil, usuario, textoUsuario: textoRecebido });
      await salvarUsuario(numero, usuario);
      return;
    }

    // Mensagem ambígua: tem sinal de "já comi" E "vou comer" ao mesmo tempo
    // (ex: "já comi o almoço, mas ainda vou comer sobremesa depois"). Também
    // vale pra foto + legenda ambígua. Em vez de adivinhar, pergunta.
    if (REGEX_INTENCAO_FUTURA.test(textoRecebido) && REGEX_JA_COMI.test(textoRecebido)) {
      await perguntarSeJaComeu({ numero, usuario, textoOriginal: textoRecebido, imagemBase64, mimeType });
      await salvarUsuario(numero, usuario);
      return;
    }

    // Usuário falando (ou perguntando de forma condicional/hipotética, tipo
    // "se eu comer/tomar isso...") que PRETENDE comer algo - vale tanto pra
    // texto quanto pra foto com legenda condicional. Não registra ainda, só
    // estima e espera confirmação (evita contar calorias de comida que nem
    // foi consumida).
    if (REGEX_INTENCAO_FUTURA.test(textoRecebido)) {
      await avisarAnalisandoSeNecessario();
      await estimarRefeicaoFutura({ numero, usuario, textoUsuario: textoRecebido, imagemBase64, mimeType });
      await salvarUsuario(numero, usuario);
      return;
    }

    // --- Perfil já completo: papo comum (sem foto) não vira "refeição" ---
    if (!mensagem.imageMessage && !mensagem.audioMessage && pareceConversaComum(textoRecebido)) {
      await responderConversa({ numero, perfil, usuario, textoUsuario: textoRecebido });
      await salvarUsuario(numero, usuario);
      return;
    }

    // --- Perfil já completo: trata mensagem como refeição normal ---
    if (!imagemBase64 && !textoRecebido.trim()) {
      return; // nada pra analisar
    }

    await avisarAnalisandoSeNecessario();

    const analise = await chamarIA({
      systemPrompt: SYSTEM_PROMPT_REFEICAO,
      texto: textoRecebido
        ? `O usuário descreveu a refeição assim: "${textoRecebido}". Analise e retorne o JSON.`
        : null,
      imagemBase64,
      mimeType,
    });

    const analiseVazia =
      !analise || (!imagemBase64 && (!analise.alimentos || analise.alimentos.length === 0) && !analise.calorias_kcal);

    if (analiseVazia && !imagemBase64) {
      // Texto que não é claramente uma refeição e nem bateu no filtro de
      // saudação/pergunta (ex: um comentário qualquer) - trata como conversa
      // em vez de mostrar um cartão de "0 calorias, nenhum alimento".
      await responderConversa({ numero, perfil, usuario, textoUsuario: textoRecebido });
      await salvarUsuario(numero, usuario);
      return;
    }

    if (analise) {
      usuario.refeicoes.push({ data: new Date().toISOString(), analise });
    }

    await enviarTexto(numero, formatarResposta(analise));
    if (analise) await talvezAvisarUsoExcessivo(numero, usuario);
    await salvarUsuario(numero, usuario);
  } catch (erro) {
    console.error('Erro processando webhook:', erro);
  }
});

// Rota simples só pra confirmar que o servidor tá de pé
app.get('/', (req, res) => {
  res.send('NutriZap bot rodando! ✅');
});

const PORT = process.env.PORT || 3000;

garantirTabela()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`\n✅ NutriZap (Evolution API) rodando na porta ${PORT}\n`);
      console.log(`Configure o webhook da sua instância na Evolution API para apontar para:`);
      console.log(`https://SEU-DOMINIO-DO-RAILWAY/webhook\n`);
    });
  })
  .catch((erro) => {
    console.error('\n❌ Não consegui conectar/preparar o banco de dados Postgres:', erro.message);
    console.error('Confere se a variável DATABASE_URL está certa nas Variables do Railway.\n');
    process.exit(1);
  });
