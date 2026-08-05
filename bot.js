/**
 * NutriZap v2 - usando a API oficial do WhatsApp (Meta Cloud API)
 * -----------------------------------------------------------------
 * Esse bot:
 * 1. Sobe um servidor web (Express) que fica esperando a Meta avisar quando
 *    chega uma mensagem nova (webhook), e responde direto pela Graph API.
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
  'META_ACCESS_TOKEN',
  'META_PHONE_NUMBER_ID',
  'META_VERIFY_TOKEN',
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

const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN.trim();
const META_PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID.trim();
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN.trim();
const META_API_VERSION = 'v22.0';

// Opcional: se configurado, o bot manda um WhatsApp pra esse número quando
// algo dá errado (em vez de você só descobrir catando log no Railway).
const ADMIN_WHATSAPP_NUMERO = process.env.ADMIN_WHATSAPP_NUMERO?.trim() || null;
if (!ADMIN_WHATSAPP_NUMERO) {
  console.log('⚠️  ADMIN_WHATSAPP_NUMERO não configurado - alertas de erro por WhatsApp estão desativados.');
}

console.log(`🔗 META_PHONE_NUMBER_ID configurado como: "${META_PHONE_NUMBER_ID}"`);

// ---------- Trial grátis + assinatura ----------
//
// Quantas refeições a pessoa pode registrar de graça antes do bot pedir
// pra assinar. Pode ajustar sem mexer no código, só trocando a variável
// LIMITE_REFEICOES_TESTE no Railway.
const LIMITE_REFEICOES_TESTE = Number(process.env.LIMITE_REFEICOES_TESTE || 4);

// Link de checkout da assinatura (Cakto, Mercado Pago, ou o que você
// estiver usando). Enquanto não tiver o link real, o bot cai num aviso
// genérico em vez de quebrar.
const CAKTO_CHECKOUT_URL = process.env.CAKTO_CHECKOUT_URL?.trim() || null;
if (!CAKTO_CHECKOUT_URL) {
  console.log('⚠️  CAKTO_CHECKOUT_URL não configurado - o bot vai avisar o limite mas sem link de pagamento.');
}

// Segredo compartilhado pra validar que a chamada em /webhook/cakto
// realmente veio da Cakto (e não de qualquer um mandando um POST
// forjado marcando gente como "assinante" de graça). Configure esse
// mesmo valor lá no painel da Cakto quando for cadastrar o webhook.
const CAKTO_WEBHOOK_SECRET = process.env.CAKTO_WEBHOOK_SECRET?.trim() || null;

// Números que NUNCA batem o limite de trial - uso pessoal/família testando
// o bot, não faz sentido pedir pra essas pessoas assinarem. Dá pra
// sobrescrever via variável TESTADORES_ISENTOS no Railway (separado por
// vírgula), mas já vem com um padrão configurado.
const TESTADORES_ISENTOS = (
  process.env.TESTADORES_ISENTOS || '5522999297732,5522998011508,5522998034693'
)
  .split(',')
  .map((n) => n.trim())
  .filter(Boolean);

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
    assinatura: { ativa: false, ativadaEm: null, origem: null },
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
  if (!usuario.assinatura) usuario.assinatura = { ativa: false, ativadaEm: null, origem: null };
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

// Usuário corrigindo a última refeição registrada - tanto quantidade errada
// ("não era 2 ovos, era 1") quanto ingrediente errado ("não tinha repolho")
const REGEX_CORRECAO =
  /\b(na verdade|me enganei|errei|foi engano|não era|nao era|não foi|nao foi|não tinha|nao tinha|não tem|nao tem|corrige|corrigir|esquece,? era|desconsidera,? era|tira o|tira a)\b/i;

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
// Ordem das etapas da entrevista, usada pra poder "voltar" uma etapa se a
// pessoa errou uma resposta anterior.
const ORDEM_ETAPAS = ['objetivo', 'peso', 'altura', 'idade', 'sexo', 'atividade', 'tem_dieta'];

// Usuário pedindo pra voltar/corrigir uma resposta anterior da entrevista
const REGEX_VOLTAR_ETAPA = /^(voltar|corrigir|errei|espera|calma|quero corrigir|volta)\b/i;

function perguntaDaEtapa(etapa) {
  switch (etapa) {
    case 'objetivo':
      return (
        '*Qual é o seu objetivo?*\n' +
        '1️⃣ Emagrecer\n2️⃣ Ganhar massa muscular\n3️⃣ Manter o peso\n' +
        '4️⃣ Só quero registrar o que como (sem meta)\n\nResponde só com o número.'
      );
    case 'peso':
      return '⚖️ Qual é o seu *peso atual* em kg? (ex: 78)';
    case 'altura':
      return '📏 E a sua *altura*? Pode mandar em cm (ex: 175) ou metros (ex: 1,75)';
    case 'idade':
      return '🎂 Qual sua *idade*?';
    case 'sexo':
      return '🚻 *Sexo biológico* (usado só pra calcular seu gasto calórico com mais precisão):\n1️⃣ Masculino\n2️⃣ Feminino';
    case 'atividade':
      return (
        '🏃 Qual seu *nível de atividade física*?\n\n' +
        '1️⃣ Sedentário (pouco ou nenhum exercício)\n' +
        '2️⃣ Leve (exercício 1-3x/semana)\n' +
        '3️⃣ Moderado (exercício 3-5x/semana)\n' +
        '4️⃣ Intenso (exercício 6-7x/semana)\n' +
        '5️⃣ Muito intenso (atleta / 2x ao dia)'
      );
    case 'tem_dieta':
      return (
        '📋 Você já tem uma *dieta pronta* (de nutricionista, por exemplo) que quer usar como meta?\n\n' +
        '1️⃣ Sim, vou mandar uma foto/print dela\n2️⃣ Não, calcula pra mim'
      );
    default:
      return null;
  }
}

async function processarOnboarding(perfil, texto, mensagem) {
  const t = (texto || '').trim();

  // Deixa a pessoa voltar uma etapa se percebeu que errou uma resposta
  // anterior, em vez de precisar refazer a entrevista inteira do zero.
  if (REGEX_VOLTAR_ETAPA.test(t) && perfil.etapa !== 'aguardando_dieta') {
    const indiceAtual = ORDEM_ETAPAS.indexOf(perfil.etapa);
    if (indiceAtual > 0) {
      perfil.etapa = ORDEM_ETAPAS[indiceAtual - 1];
      return { resposta: `🔙 Sem problema! ${perguntaDaEtapa(perfil.etapa)}`, perfil };
    }
    return { resposta: `Você já está na primeira pergunta:\n\n${perguntaDaEtapa(perfil.etapa)}`, perfil };
  }

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
      let altura = parseFloat(t.replace(',', '.').replace(/[^\d.]/g, ''));
      // Se a pessoa mandar em metros (ex: "1,72" ou "1.72"), converte pra cm
      if (altura > 0 && altura < 3) altura = altura * 100;
      if (!altura || altura < 100 || altura > 250) {
        return { resposta: '⚠️ Não entendi. Manda em cm (ex: 175) ou metros (ex: 1,75)', perfil };
      }
      perfil.altura_cm = Math.round(altura);
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
      ? 'Agora é só me mandar foto ou descrição das suas refeições! Use */hoje* pra ver seu progresso, */perfil* pra ver ou refazer suas metas, e */nome* pra trocar como eu te chamo.\n\n' +
        '📸 *Dica pra eu acertar melhor:* quando mandar uma foto, se puder, escreve rapidinho o que tem no prato ' +
        '(ex: "arroz, feijão, um bife pequeno e salada"). Isso ajuda bastante a precisão - e se eu errar algo, ' +
        'só me corrigir (ex: "não tinha repolho" ou "não era 2 ovos, era 1") que eu ajusto na hora.'
      : 'Use */perfil refazer* se quiser preencher tudo de novo.')
  );
}

