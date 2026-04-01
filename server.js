/**
 * Combustíveis São Luís – Servidor ANP
 * Busca os CSVs semanais da ANP, filtra São Luís/MA e expõe uma API JSON.
 */

'use strict';

const http    = require('node:http');
const https   = require('node:https');
const path    = require('node:path');
const fs      = require('node:fs');
const express = require('express');
const iconv   = require('iconv-lite');
const { parse } = require('csv-parse');

const app  = express();
const PORT = process.env.PORT || 3000;

// ──────────────────────────────────────────────
// Cache em memória
// ──────────────────────────────────────────────
let cache = null;           // { rows, fetchedAt, periodo }
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;  // 6 horas

// ──────────────────────────────────────────────
// Fontes ANP — Série Histórica de Preços (CSV)
// A ANP disponibiliza arquivos por semestre em:
// https://www.gov.br/anp/.../dados-abertos/arquivos/shpc/ca/ca-YYYY-SS.csv
// SS = 01 (jan-jun) ou 02 (jul-dez)
// ──────────────────────────────────────────────
function candidateUrls() {
  const now = new Date();
  const year = now.getFullYear();
  const sem  = now.getMonth() < 6 ? '01' : '02';
  const prevYear = year - (sem === '01' ? 1 : 0);
  const prevSem  = sem === '01' ? '02' : '01';

  const base = 'https://www.gov.br/anp/pt-br/centrais-de-conteudo/dados-abertos/arquivos/shpc/ca';
  return [
    `${base}/ca-${year}-${sem}.csv`,
    `${base}/ca-${prevYear}-${prevSem}.csv`,
  ];
}

