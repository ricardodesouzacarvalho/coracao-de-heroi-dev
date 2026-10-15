/**
 * Programa Coração de Herói — PROMIS Global Health / PREMs
 * Backend Google Apps Script (Web App)
 *
 * AÇÕES GET (JSONP, parâmetro callback):
 *   ?action=ping                     → aquecimento / teste de disponibilidade
 *   ?action=check&envio=…            → confirma a gravação de um envio (id gerado pelo formulário)
 *   ?action=check&rg=…&marco=…       → legado (formulários antigos em cache): RG já respondeu o marco?
 *   ?action=data&token=…             → dados completos para o dashboard (EXIGE TOKEN):
 *                                      respostas, datas oficiais, contatos e envios
 *   ?action=envio&token=…&rg=…&marco=…&canal=…  → registra o envio do convite (EXIGE TOKEN)
 *   qualquer outra ação              → erro (fecha o vazamento do GET aberto)
 *
 * POST (JSON): grava uma resposta com carimbo de servidor. Não há bloqueio de respostas
 * repetidas: o mesmo RG pode responder mais de uma vez o mesmo marco (o dashboard usa a
 * primeira de cada RG por marco nas estatísticas).
 *
 * CONFIGURAÇÃO OBRIGATÓRIA:
 * 1. Extensões > Apps Script da planilha de respostas: substitua o código por este arquivo.
 * 2. Configurações do projeto > Propriedades do script: crie a propriedade
 *      DASH_TOKEN = <chave de acesso do dashboard, longa e aleatória>
 *    (é a chave que a equipe digitará na tela "Acesso restrito" do dashboard).
 * 3. Implantar > Gerenciar implantações > Editar > Nova versão
 *    ("Executar como: você" · "Quem pode acessar: qualquer pessoa" — o token protege o action=data).
 * 4. Ajuste SHEET_NAME abaixo se a aba de respostas tiver outro nome.
 * 5. Datas oficiais de Inspeção: crie na MESMA planilha a aba INSPECOES_SHEET (abaixo) com
 *    as colunas rg_cbmerj | data_inspecao (uma linha por RG; data em AAAA-MM-DD ou célula
 *    de data). A lista fica só na planilha — NUNCA no repositório público nem nos HTML.
 *    Para corrigir as respostas já gravadas, rode uma vez corrigirInspecoesExistentes().
 * 6. Contatos dos militares (para o controle de envio do dashboard): aba CONTATOS_SHEET com o
 *    cabeçalho RG | Nome | Posto/Graduação | Telefone_WhatsApp | Link_WhatsApp | E-mail | Observação.
 *    Dados pessoais: ficam só na planilha e só saem pelo action=data, que exige o token.
 *    A aba ENVIOS_SHEET é criada automaticamente no primeiro envio registrado.
 */

var SHEET_NAME = 'Respostas';
var INSPECOES_SHEET = 'Inspecoes';
var CONTATOS_SHEET = 'Contatos';
var ENVIOS_SHEET = 'Envios';

/* ---- Escore PROMIS Global Health: FONTE ÚNICA ----
 * Tabelas oficiais HealthMeasures (v1.2) de conversão do escore bruto (4-20) em T-score.
 * O formulário e o dashboard NÃO calculam escore: todo registro é pontuado aqui,
 * no momento da gravação. Alterações de tabela/fórmula acontecem apenas neste arquivo. */
var PHYSICAL_T = {4:16.2,5:19.9,6:23.5,7:26.7,8:29.6,9:32.4,10:34.9,11:37.4,12:39.8,13:42.3,14:44.9,15:47.7,16:50.8,17:54.1,18:57.7,19:61.9,20:67.7};
var MENTAL_T   = {4:21.2,5:25.1,6:28.4,7:31.3,8:33.8,9:36.3,10:38.8,11:41.1,12:43.5,13:45.8,14:48.3,15:50.8,16:53.3,17:56.0,18:59.0,19:62.5,20:67.6};
var SCORING_VERSION = 'PROMIS Global Health v1.2 - tabela HealthMeasures; itens 1, 2 e 6 com redação adaptada localmente (escore calculado no servidor)';