// ---------- Prompts para a IA ----------

const SYSTEM_PROMPT_REFEICAO = `Você é o NutriZap, um assistente nutricional que analisa refeições descritas
por foto ou texto e estima valores nutricionais.

IMPORTANTE sobre precisão dos ingredientes: nunca invente um ingrediente específico que
você não consegue ver claramente na foto ou que o usuário não mencionou. Se não tiver certeza
sobre um item (ex: qual vegetal exato está numa salada, ou se tem algum tempero específico),
descreva de forma mais genérica (ex: "salada de folhas verdes", "legumes variados") em vez de
nomear um alimento específico que pode estar errado. É sempre melhor ser genérico e correto
do que específico e errado - a pessoa pode corrigir depois se quiser mais precisão.

IMPORTANTE sobre quando PERGUNTAR em vez de estimar: às vezes a incerteza é pequena e não
importa (ex: não saber se é 100g ou 120g de arroz - só estima e segue). Mas às vezes a
incerteza é GRANDE o suficiente pra mudar o resultado de forma relevante (ex: uma bebida que
pode ser água - 0 kcal - ou um suco açucarado - 150+ kcal; ou um prato que pode ter carne ou
ser vegetariano). Nesses casos, marque "duvida_relevante": true e escreva uma pergunta curta e
natural em "pergunta_esclarecimento" pra perguntar pro usuário, em vez de simplesmente chutar
uma das opções. Só use isso quando a diferença for realmente grande - não pergunte por qualquer
imprecisão pequena, senão fica cansativo pro usuário.

Responda SEMPRE em formato JSON puro, sem markdown, sem texto antes ou depois, seguindo
exatamente este formato:

{
  "alimentos": [{"nome": "string", "porcao_estimada": "string"}],
  "calorias_kcal": number,
  "proteina_g": number,
  "carboidrato_g": number,
  "gordura_g": number,
  "confianca": "alta" | "media" | "baixa",
  "duvida_relevante": boolean,
  "pergunta_esclarecimento": "string ou null - só preenche se duvida_relevante for true",
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

// Calcula a data (YYYY-MM-DD) no fuso de Brasília, não em UTC. Sem isso, o
// bot considerava "amanhã" toda vez que alguém registrava uma refeição
// entre 21h e meia-noite (horário de Brasília), porque UTC já tinha virado
// o dia. Usa Intl.DateTimeFormat em vez de só subtrair 3 horas na mão, pra
// lidar sozinho com qualquer mudança de horário de verão que volte a existir.
function dataBrasilia(dataOuTexto) {
  const data = dataOuTexto ? new Date(dataOuTexto) : new Date();
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(data);
}

function calcularTotaisHoje(usuario) {
  const hoje = dataBrasilia();
  const registrosHoje = (usuario.refeicoes || []).filter((r) => dataBrasilia(r.data) === hoje);
  const atividadesHoje = (usuario.atividades || []).filter((a) => dataBrasilia(a.data) === hoje);

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
  return usuario.avisoUsoExcessivoEm === dataBrasilia();
}

async function talvezAvisarUsoExcessivo(numero, usuario) {
  const LIMITE_DIARIO_PARA_AVISO = 8;
  const { registrosHoje } = calcularTotaisHoje(usuario);

  if (registrosHoje.length < LIMITE_DIARIO_PARA_AVISO) return;
  if (jaAvisouUsoExcessivoHoje(usuario)) return;

  usuario.avisoUsoExcessivoEm = dataBrasilia();

  await enviarTexto(
    numero,
    '🌿 Reparei que você já registrou bastante coisa hoje! Se já bateu (ou passou) sua meta, ' +
      'fica tranquilo(a) — não precisa registrar tudo tão certinho pelo resto do dia. ' +
      'Registrar demais também pode virar mais uma fonte de estresse, e não é essa a ideia aqui. 💛'
  );
}

// Verdadeiro quando a pessoa já usou as refeições grátis e ainda não
// assinou. Reaproveita usuario.refeicoes.length como contador - não
// precisa de um campo novo só pra isso. Números em TESTADORES_ISENTOS
// nunca são bloqueados, independente de quantas refeições registrarem.
function passouDoLimiteTeste(usuario, numero) {
  if (usuario.assinatura?.ativa) return false;
  if (TESTADORES_ISENTOS.includes(numero)) return false;
  return usuario.refeicoes.length >= LIMITE_REFEICOES_TESTE;
}

async function avisarLimiteTesteAtingido(numero) {
  const linkOuAviso = CAKTO_CHECKOUT_URL
    ? `assina aqui, é rapidinho:\n${CAKTO_CHECKOUT_URL}`
    : 'me chama que eu te mando o link de assinatura (ainda não está configurado no bot).';

  await enviarTexto(
    numero,
    `🎉 Você já testou o NutriZap de graça (${LIMITE_REFEICOES_TESTE} refeições)!\n\n` +
      `Gostou de ver suas calorias e macros na hora? Pra continuar registrando sem parar, ` +
      `${linkOuAviso}\n\n` +
      `Assim que o pagamento cair, é só voltar a mandar suas refeições normalmente. 🙌`
  );
}

// ---------- Funções que chamam a API oficial da Meta (Graph API) ----------

// Evita bombardear o admin com o mesmo alerta repetido em sequência (ex: se
// a OpenAI cair, cada mensagem de cliente geraria um erro - sem esse
// cooldown, isso viraria uma enxurrada de WhatsApp em poucos minutos).
const ULTIMO_ALERTA_POR_TIPO = new Map();
const COOLDOWN_ALERTA_MS = 15 * 60 * 1000; // 15 minutos

async function notificarAdmin(tipo, detalhes) {
  if (!ADMIN_WHATSAPP_NUMERO) return;

  const agora = Date.now();
  const ultimoEnvio = ULTIMO_ALERTA_POR_TIPO.get(tipo) || 0;
  if (agora - ultimoEnvio < COOLDOWN_ALERTA_MS) return;
  ULTIMO_ALERTA_POR_TIPO.set(tipo, agora);

  try {
    const url = `https://graph.facebook.com/${META_API_VERSION}/${META_PHONE_NUMBER_ID}/messages`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${META_ACCESS_TOKEN}` },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: ADMIN_WHATSAPP_NUMERO,
        type: 'text',
        text: { body: `🚨 *NutriZap - alerta*\n\nTipo: ${tipo}\n${String(detalhes).slice(0, 800)}` },
      }),
    });
  } catch (erro) {
    // Se nem isso funcionar, só loga - não tem mais pra onde escalar daqui
    console.error('Não consegui nem mandar o alerta de erro pro admin:', erro.message);
  }
}

