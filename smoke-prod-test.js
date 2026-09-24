/**
 * k6 SMOKE Test — PRODUCTION 
 * =========================================================
 * Быстрая проверка прод-стенда: 1 виртуальный пользователь,
 * 20 секунд, 5 ключевых публичных эндпоинтов.
 *
 * Запуск:
 *   k6 run smoke-prod-test.js
 *
 * Что проверяет:
 *   - /health                        (доступность API)
 *   - /v1/lookups/specialties        (ключевой read-only, эталон скорости)
 *   - /v1/vacancies/filter           (главный сценарий соискателя)
 *   - /v1/resumes/filter             (главный сценарий работодателя)
 *   - /v1/feature-flags              (публичный конфиг)
 *
 * Ожидаемый результат: 100% checks passed, p(95) < 1500 ms.
 * =========================================================
 */

import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { HEADERS_GET, HEADERS_JSON } from './lib/common.js';

const BASE_URL = __ENV.BASE_URL || '///////////////////';

export const options = {
  vus: 1,
  duration: '20s',
  thresholds: {
    'http_req_duration': ['p(95)<1500', 'p(99)<3000'],
    'http_req_failed':   ['rate<0.02'],
  },
};

export default function () {
  group('PROD smoke — публичные эндпоинты', () => {

    // 1. Health — обязательная проверка
    const health = http.get(`${BASE_URL}/health`, {
      headers: HEADERS_GET,
      tags: { ep: 'health' },
    });
    check(health, {
      'health: status 200': (r) => r.status === 200,
      'health: <500 ms':    (r) => r.timings.duration < 500,
    });

    // 2. Ключевой справочник — эталон скорости
    const spec = http.get(`${BASE_URL}/v1/lookups/specialties`, {
      headers: HEADERS_GET,
      tags: { ep: 'lookups_specialties' },
    });
    check(spec, {
      'lookups/specialties: 200':      (r) => r.status === 200,
      'lookups/specialties: <1500 ms': (r) => r.timings.duration < 1500,
    });

    sleep(0.5);

    // 3. Поиск вакансий — базовый сценарий соискателя
    const vac = http.post(
      `${BASE_URL}/v1/vacancies/filter`,
      JSON.stringify({ page: 1, size: 10 }),
      { headers: HEADERS_JSON, tags: { ep: 'vacancies_filter' } }
    );
    check(vac, {
      'vacancies/filter: 200': (r) => r.status === 200,
    });

    // 4. Поиск резюме — базовый сценарий работодателя
    const res = http.post(
      `${BASE_URL}/v1/resumes/filter`,
      JSON.stringify({ page: 1, size: 10 }),
      { headers: HEADERS_JSON, tags: { ep: 'resumes_filter' } }
    );
    check(res, {
      'resumes/filter: 200': (r) => r.status === 200,
    });

    // 5. Публичные фича-флаги
    const flags = http.get(`${BASE_URL}/v1/feature-flags`, {
      headers: HEADERS_GET,
      tags: { ep: 'feature_flags' },
    });
    check(flags, {
      'feature-flags: 200': (r) => r.status === 200,
    });

    sleep(2);
  });
}