// ──────────────────────────────────────────────
// Download com redirect e timeout
// ──────────────────────────────────────────────
function download(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const req = proto.get(url, { timeout: 30000 }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        if (maxRedirects === 0) return reject(new Error('Muitos redirecionamentos'));
        return resolve(download(res.headers.location, maxRedirects - 1));
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} ao baixar ${url}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout ao baixar ${url}`)); });
    req.on('error', reject);
  });
}

// ──────────────────────────────────────────────
// Parse CSV da ANP (separador: ponto-e-vírgula, encoding: ISO-8859-1)
// ──────────────────────────────────────────────
function parseCsv(buffer) {
  return new Promise((resolve, reject) => {
    const text = iconv.decode(buffer, 'latin1');
    parse(text, {
      delimiter: ';',
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_quotes: true,
    }, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// ──────────────────────────────────────────────
// Normaliza um registro ANP → objeto limpo
// ──────────────────────────────────────────────
function normalise(r) {
  const nome    = r['Revenda']          || r['Nome da Revenda']        || '';
  const cnpj    = r['CNPJ da Revenda']  || '';
  const bairro  = r['Bairro']           || '';
  const rua     = r['Nome da Rua']      || r['Endereço da Revenda']    || '';
  const numero  = r['Numero Rua']       || r['Número Rua']             || '';
  const cep     = r['Cep']              || r['CEP']                    || '';
  const produto = r['Produto']          || '';
  const data    = r['Data da Coleta']   || r['Data Coleta']            || '';
  const rawVal  = r['Valor de Venda']   || r['Preço de Venda']         || '';
  const bandeira= r['Bandeira']         || '';
  const unidade = r['Unidade de Medida']|| 'R$/l';

  const preco = parseFloat(rawVal.replace(',', '.')) || 0;
  if (preco <= 0) return null;

  return {
    nome,
    cnpj,
    produto: produto.toUpperCase().trim(),
    bairro: toTitleCase(bairro),
    endereco: [toTitleCase(rua), numero].filter(Boolean).join(', '),
    cep,
    bandeira: toTitleCase(bandeira),
    preco,
    unidade,
    data: normaliseDate(data),
  };
}

function toTitleCase(str) {
  if (!str) return '';
  return str.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

function normaliseDate(d) {
  if (!d) return '';
  // "dd/mm/yyyy hh:mm:ss" → "dd/mm/yyyy"
  return d.split(' ')[0];
}

// ──────────────────────────────────────────────
// Busca + processa dados da ANP
// ──────────────────────────────────────────────
async function fetchAnpData() {
  const urls   = candidateUrls();
  let   buffer = null;
  let   usedUrl = '';

  for (const url of urls) {
    try {
      console.log(`[ANP] Baixando ${url}...`);
      buffer  = await download(url);
      usedUrl = url;
      console.log(`[ANP] Baixado ${(buffer.length / 1024 / 1024).toFixed(1)} MB`);
      break;
    } catch (err) {
      console.warn(`[ANP] Falha em ${url}: ${err.message}`);
    }
  }

  if (!buffer) throw new Error('Não foi possível baixar nenhum arquivo da ANP. Tente novamente mais tarde.');

  console.log('[ANP] Parseando CSV…');
  const allRows = await parseCsv(buffer);

  // Filtra São Luís / MA
  const rows = allRows
    .filter(r => {
      const mun = (r['Municipio'] || '').toUpperCase();
      const uf  = (r['Estado - Sigla'] || r['Estado'] || '').toUpperCase();
      return mun === 'SAO LUIS' && uf === 'MA';
    })
    .map(normalise)
    .filter(Boolean);

  console.log(`[ANP] ${rows.length} registros para São Luís, MA`);

  // Período a partir do nome do arquivo
  const m = usedUrl.match(/ca-(\d{4})-(\d{2})\.csv/);
  const periodo = m ? `${m[1]}/Semestre ${m[2]}` : 'atual';

  return { rows, periodo, source: usedUrl };
}

// ──────────────────────────────────────────────
// Cache helper
// ──────────────────────────────────────────────
async function getCached() {
  if (cache && (Date.now() - cache.fetchedAt) < CACHE_TTL_MS) {
    return cache;
  }
  const { rows, periodo, source } = await fetchAnpData();
  cache = { rows, periodo, source, fetchedAt: Date.now() };
  return cache;
}

// ──────────────────────────────────────────────
// Rotas
// ──────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

/**
 * GET /api/precos
 *  ?produto=ETANOL HIDRATADO   (filtra por produto, parcial, case-insensitive)
 *  ?bairro=Centro              (filtra por bairro, parcial)
 *  ?q=texto                    (busca em nome, bairro, endereço)
 *  ?sort=preco|nome|data       (ordenação, default: preco)
 *  ?order=asc|desc             (default: asc)
 *  ?limit=100                  (default: 200, max: 1000)
 *  ?offset=0
 */
app.get('/api/precos', async (req, res) => {
  try {
    const data = await getCached();
    let rows = [...data.rows];

    // Filtros
    const { produto, bairro, q, sort = 'preco', order = 'asc' } = req.query;
    let { limit = '200', offset = '0' } = req.query;
    limit  = Math.min(parseInt(limit)  || 200, 1000);
    offset = Math.max(parseInt(offset) || 0,   0);

    if (produto) {
      const p = produto.toUpperCase();
      rows = rows.filter(r => r.produto.includes(p));
    }
    if (bairro) {
      const b = bairro.toLowerCase();
      rows = rows.filter(r => r.bairro.toLowerCase().includes(b));
    }
    if (q) {
      const t = q.toLowerCase();
      rows = rows.filter(r =>
        r.nome.toLowerCase().includes(t) ||
        r.bairro.toLowerCase().includes(t) ||
        r.endereco.toLowerCase().includes(t) ||
        r.bandeira.toLowerCase().includes(t)
      );
    }

    // Ordenação
    const SORT_FIELDS = ['preco', 'nome', 'bairro', 'produto', 'data'];
    const sortField = SORT_FIELDS.includes(sort) ? sort : 'preco';
    const dir = order === 'desc' ? -1 : 1;
    rows.sort((a, b) => {
      const va = a[sortField], vb = b[sortField];
      if (va < vb) return -dir;
      if (va > vb) return  dir;
      return 0;
    });

    // Resumo por produto
    const summary = buildSummary(rows);

    // Paginação
    const total = rows.length;
    const items = rows.slice(offset, offset + limit);

    res.json({
      success: true,
      meta: {
        total,
        offset,
        limit,
        returned: items.length,
        periodo: data.periodo,
        fetchedAt: new Date(data.fetchedAt).toISOString(),
        source: data.source,
      },
      summary,
      items,
    });
  } catch (err) {
    console.error('[API] Erro:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/** POST /api/cache/clear — invalida o cache (força novo download na ANP) */
app.post('/api/cache/clear', (req, res) => {
  cache = null;
  console.log('[Cache] Limpo manualmente via API');
  res.json({ success: true, message: 'Cache limpo. Próxima requisição fará download da ANP.' });
});

/** GET /api/status — verifica cache */
app.get('/api/status', (req, res) => {
  res.json({
    cached: !!cache,
    fetchedAt: cache ? new Date(cache.fetchedAt).toISOString() : null,
    rows: cache?.rows.length ?? 0,
    periodo: cache?.periodo ?? null,
    nextRefreshIn: cache
      ? Math.max(0, CACHE_TTL_MS - (Date.now() - cache.fetchedAt))
      : 0,
  });
});

/** GET /api/produtos — lista produtos disponíveis */
app.get('/api/produtos', async (req, res) => {
  try {
    const data = await getCached();
    const produtos = [...new Set(data.rows.map(r => r.produto))].sort();
    res.json({ success: true, produtos });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** GET /api/bairros — lista bairros disponíveis */
app.get('/api/bairros', async (req, res) => {
  try {
    const data = await getCached();
    const bairros = [...new Set(data.rows.map(r => r.bairro).filter(Boolean))].sort();
    res.json({ success: true, bairros });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────
function buildSummary(rows) {
  const byProduct = {};
  for (const r of rows) {
    if (!byProduct[r.produto]) byProduct[r.produto] = [];
    byProduct[r.produto].push(r.preco);
  }
  return Object.entries(byProduct).map(([produto, prices]) => {
    const avg = prices.reduce((s, v) => s + v, 0) / prices.length;
    return {
      produto,
      count: prices.length,
      media: +avg.toFixed(3),
      minimo: Math.min(...prices),
      maximo: Math.max(...prices),
    };
  }).sort((a, b) => a.produto.localeCompare(b.produto));
}

// ──────────────────────────────────────────────
// Start
// ──────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n⛽  Combustíveis São Luís — http://localhost:${PORT}`);
  console.log(`   API: http://localhost:${PORT}/api/precos\n`);
});