async function enviarTexto(numero, texto) {
  const url = `https://graph.facebook.com/${META_API_VERSION}/${META_PHONE_NUMBER_ID}/messages`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${META_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: numero,
      type: 'text',
      text: { body: texto },
    }),
  });

  if (!resp.ok) {
    const erro = await resp.text();
    console.error('Erro ao enviar mensagem pela Meta Cloud API:', resp.status, erro);
    // Evita loop infinito: só notifica o admin se quem falhou NÃO for o
    // próprio número do admin (senão, se o problema for justo mandar pra
    // ele, essa notificação também falharia pra sempre).
    if (numero !== ADMIN_WHATSAPP_NUMERO) {
      await notificarAdmin('Falha ao enviar mensagem (Meta)', `Status ${resp.status}: ${erro.slice(0, 300)}`);
    }
  }
}

// Meta não manda a imagem já em base64 dentro do webhook (diferente da
// Evolution API) - manda só um "media ID". Precisamos de 2 chamadas: uma pra
// pegar a URL temporária de download, outra pra baixar o arquivo de verdade.
async function baixarMidiaMeta(mediaId) {
  try {
    const infoResp = await fetch(`https://graph.facebook.com/${META_API_VERSION}/${mediaId}`, {
      headers: { Authorization: `Bearer ${META_ACCESS_TOKEN}` },
    });
    const info = await infoResp.json();
    if (!info.url) {
      console.error('Não recebi URL de mídia da Meta:', JSON.stringify(info));
      return null;
    }

    const arquivoResp = await fetch(info.url, {
      headers: { Authorization: `Bearer ${META_ACCESS_TOKEN}` },
    });
    const buffer = Buffer.from(await arquivoResp.arrayBuffer());
    return buffer.toString('base64');
  } catch (erro) {
    console.error('Erro ao baixar mídia da Meta:', erro.message);
    return null;
  }
}