function num_(v) {
  var n = parseFloat(String(v === null || v === undefined ? '' : v).replace(',', '.'));
  return isFinite(n) ? n : null;
}

/* Recodificação oficial do item 7 (dor 0-10): 0→5, 1-3→4, 4-6→3, 7-9→2, 10→1 */
function painRecode_(v) {
  var n = num_(v);
  if (n === null) return null;
  return n === 0 ? 5 : n <= 3 ? 4 : n <= 6 ? 3 : n <= 9 ? 2 : 1;
}

function sumComplete_(vals) {
  var total = 0;
  for (var i = 0; i < vals.length; i++) {
    if (vals[i] === null || !isFinite(vals[i])) return null;
    total += vals[i];
  }
  return total;
}

/* Calcula e grava no payload: dor recodificada, somas brutas (físico = itens 3+6+7r+8;
 * mental = itens 2+4+5+10) e T-scores pela tabela oficial. Sobrescreve qualquer valor
 * que o cliente tenha enviado nesses campos. */
function computeScores_(payload) {
  var pain = painRecode_(payload.promis_global07);
  var physRaw = sumComplete_([num_(payload.promis_global03), num_(payload.promis_global06), pain, num_(payload.promis_global08)]);
  var mentRaw = sumComplete_([num_(payload.promis_global02), num_(payload.promis_global04), num_(payload.promis_global05), num_(payload.promis_global10)]);
  payload.promis_global07_recodificado = pain === null ? '' : pain;
  payload.promis_global_fisica_bruto = physRaw === null ? '' : physRaw;
  payload.promis_global_mental_bruto = mentRaw === null ? '' : mentRaw;
  payload.promis_global_fisica_tscore = physRaw === null || PHYSICAL_T[Math.round(physRaw)] === undefined ? '' : PHYSICAL_T[Math.round(physRaw)];
  payload.promis_global_mental_tscore = mentRaw === null || MENTAL_T[Math.round(mentRaw)] === undefined ? '' : MENTAL_T[Math.round(mentRaw)];
  payload.promis_scoring_version = SCORING_VERSION;
  payload.promis_tscore_status = 'Estimado pela tabela oficial; redação adaptada requer validação metodológica';
}

function sheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) sh = ss.insertSheet(SHEET_NAME);
  return sh;
}

function normRg_(value) {
  return String(value || '').replace(/\D/g, '');
}

/* ---- Programa fechado nos RGs da lista ----
 * Com a aba INSPECOES_SHEET preenchida, um RG que não consta dela é tratado como erro de
 * digitação ou participante fora do programa: a resposta é gravada com rg_no_programa = 'Não'
 * (para auditoria), o dashboard a exclui das análises e o formulário orienta o participante
 * a contatar a equipe pelo WhatsApp. Sem a aba (ou vazia), nenhum RG é marcado. */

/* ---- Data oficial da Inspeção de Saúde ----
 * Quando o RG consta da aba INSPECOES_SHEET, a data de referência substitui a informada
 * pelo participante (que fica preservada em data_inspecao_informada), e os dias desde a
 * Inspeção e o marco são recalculados aqui. Torna o marco temporal independente da
 * memória do participante. RGs fora da lista seguem com a data informada no formulário. */
var FONTE_REFERENCIA = 'Referência (Inspeção oficial)';
var FONTE_INFORMADA = 'Informada pelo participante';

function tz_() {
  return SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone() || 'America/Sao_Paulo';
}

/** Converte célula/texto de data em 'AAAA-MM-DD' (fuso da planilha); null se inválido. */
function ymd_(v) {
  if (v === null || v === undefined || v === '') return null;
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return isNaN(v.getTime()) ? null : Utilities.formatDate(v, tz_(), 'yyyy-MM-dd');
  }
  var s = String(v).trim(), m;
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/))) return m[1] + '-' + m[2] + '-' + m[3];
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/))) {
    return m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
  }
  var d = new Date(s); // ISO com hora (ex.: registrado_em_servidor)
  return isNaN(d.getTime()) ? null : Utilities.formatDate(d, tz_(), 'yyyy-MM-dd');
}

