# Programa Coração de Herói — PROMIS Global Health / PREMs (piloto)

Coleta longitudinal de desfechos relatados (PROMIS Global Health), experiência (PREMs),
adesão medicamentosa e tabagismo dos bombeiros militares do CBMERJ, com dashboard
gerencial vinculado. Modelo VBHC · 1ª Policlínica – Campinho.

## Arquivos

| Arquivo | Descrição |
|---|---|
| `index.html` | Formulário público (marcos 0/90/180/270 dias após a Inspeção de Saúde). Grava no Google Sheets via Apps Script. |
| `dashboard.html` | Dashboard gerencial com **acesso restrito por chave** (tela "Acesso restrito"). Inclui modo demonstração: `dashboard.html?demo=1`. |
| `apps-script/Code.gs` | Backend do Google Apps Script: gravação com carimbo de servidor, data oficial da Inspeção (aba `Inspecoes`), confirmação de envio por id, `ping` público e `data` protegido por token. |
| `relatorios/` | Relatórios de análise técnica (v1 e v2) que orientaram as correções. |

## Configuração do backend (obrigatória para o dashboard)

1. Abra a planilha de respostas → **Extensões → Apps Script** e substitua o código por `apps-script/Code.gs`.
2. Em **Configurações do projeto → Propriedades do script**, crie:
   - `DASH_TOKEN` = chave longa e aleatória (será a chave digitada pela equipe no dashboard).
3. **Implantar → Gerenciar implantações → Editar → Nova versão**
   (Executar como: você · Acesso: qualquer pessoa — o `action=data` é protegido pelo token).
4. Ajuste `SHEET_NAME` no `Code.gs` se a aba não se chamar `Respostas`.
5. Crie a aba `Inspecoes` (colunas `rg_cbmerj` | `data_inspecao`, data em `AAAA-MM-DD`) na
   planilha do piloto e rode uma vez `corrigirInspecoesExistentes()` no editor do Apps Script.

> **Importante:** enquanto o `Code.gs` novo não for implantado, a implantação antiga do
> Apps Script continua respondendo ao GET com a planilha completa — o vazamento descrito
> no achado D1 do relatório. A implantação do novo código é o que efetivamente fecha o acesso.

## Regras de coleta (iguais às de produção desde 15/10/2026)

### Janelas dos marcos

| Marco | Janela (dias desde a Inspeção) |
|---|---|
| Inicial | 0–21 |
| 90 dias | 50–130 (±40) |
| 180 dias | 140–220 (±40) |
| 270 dias | 230–310 (±40) |
| Fora dos marcos | vãos (22–49, 131–139, 221–229) ou após 310 dias |

Essas são as janelas de **coleta** (gravadas pelo formulário e pelo `Code.gs`). O dashboard
reclassifica pelo dia real com as janelas de **análise**: Inicial 0–60, 90 dias 61–130,
180 dias 140–220 e 270 dias 230–310. A evolução pareada compara todos os pares de marcos
(Inicial → 90, 180 e 270; 90 → 180 e 270; 180 → 270), com Holm-Bonferroni sobre a tabela.

### Data oficial da Inspeção

Para RGs da aba `Inspecoes`, o `Code.gs` substitui a data digitada pela oficial, recalcula
`dias_desde_inspecao` e o marco e guarda a digitada em `data_inspecao_informada`
(`data_inspecao_fonte` registra a origem). `corrigirInspecoesExistentes()` aplica a regra às
respostas já gravadas, com backup automático da aba. A lista RG → data é dado pessoal de saúde:
fica **somente** na planilha, nunca neste repositório nem nos HTML.

### Programa fechado nos RGs da lista

RG fora da aba `Inspecoes` é tratado como erro: a resposta é gravada com `rg_no_programa` = `Não`,
o formulário avisa o participante (após o envio) e pede contato pelo WhatsApp (21) 99278-9615, e o
dashboard exclui a resposta das análises e a lista em **Auditoria · RGs fora do programa**.

### Controle de envio do formulário

Seção do dashboard com os militares na janela de resposta (aba `Inspecoes`) e os que entram
nela em até 14 dias, com mensagem individualizada aberta no WhatsApp ou no e-mail, registro do
envio na aba `Envios` (`action=envio`, exige token) e baixa automática quando a resposta chega.
Requer a aba `Contatos` na planilha do piloto. Contatos são dados pessoais: ficam **somente** na
planilha, nunca neste repositório.

O `Code.gs` também traz o **e-mail automático** (convite + até 2 lembretes por marco, intervalo
de 3 dias, execução diária às 8h; ver README da produção). No piloto, antes de ativar com
`instalarEnvioAutomatico()`,
crie a propriedade do script `FORM_URL` com o link do formulário do piloto
(`https://ricardodesouzacarvalho.github.io/coracao-de-heroi-dev/`) e use apenas contatos de teste.

### Respostas repetidas

Não há bloqueio: o mesmo RG pode responder mais de uma vez o mesmo marco. Nas estatísticas do
dashboard vale a primeira resposta de cada RG por marco; as seguintes ficam contadas no resumo do
gráfico e continuam na triagem assistencial.

## Segurança e LGPD — estado atual

- ✅ Leitura de dados (`action=data`) exige token; o dashboard pede a chave e a guarda apenas na sessão do navegador (`sessionStorage`).
- ✅ Nenhum token ou segredo está versionado neste repositório.
- ✅ Rascunho local do formulário não persiste identificadores no dispositivo.
- ✅ Campo de confirmação do RG não é gravado na planilha.
- ✅ A confirmação de envio usa um identificador aleatório do envio (`action=check&envio=…`), sem RG.
- ⚠️ A consulta legada `action=check&rg=…&marco=…` permanece apenas para formulários antigos em cache: revela se um RG já respondeu um marco. Pode ser removida após a transição.
- ⚠️ O RG segue como identificador por compatibilidade com a planilha atual; a migração para código pseudonimizado está recomendada para produção.

## Principais decisões técnicas

- **Escores PROMIS calculados exclusivamente no servidor** (`apps-script/Code.gs`): recodificação da dor, somas brutas e T-score pela tabela oficial (HealthMeasures) são computados na gravação, sobrescrevendo qualquer valor vindo do cliente. Formulário e dashboard não contêm tabelas de escore — fonte única, sem risco de divergência. Ressalva: os itens 1, 2 e 6 têm redação adaptada localmente pendente de validação metodológica.
  - **Consequência operacional:** o `Code.gs` atualizado precisa estar implantado ("Nova versão" na implantação existente) ANTES de qualquer coleta; sem ele, as respostas são gravadas sem escore e o dashboard exibirá essas linhas sem T-score.
- Envio confiável: `POST` em `no-cors` seguido de confirmação ativa pelo id do envio (`action=check&envio=…`) — a tela de sucesso só aparece após o Apps Script localizar a resposta e mostra o marco registrado pelo servidor. Com Apps Script anterior, cai para a consulta legada.
- Dashboard: evolução transversal por marco **e** evolução pareada por participante (delta de T-score do mesmo RG entre marcos); indicador de janelas calculado sobre toda a base, independente do filtro.
- Dashboard: evolução pareada com fluxo estatístico adaptativo (Shapiro-Wilk decide entre teste t pareado e Wilcoxon; Holm-Bonferroni para multiplicidade), validado contra o scipy.

## Desenvolvimento local

```bash
python3 -m http.server 8011
# http://127.0.0.1:8011/index.html
# http://127.0.0.1:8011/dashboard.html?demo=1
```
