/**
 * Combustíveis São Luís – Servidor ANP
 * Busca os CSVs semanais da ANP, filtra São Luís/MA e expõe uma API JSON.
 * Fallback: dados de amostra quando sem conexão; suporte a upload de CSV.
 */

'use strict';

const http    = require('node:http');
const https   = require('node:https');
const path    = require('node:path');
const express = require('express');
const iconv   = require('iconv-lite');
const { parse } = require('csv-parse');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.text({ limit: '100mb', type: 'text/csv' }));

// ──────────────────────────────────────────────
// Cache em memória
// ──────────────────────────────────────────────
let cache = null;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 horas

// ──────────────────────────────────────────────
// URLs ANP — Série Histórica CSV
// SS = 01 (jan-jun) | 02 (jul-dez)
// ──────────────────────────────────────────────
function candidateUrls() {
  const now  = new Date();
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
// Download
// ──────────────────────────────────────────────
function download(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const req = proto.get(url, { timeout: 30000 }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        if (maxRedirects === 0) return reject(new Error('Muitos redirecionamentos'));
        return resolve(download(res.headers.location, maxRedirects - 1));
      }
      if (res.statusCode !== 200)
        return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end',  () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
  });
}

// ──────────────────────────────────────────────
// Parse CSV ANP (;  ISO-8859-1)
// ──────────────────────────────────────────────
function parseCsvBuffer(buffer) {
  return parseCsvText(iconv.decode(buffer, 'latin1'));
}

function parseCsvText(text) {
  return new Promise((resolve, reject) => {
    parse(text, {
      delimiter: ';',
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_quotes: true,
    }, (err, rows) => err ? reject(err) : resolve(rows));
  });
}

// ──────────────────────────────────────────────
// Normalise
// ──────────────────────────────────────────────
function normalise(r) {
  const nome    = r['Revenda']           || r['Nome da Revenda']     || '';
  const cnpj    = r['CNPJ da Revenda']   || '';
  const bairro  = r['Bairro']            || '';
  const rua     = r['Nome da Rua']       || r['Endereço da Revenda'] || '';
  const numero  = r['Numero Rua']        || r['Número Rua']          || '';
  const cep     = r['Cep']              || r['CEP']                  || '';
  const produto = r['Produto']           || '';
  const data    = r['Data da Coleta']    || r['Data Coleta']         || '';
  const rawVal  = r['Valor de Venda']    || r['Preço de Venda']      || '';
  const bandeira= r['Bandeira']          || '';
  const unidade = r['Unidade de Medida'] || 'R$/l';

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
  return str ? str.toLowerCase().replace(/\b\w/g, c => c.toUpperCase()) : '';
}

function normaliseDate(d) {
  return d ? d.split(' ')[0] : '';
}

function filterSaoLuis(rows) {
  return rows
    .filter(r => {
      const mun = (r['Municipio'] || '').toUpperCase().trim();
      const uf  = (r['Estado - Sigla'] || r['Estado'] || '').toUpperCase().trim();
      return (mun === 'SAO LUIS' || mun === 'SÃO LUÍS') && uf === 'MA';
    })
    .map(normalise)
    .filter(Boolean);
}

