/**
 * Programa Coração de Herói — PROMIS Global Health / PREMs
 * Backend Google Apps Script (Web App)
 *
 * AÇÕES GET (JSONP, parâmetro callback):
 *   ?action=ping                     → aquecimento / teste de disponibilidade
 *   ?action=check&rg=…&marco=…       → deduplicação usada pelo formulário público
 *   ?action=data&token=…             → dados completos para o dashboard (EXIGE TOKEN)
 *   qualquer outra ação              → erro (fecha o vazamento do GET aberto)
 *
 * POST (JSON): grava uma resposta com carimbo de servidor e deduplicação
 * por rg_cbmerj + marco_programa sob lock (evita corrida entre dispositivos).
 *
 * CONFIGURAÇÃO OBRIGATÓRIA:
 * 1. Extensões > Apps Script da planilha de respostas: substitua o código por este arquivo.
 * 2. Configurações do projeto > Propriedades do script: crie a propriedade
 *      DASH_TOKEN = <chave de acesso do dashboard, longa e aleatória>
 *    (é a chave que a equipe digitará na tela "Acesso restrito" do dashboard).
 * 3. Implantar > Gerenciar implantações > Editar > Nova versão
 *    ("Executar como: você" · "Quem pode acessar: qualquer pessoa" — o token protege o action=data).
 * 4. Ajuste SHEET_NAME abaixo se a aba de respostas tiver outro nome.
 */

var SHEET_NAME = 'Respostas';

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

function doGet(e) {
  var action = String((e && e.parameter && e.parameter.action) || '').toLowerCase();

  if (action === 'ping') {
    return output_(e, { ok: true, pong: new Date().toISOString() });
  }

  if (action === 'check') {
    var rg = normRg_(e.parameter.rg);
    var marco = String(e.parameter.marco || '');
    if (!rg) return output_(e, { error: 'rg_invalido' });
    return output_(e, { duplicado: findDuplicate_(rg, marco) });
  }

  if (action === 'data') {
    var expected = PropertiesService.getScriptProperties().getProperty('DASH_TOKEN');
    var token = String(e.parameter.token || '');
    if (!expected || !token || token !== expected) {
      return output_(e, { error: 'unauthorized' });
    }
    return output_(e, { ok: true, values: sheet_().getDataRange().getValues() });
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

    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      if (payload.rg_cbmerj && payload.marco_programa &&
          findDuplicate_(payload.rg_cbmerj, payload.marco_programa)) {
        return output_(e, { ok: false, duplicado: true });
      }
      appendRow_(payload);
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