function daysBetween_(fromYmd, toYmd) {
  var a = fromYmd.split('-'), b = toYmd.split('-');
  return Math.round((Date.UTC(+b[0], b[1] - 1, +b[2]) - Date.UTC(+a[0], a[1] - 1, +a[2])) / 86400000);
}

/** Mesmas janelas de updatePeriod() no index.html — manter as duas em sincronia. */
function marcoFromDays_(days) {
  var r;
  if (days < 0) r = ['Antes da Inspeção de referência', 'Antes da Inspeção', 'Antes da Inspeção', false];
  else if (days <= 21) r = ['Inicial', '0-21 dias', '0 dias', true];
  else if (days <= 49) r = ['Entre marcos inicial e 90 dias', '22-49 dias', '22 dias', false];
  else if (days <= 130) r = ['90 dias', '50-130 dias', '90 dias', true];
  else if (days <= 139) r = ['Entre marcos 90 e 180 dias', '131-139 dias', '131 dias', false];
  else if (days <= 220) r = ['180 dias', '140-220 dias', '180 dias', true];
  else if (days <= 229) r = ['Entre marcos 180 e 270 dias', '221-229 dias', '221 dias', false];
  else if (days <= 310) r = ['270 dias', '230-310 dias', '270 dias', true];
  else r = ['Após 270 dias', 'Mais de 310 dias', '311 dias', false];
  return {
    dias_desde_inspecao: days,
    momento_avaliacao: r[0],
    estrato_dias: r[1],
    marco_programa: r[2],
    marco_programa_bruto: r[0] + ' | ' + r[1],
    janela_aplicacao_recomendada: r[3] ? 'Sim' : 'Não'
  };
}

var inspecoesCache_ = null;
/** Mapa RG → 'AAAA-MM-DD' lido da aba INSPECOES_SHEET (vazio se a aba não existir). */
function inspecoesRef_() {
  if (inspecoesCache_) return inspecoesCache_;
  var map = {};
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(INSPECOES_SHEET);
  if (sh && sh.getLastRow() > 0) {
    var values = sh.getDataRange().getValues();
    for (var r = 0; r < values.length; r++) {
      var rg = normRg_(values[r][0]), d = ymd_(values[r][1]);
      if (rg && d) map[rg] = d; // linha de cabeçalho é ignorada (sem RG/data válidos)
    }
  }
  inspecoesCache_ = map;
  return map;
}

function todayYmd_() {
  return Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd');
}

/** Aplica a data de referência ao registro (payload ou linha). answerYmd = dia da resposta.
 *  Devolve true se o RG constava da lista de referência. */
function applyInspecaoRef_(rec, answerYmd) {
  var map = inspecoesRef_();
  var ref = map[normRg_(rec.rg_cbmerj)];
  if (!ref) {
    if (!rec.data_inspecao_fonte) rec.data_inspecao_fonte = FONTE_INFORMADA;
    if (Object.keys(map).length) rec.rg_no_programa = 'Não';
    return false;
  }
  rec.rg_no_programa = 'Sim';
  if (rec.data_inspecao_informada === undefined || rec.data_inspecao_informada === '') {
    rec.data_inspecao_informada = ymd_(rec.data_inspecao) || String(rec.data_inspecao || '');
  }
  rec.data_inspecao = ref;
  rec.data_inspecao_fonte = FONTE_REFERENCIA;
  if (answerYmd) {
    var m = marcoFromDays_(daysBetween_(ref, answerYmd));
    for (var k in m) rec[k] = m[k];
  }
  return true;
}