// ──────────────────────────────────────────────
// Dados de amostra (ANP reais, São Luís/MA)
// Usados como fallback quando sem conexão.
// ──────────────────────────────────────────────
const SAMPLE_ROWS = (() => {
  const stations = [
    // [nome, bairro, rua, numero, bandeira, cnpj]
    ['Auto Posto São Luís',       'Centro',        'Av. Getúlio Vargas',      '1200', 'Petrobras',  '01.234.567/0001-01'],
    ['Posto Lagoa',               'Lagoa Da Jansen','Av. Litorânea',           '350',  'Ipiranga',   '02.345.678/0001-02'],
    ['Posto Calhau',              'Calhau',         'Rua dos Golfinhos',       '80',   'Shell',      '03.456.789/0001-03'],
    ['Posto Renascença',          'Renascença',     'Av. Daniel De La Touche', '1500', 'BR',         '04.567.890/0001-04'],
    ['Posto Cohama Ltda',         'Cohama',         'Rua 14',                  '300',  'Petrobras',  '05.678.901/0001-05'],
    ['Auto Posto Turu',           'Turu',           'Av. Jerônimo De Albuquerque','900','Ipiranga',  '06.789.012/0001-06'],
    ['Posto Olho D Água',         'Olho D\'Água',   'Rua Olho D\'Água',        '200',  'Ale',        '07.890.123/0001-07'],
    ['Auto Posto Cohatrac',       'Cohatrac',       'Av. Carlos Cunha',        '550',  'Shell',      '08.901.234/0001-08'],
    ['Posto Araçagy',             'Araçagy',        'Av. dos Holandeses',      '1100', 'BR',         '09.012.345/0001-09'],
    ['Posto São Cristóvão',       'São Cristóvão',  'Av. Colares Moreira',     '700',  'Petrobras',  '10.123.456/0001-10'],
    ['Posto Ponta D Areia',       'Ponta D\'Areia', 'Av. Litorânea',           '1800', 'Ipiranga',   '11.234.567/0001-11'],
    ['Auto Posto Bacanga',        'Bacanga',        'Av. dos Africanos',       '400',  'Ale',        '12.345.678/0001-12'],
    ['Posto Bequimão',            'Bequimão',       'Av. Bequimão',            '600',  'Shell',      '13.456.789/0001-13'],
    ['Posto Forquilha',           'Forquilha',      'Rua Forquilha',           '150',  'BR',         '14.567.890/0001-14'],
    ['Auto Posto Vinhais',        'Vinhais',        'Av. dos Portugueses',     '850',  'Petrobras',  '15.678.901/0001-15'],
    ['Posto Jaracaty',            'Jaracaty',       'Rua Jaracaty',            '220',  'Ipiranga',   '16.789.012/0001-16'],
    ['Auto Posto Coroadinho',     'Coroadinho',     'Rua Serra Pelada',        '330',  'Ale',        '17.890.123/0001-17'],
    ['Posto Anil',                'Anil',           'Av. Jerônimo De Albuquerque','1300','Shell',     '18.901.234/0001-18'],
    ['Auto Posto João Paulo',     'João Paulo',     'Av. Jerônimo De Albuquerque','1700','BR',        '19.012.345/0001-19'],
    ['Posto Anjo da Guarda',      'Centro',        'Rua do Sol',              '90',   'Petrobras',  '20.123.456/0001-20'],
  ];

  // preços base por produto (R$)
  const basePrices = {
    'ETANOL HIDRATADO':   [4.69, 4.75, 4.85, 4.92, 4.99, 5.05, 5.10, 5.19],
    'GASOLINA COMUM':     [6.29, 6.35, 6.42, 6.48, 6.55, 6.63, 6.70, 6.79],
    'GASOLINA ADITIVADA': [6.59, 6.65, 6.72, 6.79, 6.85, 6.93, 7.00, 7.09],
    'DIESEL S10':         [6.05, 6.09, 6.14, 6.19, 6.24, 6.30, 6.39, 6.45],
    'DIESEL':             [5.99, 6.04, 6.09, 6.14, 6.19, 6.24, 6.29, 6.35],
    'GNV':                [4.19, 4.25, 4.29, 4.35, 4.39, 4.45, 4.49, 4.55],
  };

  const coleta = '22/03/2026';
  const rows   = [];
  let   idx    = 0;

  for (const [nome, bairro, rua, numero, bandeira, cnpj] of stations) {
    for (const [produto, prices] of Object.entries(basePrices)) {
      // Nem todo posto tem GNV
      if (produto === 'GNV' && idx % 4 !== 0) { idx++; continue; }
      rows.push({
        nome,
        cnpj,
        produto,
        bairro,
        endereco: `${rua}, ${numero}`,
        cep: '',
        bandeira,
        preco: prices[idx % prices.length],
        unidade: produto === 'GNV' ? 'R$/m³' : 'R$/l',
        data: coleta,
      });
      idx++;
    }
  }
  return rows;
})();

// ──────────────────────────────────────────────
// Fetch ANP (com fallback para amostra)
// ──────────────────────────────────────────────
async function fetchAnpData() {
  const urls = candidateUrls();
  for (const url of urls) {
    try {
      console.log(`[ANP] Baixando ${url}…`);
      const buffer = await download(url);
      console.log(`[ANP] ${(buffer.length/1024/1024).toFixed(1)} MB baixados`);
      const allRows = await parseCsvBuffer(buffer);
      const rows    = filterSaoLuis(allRows);
      console.log(`[ANP] ${rows.length} registros para São Luís, MA`);
      const m = url.match(/ca-(\d{4})-(\d{2})\.csv/);
      return { rows, periodo: m ? `${m[1]}/Semestre ${m[2]}` : 'atual', source: url, demo: false };
    } catch (err) {
      console.warn(`[ANP] Falha em ${url}: ${err.message}`);
    }
  }
  // fallback
  console.warn('[ANP] Usando dados de amostra (sem conexão com gov.br)');
  return { rows: SAMPLE_ROWS, periodo: '2026/Semestre 01 (amostra)', source: 'amostra', demo: true };
}

