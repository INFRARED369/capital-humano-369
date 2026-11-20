// NFR-ESC-05 · GET slots p95 < 150 ms (sin Zoho en la ruta crítica).
import http from 'k6/http';
import { FUNCIONES_URL, HEADERS, VACANTE_ID, VACANTE_SLUG, verificar } from './lib.js';

const RUTA = __ENV.SLOTS_PATH || `/citas-api/slots?vacante=${VACANTE_ID || VACANTE_SLUG}`;

export const options = {
  scenarios: {
    slots: { executor: 'constant-arrival-rate', rate: Number(__ENV.RATE || 100), timeUnit: '1s', duration: __ENV.DURACION || '2m', preAllocatedVUs: 50, maxVUs: 300 },
  },
  thresholds: {
    'http_req_duration{escenario:slots}': ['p(95)<150'],
    'http_req_failed{escenario:slots}': ['rate<0.01'],
    checks: ['rate>0.99'],
  },
};

export default function () {
  const r = http.get(`${FUNCIONES_URL}${RUTA}`, { headers: HEADERS, tags: { escenario: 'slots' } });
  verificar(r, 'slots', [200]);
}
