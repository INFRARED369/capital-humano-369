// NFR-ESC-01 · 500 eventos de tracking/s con p95 < 300 ms (tracking-ingest).
import http from 'k6/http';
import { FUNCIONES_URL, HEADERS, VACANTE_ID, uuidv7, verificar } from './lib.js';

const RUTA = __ENV.INGEST_PATH || '/tracking-ingest';
const NOMBRES = ['PageView', 'ViewContent', 'SectionView', 'ClickCTA'];

export const options = {
  scenarios: {
    eventos: { executor: 'constant-arrival-rate', rate: Number(__ENV.RATE || 500), timeUnit: '1s', duration: __ENV.DURACION || '2m', preAllocatedVUs: 200, maxVUs: 1000 },
  },
  thresholds: {
    'http_req_duration{escenario:eventos}': ['p(95)<300'],
    'http_req_failed{escenario:eventos}': ['rate<0.01'],
  },
};

export default function () {
  const evento = {
    event_id: uuidv7(),
    nombre: NOMBRES[Math.floor(Math.random() * NOMBRES.length)],
    visitor_id: uuidv7(),
    vacante_id: VACANTE_ID || null,
    url: '/vacantes/agente-smart/',
    ts: new Date().toISOString(),
    props: { utm_source: 'k6' },
  };
  const r = http.post(`${FUNCIONES_URL}${RUTA}`, JSON.stringify(evento), { headers: HEADERS, tags: { escenario: 'eventos' } });
  verificar(r, 'eventos', [200, 202, 204]);
}