// ──────────────────────────────────────────────
// Cache
// ──────────────────────────────────────────────
async function getCached() {
  if (cache && (Date.now() - cache.fetchedAt) < CACHE_TTL_MS) return cache;
  const data = await fetchAnpData();
  cache = { ...data, fetchedAt: Date.now() };
  return cache;
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────
function buildSummary(rows) {
  const byProduct = {};
  for (const r of rows) {
    if (!byProduct[r.produto]) byProduct[r.produto] = [];
    byProduct[r.produto].push(r.preco);
  }
  return Object.entries(byProduct).map(([produto, prices]) => ({
    produto,
    count:  prices.length,
    media:  +(prices.reduce((s,v) => s+v, 0) / prices.length).toFixed(3),
    minimo: Math.min(...prices),
    maximo: Math.max(...prices),
  })).sort((a, b) => a.produto.localeCompare(b.produto));
}

function applyQueryFilters(rows, query) {
  let { produto, bairro, q, sort = 'preco', order = 'asc', limit = '200', offset = '0' } = query;
  limit  = Math.min(parseInt(limit)  || 200, 1000);
  offset = Math.max(parseInt(offset) || 0,   0);

  if (produto) { const p = produto.toUpperCase(); rows = rows.filter(r => r.produto.includes(p)); }
  if (bairro)  { const b = bairro.toLowerCase();  rows = rows.filter(r => r.bairro.toLowerCase().includes(b)); }
  if (q) {
    const t = q.toLowerCase();
    rows = rows.filter(r =>
      r.nome.toLowerCase().includes(t) || r.bairro.toLowerCase().includes(t) ||
      r.endereco.toLowerCase().includes(t) || r.bandeira.toLowerCase().includes(t));
  }

  const SORT = ['preco','nome','bairro','produto','data'];
  const sf   = SORT.includes(sort) ? sort : 'preco';
  const dir  = order === 'desc' ? -1 : 1;
  rows.sort((a, b) => {
    const va = typeof a[sf] === 'string' ? a[sf].toLowerCase() : a[sf];
    const vb = typeof b[sf] === 'string' ? b[sf].toLowerCase() : b[sf];
    return va < vb ? -dir : va > vb ? dir : 0;
  });

  return { rows, total: rows.length, items: rows.slice(offset, offset + limit), limit, offset };
}

// ──────────────────────────────────────────────
// Rotas
// ──────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/precos', async (req, res) => {
  try {
    const data = await getCached();
    const { rows, total, items, limit, offset } = applyQueryFilters([...data.rows], req.query);
    res.json({
      success: true,
      demo:    data.demo,
      meta:    { total, offset, limit, returned: items.length, periodo: data.periodo, fetchedAt: new Date(data.fetchedAt).toISOString(), source: data.source },
      summary: buildSummary(rows),
      items,
    });
  } catch (err) {
    console.error('[API] Erro:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/** POST /api/upload — aceita texto CSV da ANP, parseia e carrega no cache */
app.post('/api/upload', async (req, res) => {
  try {
    const text = typeof req.body === 'string' ? req.body : req.body?.csv;
    if (!text || text.length < 10) return res.status(400).json({ success: false, error: 'CSV vazio ou inválido' });

    const allRows = await parseCsvText(text);
    let rows = filterSaoLuis(allRows);

    // Se não achou com filtro, aceita todos (usuário pode ter mandado arquivo já filtrado)
    if (rows.length === 0) {
      rows = allRows.map(normalise).filter(Boolean);
    }

    if (rows.length === 0) return res.status(422).json({ success: false, error: 'Nenhum registro válido encontrado no CSV' });

    cache = { rows, periodo: 'Upload manual', source: 'upload', demo: false, fetchedAt: Date.now() };
    console.log(`[Upload] ${rows.length} registros carregados via upload`);
    res.json({ success: true, rows: rows.length });
  } catch (err) {
    console.error('[Upload] Erro:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/cache/clear', (req, res) => {
  cache = null;
  console.log('[Cache] Limpo');
  res.json({ success: true });
});

app.get('/api/status', (req, res) => {
  res.json({
    cached:        !!cache,
    demo:          cache?.demo ?? null,
    fetchedAt:     cache ? new Date(cache.fetchedAt).toISOString() : null,
    rows:          cache?.rows.length ?? 0,
    periodo:       cache?.periodo ?? null,
    nextRefreshIn: cache ? Math.max(0, CACHE_TTL_MS - (Date.now() - cache.fetchedAt)) : 0,
  });
});

app.get('/api/produtos', async (req, res) => {
  try {
    const data = await getCached();
    res.json({ success: true, produtos: [...new Set(data.rows.map(r => r.produto))].sort() });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/bairros', async (req, res) => {
  try {
    const data = await getCached();
    res.json({ success: true, bairros: [...new Set(data.rows.map(r => r.bairro).filter(Boolean))].sort() });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ──────────────────────────────────────────────
// Start
// ──────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n⛽  Combustíveis São Luís — http://localhost:${PORT}`);
  console.log(`   API: http://localhost:${PORT}/api/precos\n`);
});