// ---------- Rota que a Meta chama pra VERIFICAR o webhook (só acontece uma
// vez, quando você configura a URL no painel do Facebook Developers) ----------

app.get('/webhook', (req, res) => {
  const modo = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const desafio = req.query['hub.challenge'];

  if (modo === 'subscribe' && token === META_VERIFY_TOKEN) {
    console.log('✅ Webhook verificado com sucesso pela Meta.');
    res.status(200).send(desafio);
  } else {
    console.error('❌ Falha na verificação do webhook - token não bateu.');
    res.sendStatus(403);
  }
});

// ---------- Rota que recebe a confirmação de pagamento da Cakto ----------
//
// 🚧 ESQUELETO - AINDA NÃO TESTADO COM UM PAYLOAD REAL DA CAKTO. 🚧
//
// Ainda não temos o produto/checkout criado lá, então não sei o formato
// exato que a Cakto manda. O que precisa acontecer antes de confiar nessa
// rota de verdade:
//   1. Criar o produto e o checkout no painel da Cakto
//   2. Configurar um webhook lá apontando pra:
//      https://SEU-DOMINIO-RAILWAY/webhook/cakto
//   3. Fazer uma compra de teste (ou usar o "testar webhook" deles, se tiver)
//   4. Copiar o JSON exato que chegou aqui e me mandar - eu ajusto os nomes
//      de campo abaixo (hoje estou tentando alguns nomes prováveis, mas
//      pode não bater exatamente com o que a Cakto realmente envia)
//   5. Confirmar como a Cakto manda o "segredo" do webhook pra validar que a
//      chamada é legítima (header customizado? query string? assinatura
//      HMAC no corpo? cada plataforma faz diferente)
//
// Até isso estar confirmado, o jeito seguro de liberar cliente é o comando
// manual */liberar 5522999999999* que já está funcionando.

