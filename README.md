# Programa Coração de Herói — PROMIS Global Health / PREMs (piloto)

Coleta longitudinal de desfechos relatados (PROMIS Global Health), experiência (PREMs),
adesão medicamentosa e tabagismo dos bombeiros militares do CBMERJ, com dashboard
gerencial vinculado. Modelo VBHC · 1ª Policlínica – Campinho.

## Arquivos

| Arquivo | Descrição |
|---|---|
| `index.html` | Formulário público (marcos 0/90/180/270 dias após a Inspeção de Saúde). Grava no Google Sheets via Apps Script. |
| `dashboard.html` | Dashboard gerencial com **acesso restrito por chave** (tela "Acesso restrito"). Inclui modo demonstração: `dashboard.html?demo=1`. |
| `apps-script/Code.gs` | Backend do Google Apps Script: gravação com carimbo de servidor, deduplicação sob lock, `check`/`ping` públicos e `data` protegido por token. |
| `relatorios/` | Relatórios de análise técnica (v1 e v2) que orientaram as correções. |

## Configuração do backend (obrigatória para o dashboard)

1. Abra a planilha de respostas → **Extensões → Apps Script** e substitua o código por `apps-script/Code.gs`.
2. Em **Configurações do projeto → Propriedades do script**, crie:
   - `DASH_TOKEN` = chave longa e aleatória (será a chave digitada pela equipe no dashboard).
3. **Implantar → Gerenciar implantações → Editar → Nova versão**
   (Executar como: você · Acesso: qualquer pessoa — o `action=data` é protegido pelo token).
4. Ajuste `SHEET_NAME` no `Code.gs` se a aba não se chamar `Respostas`.

> **Importante:** enquanto o `Code.gs` novo não for implantado, a implantação antiga do
> Apps Script continua respondendo ao GET com a planilha completa — o vazamento descrito
> no achado D1 do relatório. A implantação do novo código é o que efetivamente fecha o acesso.

## Segurança e LGPD — estado atual

- ✅ Leitura de dados (`action=data`) exige token; o dashboard pede a chave e a guarda apenas na sessão do navegador (`sessionStorage`).
- ✅ Nenhum token ou segredo está versionado neste repositório.
- ✅ Rascunho local do formulário não persiste identificadores no dispositivo.
- ✅ Campo de confirmação do RG não é gravado na planilha.
- ⚠️ O `action=check` (deduplicação do formulário público) permanece aberto por necessidade do fluxo: revela apenas se um RG já respondeu um marco. Mitigação futura: consultar por hash (SHA-256 + sal) e/ou migrar para código de convite pseudonimizado.
- ⚠️ O RG segue como identificador por compatibilidade com a planilha atual; a migração para código pseudonimizado está recomendada para produção.

## Principais decisões técnicas

- **Escores PROMIS calculados exclusivamente no servidor** (`apps-script/Code.gs`): recodificação da dor, somas brutas e T-score pela tabela oficial (HealthMeasures) são computados na gravação, sobrescrevendo qualquer valor vindo do cliente. Formulário e dashboard não contêm tabelas de escore — fonte única, sem risco de divergência. Ressalva: os itens 1, 2 e 6 têm redação adaptada localmente pendente de validação metodológica.
  - **Consequência operacional:** o `Code.gs` atualizado precisa estar implantado ("Nova versão" na implantação existente) ANTES de qualquer coleta; sem ele, as respostas são gravadas sem escore e o dashboard exibirá essas linhas sem T-score.
- Envio confiável: `POST` em `no-cors` seguido de confirmação ativa (`action=check`) — a tela de sucesso só aparece após o Apps Script localizar a resposta.
- Deduplicação dupla: pré-check no cliente + verificação sob lock no servidor.
- Dashboard: evolução transversal por marco **e** evolução pareada por participante (delta de T-score do mesmo RG entre marcos); indicador de janelas calculado sobre toda a base, independente do filtro.
- Dashboard: evolução pareada com fluxo estatístico adaptativo (Shapiro-Wilk decide entre teste t pareado e Wilcoxon; Holm-Bonferroni para multiplicidade), validado contra o scipy.

## Desenvolvimento local

```bash
python3 -m http.server 8011
# http://127.0.0.1:8011/index.html
# http://127.0.0.1:8011/dashboard.html?demo=1
```