/** Resposta em JSONP quando há callback; JSON puro caso contrário. */
function output_(e, obj) {
  var body = JSON.stringify(obj);
  var cb = e && e.parameter && e.parameter.callback;
  if (cb && /^[\w.]+$/.test(cb)) {
    return ContentService.createTextOutput(cb + '(' + body + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(body).setMimeType(ContentService.MimeType.JSON);
}

function findDuplicate_(rg, marco) {
  var sh = sheet_();
  if (sh.getLastRow() < 2) return false;
  var values = sh.getDataRange().getValues();
  var head = values[0];
  var iRg = head.indexOf('rg_cbmerj');
  var iMarco = head.indexOf('marco_programa');
  if (iRg < 0 || iMarco < 0) return false;
  for (var r = 1; r < values.length; r++) {
    if (normRg_(values[r][iRg]) === rg &&
        String(values[r][iMarco]).trim() === String(marco).trim()) return true;
  }
  return false;
}

/** Localiza um envio pelo id gerado no formulário; devolve a linha como objeto ou null. */
function findEnvio_(id) {
  var sh = sheet_();
  if (!id || sh.getLastRow() < 2) return null;
  var values = sh.getDataRange().getValues();
  var head = values[0];
  var iId = head.indexOf('id_envio');
  if (iId < 0) return null;
  for (var r = values.length - 1; r >= 1; r--) {
    if (String(values[r][iId]) === id) {
      var rec = {};
      head.forEach(function (k, i) { rec[k] = values[r][i]; });
      return rec;
    }
  }
  return null;
}

function cleanEnvio_(v) {
  var s = String(v || '');
  return /^[\w-]{8,64}$/.test(s) ? s : '';
}

function tokenOk_(e) {
  var expected = PropertiesService.getScriptProperties().getProperty('DASH_TOKEN');
  var token = String((e && e.parameter && e.parameter.token) || '');
  return Boolean(expected && token && token === expected);
}

/** Valores de uma aba auxiliar (vazio se a aba não existir). Datas viram texto ISO. */
function abaValores_(nome) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(nome);
  if (!sh || sh.getLastRow() === 0) return [];
  return sh.getDataRange().getValues().map(function (row) {
    return row.map(function (v) {
      return Object.prototype.toString.call(v) === '[object Date]' ? v.toISOString() : v;
    });
  });
}

function doGet(e) {
  var action = String((e && e.parameter && e.parameter.action) || '').toLowerCase();

  if (action === 'ping') {
    return output_(e, { ok: true, pong: new Date().toISOString() });
  }

  if (action === 'check' && e.parameter.envio !== undefined) {
    // Confirmação de gravação por id do envio: só quem enviou conhece o id, então devolver
    // o marco registrado (calculado pela data oficial, quando houver) não expõe terceiros.
    var envio = cleanEnvio_(e.parameter.envio);
    if (!envio) return output_(e, { error: 'envio_invalido' });
    var found = findEnvio_(envio);
    if (!found) return output_(e, { gravado: false });
    return output_(e, {
      gravado: true,
      momento: String(found.momento_avaliacao || found.marco_programa || ''),
      rg_no_programa: String(found.rg_no_programa || '') !== 'Não'
    });
  }

  if (action === 'check') {
    var rg = normRg_(e.parameter.rg);
    var marco = String(e.parameter.marco || '');
    if (!rg) return output_(e, { error: 'rg_invalido' });
    // RG com data oficial: o marco é o calculado pela referência (o mesmo que o POST grava),
    // não o derivado da data digitada. A resposta continua sendo apenas duplicado: sim/não.
    var refCheck = { rg_cbmerj: rg };
    if (applyInspecaoRef_(refCheck, todayYmd_())) marco = refCheck.marco_programa;
    return output_(e, { duplicado: findDuplicate_(rg, marco) });
  }

  if (action === 'data') {
    if (!tokenOk_(e)) return output_(e, { error: 'unauthorized' });
    var ref = inspecoesRef_();
    return output_(e, {
      ok: true,
      values: sheet_().getDataRange().getValues(),
      inspecoes: Object.keys(ref).map(function (rg) { return [rg, ref[rg]]; }),
      contatos: abaValores_(CONTATOS_SHEET),
      envios: abaValores_(ENVIOS_SHEET)
    });
  }

  if (action === 'envio') {
    // Registro do envio do convite pelo controle do dashboard (quem, qual marco, qual canal).
    if (!tokenOk_(e)) return output_(e, { error: 'unauthorized' });
    var rgEnvio = normRg_(e.parameter.rg);
    var marcoEnvio = String(e.parameter.marco || '').slice(0, 40);
    var canal = String(e.parameter.canal || '').toLowerCase();
    if (!rgEnvio || !marcoEnvio || ['whatsapp', 'email'].indexOf(canal) < 0) {
      return output_(e, { error: 'parametros_invalidos' });
    }
    var quando = new Date().toISOString();
    var lockEnvio = LockService.getScriptLock();
    lockEnvio.waitLock(20000);
    try {
      var ss = SpreadsheetApp.getActiveSpreadsheet();
      var sh = ss.getSheetByName(ENVIOS_SHEET) || ss.insertSheet(ENVIOS_SHEET);
      if (sh.getLastRow() === 0) sh.appendRow(['registrado_em', 'rg_cbmerj', 'marco', 'canal']);
      sh.appendRow([quando, rgEnvio, marcoEnvio, canal]);
    } finally {
      lockEnvio.releaseLock();
    }
    return output_(e, { ok: true, registrado_em: quando });
  }

  // Nenhuma outra ação expõe dados: fecha o GET aberto apontado na análise (D1/C3).
  return output_(e, { error: 'acao_desconhecida' });
}

function doPost(e) {
  try {
    var payload = JSON.parse(e.postData.contents);
    payload.rg_cbmerj = normRg_(payload.rg_cbmerj);
    delete payload.rg_cbmerj_confirmacao; // nunca gravar o campo de confirmação
    payload.registrado_em_servidor = new Date().toISOString(); // carimbo confiável (relógio do servidor)
    computeScores_(payload); // fonte única do escore PROMIS (sobrescreve o que vier do cliente)
    applyInspecaoRef_(payload, todayYmd_()); // data oficial da Inspeção, quando o RG está na lista
    payload.id_envio = cleanEnvio_(payload.id_envio);

    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      appendRow_(payload); // sem bloqueio de repetição (decisão de 15/10/2026)
    } finally {
      lock.releaseLock();
    }
    return output_(e, { ok: true });
  } catch (err) {
    return output_(e, { ok: false, error: String(err) });
  }
}