app.post('/webhook/cakto', async (req, res) => {
  try {
    // Validação básica de segredo compartilhado - AJUSTAR quando soubermos
    // como a Cakto realmente manda essa validação (pode não ser um header
    // "x-webhook-secret", isso é só um palpite razoável por enquanto).
    if (CAKTO_WEBHOOK_SECRET && req.headers['x-webhook-secret'] !== CAKTO_WEBHOOK_SECRET) {
      console.error('❌ Webhook da Cakto rejeitado - segredo não bateu.');
      return res.sendStatus(401);
    }

    const body = req.body || {};
    console.log('📦 Payload recebido em /webhook/cakto:', JSON.stringify(body));

    // Só processa se for um evento de pagamento aprovado. O nome exato do
    // campo de status/evento PRECISA ser confirmado com um payload real.
    const status = body?.event || body?.status || body?.data?.status;
    const statusIndicaPago = /aprovad|paid|approved|pago/i.test(status || '');
    if (!statusIndicaPago) {
      console.log(`ℹ️  Evento da Cakto ignorado (status: "${status}") - não parece pagamento aprovado.`);
      return res.sendStatus(200);
    }

    // Tenta achar o telefone do cliente em alguns caminhos prováveis do
    // JSON. Isso também precisa ser confirmado/ajustado com o payload real -
    // o telefone só vai vir se o campo de telefone existir no checkout e a
    // pessoa preencher com o mesmo número que usa no WhatsApp do bot.
    const telefoneBruto =
      body?.data?.customer?.phone ||
      body?.customer?.phone ||
      body?.data?.phone ||
      body?.phone ||
      null;
    const numeroCliente = telefoneBruto ? String(telefoneBruto).replace(/\D/g, '') : null;

    if (!numeroCliente) {
      console.error('❌ Não achei o telefone do cliente no payload da Cakto - não dá pra liberar automaticamente.');
      await notificarAdmin(
        'Pagamento Cakto sem telefone identificável',
        'Um pagamento chegou no webhook, mas não consegui achar o número de telefone no JSON. Confira o log do Railway e libere manualmente com /liberar.'
      );
      return res.sendStatus(200);
    }

    const usuarioAlvo = await carregarUsuario(numeroCliente);
    usuarioAlvo.assinatura = { ativa: true, ativadaEm: new Date().toISOString(), origem: 'cakto' };
    await salvarUsuario(numeroCliente, usuarioAlvo);

    await enviarTexto(
      numeroCliente,
      '✅ Pagamento confirmado! Sua assinatura do NutriZap está ativa - pode continuar mandando suas refeições normalmente. 🎉'
    );

    res.sendStatus(200);
  } catch (erro) {
    console.error('Erro processando webhook da Cakto:', erro.message);
    await notificarAdmin('Erro no webhook da Cakto', erro.message || String(erro));
    res.sendStatus(200); // sempre 200 pra Cakto não ficar reenviando em loop
  }
});

