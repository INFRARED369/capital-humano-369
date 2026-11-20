// NFR-ESC-01 · 50 postulaciones/s con p95 < 300 ms.
// El contrato exacto del cuerpo lo define captación (POST postular); ajustar con POSTULAR_PATH / campos.
import http from 'k6/http';
import { FUNCIONES_URL, HEADERS, VACANTE_ID, VACANTE_SLUG, telefonoPrueba, uuidv7, verificar } from './lib.js';

const RUTA = __ENV.POSTULAR_PATH || '/postular';

export const options = {
  scenarios: {
    postular: { executor: 'constant-arrival-rate', rate: Number(__ENV.RATE || 50), timeUnit: '1s', duration: __ENV.DURACION || '2m', preAllocatedVUs: 100, maxVUs: 500 },
  },
  thresholds: {
    'http_req_duration{escenario:postular}': ['p(95)<300'],
    'http_req_failed{escenario:postular}': ['rate<0.01'],
    checks: ['rate>0.99'],
  },
};

export default function () {
  const cuerpo = {
    vacante_id: VACANTE_ID || undefined,
    vacante_slug: VACANTE_SLUG,
    nombre: 'Carga k6',
    telefono: telefonoPrueba(),
    email: null,
    respuestas: {},
    consentimiento: { aviso_version: '2026-11-13', acepta: true },
    event_id: uuidv7(),
    turnstile_token: 'XXXX.DUMMY.TOKEN.XXXX',
  };
  const r = http.post(`${FUNCIONES_URL}${RUTA}`, JSON.stringify(cuerpo), { headers: HEADERS, tags: { escenario: 'postular' } });
  // 409 = slot lleno / duplicado: respuesta de negocio válida bajo carga.
  verificar(r, 'postular', [200, 201, 409]);
}