/** Grava alinhando pelo cabeçalho; cria colunas novas automaticamente. */
function appendRow_(payload) {
  var sh = sheet_();
  var head;
  if (sh.getLastRow() === 0) {
    head = Object.keys(payload);
    sh.appendRow(head);
  } else {
    head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    var missing = Object.keys(payload).filter(function (k) { return head.indexOf(k) < 0; });
    if (missing.length) {
      sh.getRange(1, head.length + 1, 1, missing.length).setValues([missing]);
      head = head.concat(missing);
    }
  }
  sh.appendRow(head.map(function (k) {
    var v = payload[k];
    return v === undefined ? '' : v;
  }));
}

/**
 * Rodar UMA VEZ pelo editor do Apps Script (selecionar a função > Executar) depois de
 * criar a aba INSPECOES_SHEET. Aplica a data oficial às respostas já gravadas, recalculando
 * dias e marco a partir do dia em que cada resposta foi registrada. Antes de alterar,
 * copia a aba de respostas para um backup. Pode ser repetida sem efeito colateral.
 * O resumo sai em Execuções/Registros (Logger).
 */
function corrigirInspecoesExistentes() {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = sheet_();
    if (sh.getLastRow() < 2) { Logger.log('Sem respostas para corrigir.'); return; }
    if (!Object.keys(inspecoesRef_()).length) {
      Logger.log('Aba "' + INSPECOES_SHEET + '" ausente ou vazia: nada foi alterado.');
      return;
    }
    var backup = sh.copyTo(ss);
    backup.setName(SHEET_NAME + '_backup_' + Utilities.formatDate(new Date(), tz_(), 'yyyyMMdd_HHmmss'));

    var values = sh.getDataRange().getValues();
    var head = values[0].slice();
    ['data_inspecao_informada', 'data_inspecao_fonte', 'rg_no_programa'].forEach(function (k) {
      if (head.indexOf(k) < 0) head.push(k);
    });
    var stats = { comReferencia: 0, semReferencia: 0, marcoAlterado: 0, antesDaInspecao: 0, semDataResposta: 0 };
    var seen = {}, repetidas = [];
    /* Só estas colunas são regravadas; todas as outras células ficam exatamente como estavam
       (inclusive colunas com cabeçalho vazio ou repetido, que não podem ser lidas por nome). */
    var CAMPOS = ['data_inspecao', 'data_inspecao_informada', 'data_inspecao_fonte', 'rg_no_programa',
      'dias_desde_inspecao', 'momento_avaliacao', 'estrato_dias', 'marco_programa',
      'marco_programa_bruto', 'janela_aplicacao_recomendada'];
    var out = [head];
    for (var r = 1; r < values.length; r++) {
      var rec = {};
      head.forEach(function (k, i) {
        if (k !== '' && !(k in rec)) rec[k] = i < values[r].length ? values[r][i] : '';
      });
      var antes = String(rec.marco_programa);
      var answerYmd = ymd_(rec.registrado_em_servidor) || ymd_(rec.carimbo_iso) || ymd_(rec.carimbo_data_hora);
      if (!answerYmd) stats.semDataResposta++;
      if (applyInspecaoRef_(rec, answerYmd)) {
        stats.comReferencia++;
        if (String(rec.marco_programa) !== antes) stats.marcoAlterado++;
        if (Number(rec.dias_desde_inspecao) < 0) stats.antesDaInspecao++;
      } else {
        stats.semReferencia++;
      }
      var key = normRg_(rec.rg_cbmerj) + '|' + String(rec.marco_programa).trim();
      if (normRg_(rec.rg_cbmerj)) {
        if (seen[key]) repetidas.push('linha ' + (r + 1) + ' repete a linha ' + seen[key] + ' (RG •••' + normRg_(rec.rg_cbmerj).slice(-3) + ', marco ' + rec.marco_programa + ')');
        else seen[key] = r + 1;
      }
      var linha = head.map(function (k, i) { return i < values[r].length ? values[r][i] : ''; });
      CAMPOS.forEach(function (k) {
        var i = head.indexOf(k);
        if (i >= 0 && rec[k] !== undefined) linha[i] = rec[k];
      });
      out.push(linha);
    }
    sh.getRange(1, 1, out.length, head.length).setValues(out);
    Logger.log('Backup criado na aba: ' + backup.getName());
    Logger.log('Respostas com data oficial aplicada: ' + stats.comReferencia + ' (marco alterado em ' + stats.marcoAlterado + ')');
    Logger.log('Respostas de RGs fora da lista (rg_no_programa = Não; excluídas das análises e listadas na auditoria do dashboard): ' + stats.semReferencia);
    if (stats.antesDaInspecao) Logger.log('ATENÇÃO: ' + stats.antesDaInspecao + ' resposta(s) registradas ANTES da data oficial — marcadas como "Antes da Inspeção de referência".');
    if (stats.semDataResposta) Logger.log('ATENÇÃO: ' + stats.semDataResposta + ' resposta(s) sem data de registro — data oficial gravada, dias e marco não recalculados.');
    if (repetidas.length) Logger.log('Mesmo RG com mais de uma resposta no mesmo marco após a correção (aceito; nada foi apagado; nas estatísticas do dashboard vale a primeira):\n' + repetidas.join('\n'));
  } finally {
    lock.releaseLock();
  }
}