// ---------- Rota que recebe os eventos de mensagem da Meta (webhook) ----------

app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // responde rápido pra Meta não ficar esperando

  try {
    const body = req.body;

    // A Meta manda vários tipos de evento no mesmo webhook (mensagem nova,
    // status de entrega, etc). Só nos interessa quando tem mensagem de
    // verdade dentro de "changes[0].value.messages".
    const valor = body?.entry?.[0]?.changes?.[0]?.value;
    const msgMeta = valor?.messages?.[0];
    if (!msgMeta) return; // provavelmente é só um status update ("lido", "entregue") - ignora

    const numero = msgMeta.from; // número já vem só com dígitos, ex: "5522999999999"

    // Baixa a imagem ANTES de montar o adaptador, se for o caso (a Meta só
    // manda um "media ID" no webhook, não a imagem em si)
    let imagemBase64Meta = null;
    if (msgMeta.type === 'image') {
      imagemBase64Meta = await baixarMidiaMeta(msgMeta.image.id);
    }

    // Monta um "mensagem" e um "dados" no MESMO formato que o resto do
    // código já usava com a Evolution API, pra não precisar reescrever toda
    // a lógica de negócio - só essa camada de tradução muda.
    const mensagem = {};
    if (msgMeta.type === 'text') {
      mensagem.conversation = msgMeta.text.body;
    } else if (msgMeta.type === 'image') {
      mensagem.imageMessage = {
        caption: msgMeta.image.caption || '',
        mimetype: msgMeta.image.mime_type || 'image/jpeg',
      };
    } else if (msgMeta.type === 'audio') {
      mensagem.audioMessage = {};
    }

    const dados = {
      pushName: valor?.contacts?.[0]?.profile?.name || null,
      message: { base64: imagemBase64Meta },
      key: { fromMe: false, remoteJid: numero },
    };

    const textoRecebido =
      mensagem.conversation ||
      mensagem.extendedTextMessage?.text ||
      mensagem.imageMessage?.caption ||
      '';

    const comandoBruto = textoRecebido.trim();
    const comando = comandoBruto.toLowerCase();

    // Comando ADMIN (só funciona se a mensagem vier do seu próprio número
    // pessoal, configurado em ADMIN_WHATSAPP_NUMERO) - libera manualmente um
    // cliente que pagou, sem precisar esperar o webhook da Cakto estar
    // pronto. Uso: /liberar 5522999999999
    if (ADMIN_WHATSAPP_NUMERO && numero === ADMIN_WHATSAPP_NUMERO && comando.startsWith('/liberar')) {
      const numeroAlvo = comandoBruto.slice('/liberar'.length).trim().replace(/\D/g, '');
      if (!numeroAlvo) {
        await enviarTexto(numero, '⚠️ Uso: */liberar 5522999999999* (número completo, só dígitos)');
      } else {
        const usuarioAlvo = await carregarUsuario(numeroAlvo);
        usuarioAlvo.assinatura = { ativa: true, ativadaEm: new Date().toISOString(), origem: 'manual' };
        await salvarUsuario(numeroAlvo, usuarioAlvo);
        await enviarTexto(numero, `✅ Assinatura liberada manualmente pra *${numeroAlvo}*.`);
      }
      return;
    }

    const usuario = await carregarUsuario(numero);
    const perfil = usuario.perfil;
    capturarNome(perfil, dados);

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

    // Trocar o nome que o bot usa pra chamar a pessoa (útil quando o nome do
    // WhatsApp é uma frase/apelido, tipo "Jesus me ama", em vez do nome real)
    if (comando.startsWith('/nome')) {
      const novoNome = textoRecebido.trim().slice(5).trim(); // tira o "/nome" preservando maiúsculas
      if (!novoNome) {
        await enviarTexto(
          numero,
          `Seu nome atual é: *${perfil.nome || 'não configurado'}*.\n\nPra trocar, manda */nome SeuNome* (ex: */nome Mateus*)`
        );
      } else {
        perfil.nome = novoNome.split(' ')[0]; // guarda só o primeiro nome, como já fazemos com o pushName
        await enviarTexto(numero, `✅ Prontinho! Agora vou te chamar de *${perfil.nome}*.`);
      }
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
          '*/perfil refazer* - refazer a entrevista inicial\n' +
          '*/nome SeuNome* - trocar como eu te chamo\n\n' +
          `_Você pode registrar ${LIMITE_REFEICOES_TESTE} refeições grátis antes de assinar._`
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

    // Trava do trial grátis: se já bateu o limite de refeições e ainda não
    // assinou, para aqui e manda o link de pagamento em vez de gastar outra
    // chamada de IA. Fica ANTES de tudo que analisa refeição nova, mas os
    // comandos de sempre (/hoje, /perfil, /nome, /ajuda) já responderam lá
    // em cima e nem chegam aqui.
    if (passouDoLimiteTeste(usuario, numero)) {
      await avisarLimiteTesteAtingido(numero);
      await salvarUsuario(numero, usuario);
      return;
    }

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

    // Resposta a uma pergunta de esclarecimento que ficou pendente (ex: "é
    // água ou suco?" depois de uma foto ambígua de bebida)
    if (usuario.aguardandoEsclarecimento) {
      const { contextoAnterior, perguntaFeita } = usuario.aguardandoEsclarecimento;
      usuario.aguardandoEsclarecimento = null;

      const contexto =
        `Você tinha perguntado: "${perguntaFeita}" sobre uma refeição/bebida (itens identificados ` +
        `até agora: ${contextoAnterior}). O usuário respondeu: "${textoRecebido}". Finalize a análise ` +
        `nutricional completa considerando essa resposta e retorne o JSON.`;

      const analiseFinal = await chamarIA({ systemPrompt: SYSTEM_PROMPT_REFEICAO, texto: contexto });
      if (analiseFinal) usuario.refeicoes.push({ data: new Date().toISOString(), analise: analiseFinal });
      await enviarTexto(numero, formatarResposta(analiseFinal));
      if (analiseFinal) await talvezAvisarUsoExcessivo(numero, usuario);
      await salvarUsuario(numero, usuario);
      return;
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

    // A IA identificou uma dúvida grande o suficiente pra mudar o resultado
    // (ex: "é água ou suco?") - pergunta em vez de chutar e registrar errado.
    if (analise?.duvida_relevante && analise?.pergunta_esclarecimento) {
      usuario.aguardandoEsclarecimento = {
        contextoAnterior: JSON.stringify(analise.alimentos || []),
        perguntaFeita: analise.pergunta_esclarecimento,
      };
      await enviarTexto(numero, `🤔 ${analise.pergunta_esclarecimento}`);
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
    await notificarAdmin('Erro processando mensagem', erro.message || String(erro));
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
      // Serve tanto pra confirmar deploy quanto como o aviso de "voltei ao
      // ar" depois de qualquer crash/reinício.
      notificarAdmin('Bot iniciado', `NutriZap subiu e está rodando na porta ${PORT}.`);
    });
  })
  .catch(async (erro) => {
    console.error('\n❌ Não consegui conectar/preparar o banco de dados Postgres:', erro.message);
    console.error('Confere se a variável DATABASE_URL está certa nas Variables do Railway.\n');
    await notificarAdmin('Falha ao iniciar - banco de dados', erro.message || String(erro));
    process.exit(1);
  });
