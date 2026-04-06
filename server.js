/**
 * Combustíveis São Luís – Servidor ANP
 * Busca os CSVs semanais da ANP, filtra São Luís/MA e expõe uma API JSON.
 * Fallback: dados de amostra; suporte a GPS e upload de CSV.
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
// Cache
// ──────────────────────────────────────────────
let cache = null;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

// ──────────────────────────────────────────────
// URLs ANP — descobre dinamicamente na página de dados abertos
// ──────────────────────────────────────────────
async function candidateUrls() {
  const base = 'https://www.gov.br/anp/pt-br/centrais-de-conteudo/dados-abertos/arquivos/shpc/ca';

  // Tenta descobrir URLs reais raspando a página de dados abertos da ANP
  try {
    const html = (await download(
      'https://www.gov.br/anp/pt-br/centrais-de-conteudo/dados-abertos/serie-historica-de-precos-de-combustiveis'
    )).toString('utf8');

    // Extrai todos os links para arquivos ca-YYYY-SS.csv
    const matches = [...html.matchAll(/href="([^"]*ca-\d{4}-\d{2}\.csv[^"]*)"/gi)]
      .map(m => {
        let u = m[1];
        if (u.startsWith('/')) u = 'https://www.gov.br' + u;
        return u;
      });

    if (matches.length > 0) {
      // Ordena do mais recente para o mais antigo
      matches.sort((a, b) => b.localeCompare(a));
      console.log(`[ANP] Encontradas ${matches.length} URLs na página:`, matches.slice(0, 2));
      return matches.slice(0, 3);
    }
  } catch (err) {
    console.warn('[ANP] Não foi possível raspar a página:', err.message);
  }

  // Fallback: constrói URLs pelo semestre atual e anterior
  const now  = new Date();
  const year = now.getFullYear();
  const sem  = now.getMonth() < 6 ? '01' : '02';
  const prevYear = year - (sem === '01' ? 1 : 0);
  const prevSem  = sem === '01' ? '02' : '01';
  return [
    `${base}/ca-${year}-${sem}.csv`,
    `${base}/ca-${prevYear}-${prevSem}.csv`,
  ];
}

// ──────────────────────────────────────────────
// Download
// ──────────────────────────────────────────────
function download(url, maxRedirects = 5, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const req = proto.get(url, { timeout: timeoutMs }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        if (maxRedirects === 0) return reject(new Error('Muitos redirecionamentos'));
        return resolve(download(res.headers.location, maxRedirects - 1, timeoutMs));
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
// CSV parse
// ──────────────────────────────────────────────
function parseCsvBuffer(buffer) {
  return parseCsvText(iconv.decode(buffer, 'latin1'));
}
function parseCsvText(text) {
  return new Promise((resolve, reject) => {
    parse(text, { delimiter:';', columns:true, skip_empty_lines:true, trim:true, relax_quotes:true },
      (err, rows) => err ? reject(err) : resolve(rows));
  });
}

// ──────────────────────────────────────────────
// Normalise
// ──────────────────────────────────────────────
function normalise(r) {
  const nome     = r['Revenda']           || r['Nome da Revenda']     || '';
  const cnpj     = r['CNPJ da Revenda']   || '';
  const bairro   = r['Bairro']            || '';
  const rua      = r['Nome da Rua']       || r['Endereço da Revenda'] || '';
  const numero   = r['Numero Rua']        || r['Número Rua']          || '';
  const cep      = r['Cep']               || r['CEP']                 || '';
  const produto  = r['Produto']           || '';
  const data     = r['Data da Coleta']    || r['Data Coleta']         || '';
  const rawVal   = r['Valor de Venda']    || r['Preço de Venda']      || '';
  const bandeira = r['Bandeira']          || '';
  const unidade  = r['Unidade de Medida'] || 'R$/l';

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
    lat: null,
    lng: null,
  };
}

function toTitleCase(s) {
  return s ? s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase()) : '';
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
// Coordenadas aproximadas por bairro (São Luís)
// ──────────────────────────────────────────────
const BAIRRO_COORDS = {
  'Centro':          { lat: -2.5307, lng: -44.3068 },
  'Lagoa Da Jansen': { lat: -2.5023, lng: -44.2912 },
  'Calhau':          { lat: -2.4975, lng: -44.2847 },
  'Renascença':      { lat: -2.5156, lng: -44.2758 },
  'Cohama':          { lat: -2.5523, lng: -44.2567 },
  'Turu':            { lat: -2.5389, lng: -44.2456 },
  "Olho D'Água":     { lat: -2.5234, lng: -44.2634 },
  'Cohatrac':        { lat: -2.5678, lng: -44.2389 },
  'Araçagy':         { lat: -2.4823, lng: -44.2456 },
  'São Cristóvão':   { lat: -2.5234, lng: -44.2789 },
  "Ponta D'Areia":   { lat: -2.4934, lng: -44.2934 },
  'Bacanga':         { lat: -2.5567, lng: -44.3123 },
  'Bequimão':        { lat: -2.5456, lng: -44.2678 },
  'Forquilha':       { lat: -2.5234, lng: -44.2345 },
  'Vinhais':         { lat: -2.5389, lng: -44.2234 },
  'Jaracaty':        { lat: -2.5123, lng: -44.2456 },
  'Coroadinho':      { lat: -2.5678, lng: -44.2789 },
  'Anil':            { lat: -2.5289, lng: -44.2567 },
  'João Paulo':      { lat: -2.5167, lng: -44.2678 },
};

function enrichWithCoords(rows) {
  return rows.map(r => {
    const coords = BAIRRO_COORDS[r.bairro] || BAIRRO_COORDS[toTitleCase(r.bairro)];
    if (coords) {
      // Adiciona pequena variação aleatória pra não empilhar todos no mesmo ponto
      r.lat = coords.lat + (Math.random() - 0.5) * 0.008;
      r.lng = coords.lng + (Math.random() - 0.5) * 0.008;
    }
    return r;
  });
}

// ──────────────────────────────────────────────
// Haversine — distância em km
// ──────────────────────────────────────────────
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2
    + Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

// ──────────────────────────────────────────────
// Dados de amostra (São Luís/MA)
// ──────────────────────────────────────────────
const SAMPLE_ROWS = (() => {
  const stations = [
    ['Auto Posto São Luís',   'Centro',          'Av. Getúlio Vargas',          '1200', 'Petrobras', '01.234.567/0001-01'],
    ['Posto Lagoa',           'Lagoa Da Jansen', 'Av. Litorânea',               '350',  'Ipiranga',  '02.345.678/0001-02'],
    ['Posto Calhau',          'Calhau',          'Rua dos Golfinhos',           '80',   'Shell',     '03.456.789/0001-03'],
    ['Posto Renascença',      'Renascença',      'Av. Daniel De La Touche',     '1500', 'BR',        '04.567.890/0001-04'],
    ['Posto Cohama Ltda',     'Cohama',          'Rua 14',                      '300',  'Petrobras', '05.678.901/0001-05'],
    ['Auto Posto Turu',       'Turu',            'Av. Jerônimo De Albuquerque', '900',  'Ipiranga',  '06.789.012/0001-06'],
    ["Posto Olho D'Água",     "Olho D'Água",     "Rua Olho D'Água",             '200',  'Ale',       '07.890.123/0001-07'],
    ['Auto Posto Cohatrac',   'Cohatrac',        'Av. Carlos Cunha',            '550',  'Shell',     '08.901.234/0001-08'],
    ['Posto Araçagy',         'Araçagy',         'Av. dos Holandeses',          '1100', 'BR',        '09.012.345/0001-09'],
    ['Posto São Cristóvão',   'São Cristóvão',   'Av. Colares Moreira',         '700',  'Petrobras', '10.123.456/0001-10'],
    ["Posto Ponta D'Areia",   "Ponta D'Areia",   'Av. Litorânea',               '1800', 'Ipiranga',  '11.234.567/0001-11'],
    ['Auto Posto Bacanga',    'Bacanga',         'Av. dos Africanos',           '400',  'Ale',       '12.345.678/0001-12'],
    ['Posto Bequimão',        'Bequimão',        'Av. Bequimão',                '600',  'Shell',     '13.456.789/0001-13'],
    ['Posto Forquilha',       'Forquilha',       'Rua Forquilha',               '150',  'BR',        '14.567.890/0001-14'],
    ['Auto Posto Vinhais',    'Vinhais',         'Av. dos Portugueses',         '850',  'Petrobras', '15.678.901/0001-15'],
    ['Posto Jaracaty',        'Jaracaty',        'Rua Jaracaty',                '220',  'Ipiranga',  '16.789.012/0001-16'],
    ['Auto Posto Coroadinho', 'Coroadinho',      'Rua Serra Pelada',            '330',  'Ale',       '17.890.123/0001-17'],
    ['Posto Anil',            'Anil',            'Av. Jerônimo De Albuquerque', '1300', 'Shell',     '18.901.234/0001-18'],
    ['Auto Posto João Paulo', 'João Paulo',      'Av. Jerônimo De Albuquerque', '1700', 'BR',        '19.012.345/0001-19'],
    ['Posto Anjo da Guarda',  'Centro',          'Rua do Sol',                  '90',   'Petrobras', '20.123.456/0001-20'],
  ];

  const basePrices = {
    'ETANOL HIDRATADO':   [5.60, 5.65, 5.69, 5.75, 5.79, 5.82, 5.87, 5.90],
    'GASOLINA COMUM':     [6.09, 6.15, 6.19, 6.25, 6.29, 6.35, 6.39, 6.45],
    'GASOLINA ADITIVADA': [6.40, 6.45, 6.49, 6.55, 6.59, 6.65, 6.72, 6.79],
    'DIESEL S10':         [5.90, 5.95, 5.99, 6.05, 6.09, 6.14, 6.17, 6.20],
    'DIESEL':             [5.75, 5.79, 5.83, 5.87, 5.92, 5.96, 6.00, 6.05],
    'GNV':                [4.29, 4.35, 4.39, 4.45, 4.49, 4.55, 4.59, 4.65],
  };

  const coleta = '28/03/2026';
  const rows = []; let idx = 0;

  for (const [nome, bairro, rua, numero, bandeira, cnpj] of stations) {
    const coords = BAIRRO_COORDS[bairro] || { lat: -2.5307, lng: -44.3068 };
    for (const [produto, prices] of Object.entries(basePrices)) {
      if (produto === 'GNV' && idx % 4 !== 0) { idx++; continue; }
      rows.push({
        nome, cnpj, produto, bairro,
        endereco: `${rua}, ${numero}`,
        cep: '', bandeira,
        preco: prices[idx % prices.length],
        unidade: produto === 'GNV' ? 'R$/m³' : 'R$/l',
        data: coleta,
        lat: coords.lat + (Math.random() - 0.5) * 0.008,
        lng: coords.lng + (Math.random() - 0.5) * 0.008,
      });
      idx++;
    }
  }
  return rows;
})();

// ──────────────────────────────────────────────
// Fetch ANP (com fallback)
// ──────────────────────────────────────────────
async function fetchAnpData() {
  const urls = await candidateUrls();
  for (const url of urls) {
    try {
      console.log(`[ANP] Baixando ${url}…`);
      const buffer  = await download(url, 5, 60000);
      const allRows = await parseCsvBuffer(buffer);
      const rows    = enrichWithCoords(filterSaoLuis(allRows));
      console.log(`[ANP] ${rows.length} registros para São Luís, MA`);
      const m = url.match(/ca-(\d{4})-(\d{2})\.csv/);
      return { rows, periodo: m ? `${m[1]}/Semestre ${m[2]}` : 'atual', source: url, demo: false };
    } catch (err) {
      console.warn(`[ANP] Falha em ${url}: ${err.message}`);
    }
  }
  console.warn('[ANP] Usando dados de amostra');
  return { rows: SAMPLE_ROWS, periodo: 'Edição 13/2026 – Semana 22 a 28/03/2026 (amostra)', source: 'amostra', demo: true };
}

async function getCached() {
  if (cache && (Date.now() - cache.fetchedAt) < CACHE_TTL_MS) return cache;
  // Retorna amostra imediatamente se não há cache, e busca ANP em background
  if (!cache) {
    cache = { rows: SAMPLE_ROWS, periodo: 'Edição 13/2026 – Semana 22 a 28/03/2026 (amostra)', source: 'amostra', demo: true, fetchedAt: Date.now() };
    fetchAnpData().then(data => {
      cache = { ...data, fetchedAt: Date.now() };
      console.log(`[Cache] Atualizado com ${data.rows.length} registros (${data.demo ? 'amostra' : 'ANP real'})`);
    }).catch(err => console.error('[Cache] Erro ao atualizar:', err.message));
  }
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

function applyQueryFilters(rows, query, userLat, userLng) {
  let { produto, bairro, q, sort = 'preco', order = 'asc' } = query;
  let { limit = '100', offset = '0' } = query;
  limit  = Math.min(parseInt(limit)  || 100, 1000);
  offset = Math.max(parseInt(offset) || 0, 0);

  // Adiciona distância se o usuário mandou coordenadas
  if (userLat !== null && userLng !== null) {
    rows = rows.map(r => ({
      ...r,
      distancia: r.lat && r.lng ? +haversine(userLat, userLng, r.lat, r.lng).toFixed(2) : null,
    }));
    if (!query.sort) sort = 'distancia'; // padrão: mais próximo
  }

  if (produto) { const p = produto.toUpperCase(); rows = rows.filter(r => r.produto.includes(p)); }
  if (bairro)  { const b = bairro.toLowerCase();  rows = rows.filter(r => r.bairro.toLowerCase().includes(b)); }
  if (q) {
    const t = q.toLowerCase();
    rows = rows.filter(r =>
      r.nome.toLowerCase().includes(t) || r.bairro.toLowerCase().includes(t) ||
      r.endereco.toLowerCase().includes(t) || r.bandeira.toLowerCase().includes(t));
  }

  const SORT = ['preco','nome','bairro','produto','data','distancia'];
  const sf   = SORT.includes(sort) ? sort : (userLat ? 'distancia' : 'preco');
  const dir  = order === 'desc' ? -1 : 1;
  rows.sort((a, b) => {
    let va = a[sf], vb = b[sf];
    if (va === null || va === undefined) va = Infinity;
    if (vb === null || vb === undefined) vb = Infinity;
    if (typeof va === 'string') { va = va.toLowerCase(); vb = vb.toLowerCase(); }
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
    const userLat = req.query.lat ? parseFloat(req.query.lat) : null;
    const userLng = req.query.lng ? parseFloat(req.query.lng) : null;
    const { rows, total, items, limit, offset } = applyQueryFilters([...data.rows], req.query, userLat, userLng);
    res.json({
      success: true,
      demo:    data.demo,
      meta:    { total, offset, limit, returned: items.length, periodo: data.periodo, fetchedAt: new Date(data.fetchedAt).toISOString() },
      summary: buildSummary(rows),
      items,
    });
  } catch (err) {
    console.error('[API]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/upload', async (req, res) => {
  try {
    const text = typeof req.body === 'string' ? req.body : req.body?.csv;
    if (!text || text.length < 10) return res.status(400).json({ success: false, error: 'CSV vazio' });
    const allRows = await parseCsvText(text);
    let rows = filterSaoLuis(allRows);
    if (rows.length === 0) rows = allRows.map(normalise).filter(Boolean);
    if (rows.length === 0) return res.status(422).json({ success: false, error: 'Nenhum registro válido' });
    rows = enrichWithCoords(rows);
    cache = { rows, periodo: 'Upload manual', source: 'upload', demo: false, fetchedAt: Date.now() };
    res.json({ success: true, rows: rows.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/cache/clear', (req, res) => {
  cache = null;
  res.json({ success: true });
});

app.get('/api/status', (req, res) => {
  res.json({ cached: !!cache, demo: cache?.demo ?? null, rows: cache?.rows.length ?? 0, periodo: cache?.periodo ?? null });
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
  // Pré-aquece o cache na inicialização (não bloqueia o servidor)
  getCached().catch(() => {});
});
