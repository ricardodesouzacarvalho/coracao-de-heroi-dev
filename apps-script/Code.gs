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
