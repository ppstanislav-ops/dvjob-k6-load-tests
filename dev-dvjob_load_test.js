/**
 * k6 Load Test — dvjob.kz (dev / staging)
 * =========================================================
 * Покрытие: только публичные эндпоинты (security: [] либо optional auth).
 *
 * Запуск:
 *   k6 run dev-dvjob_load_test.js
 *  *
 * С сохранением результатов:
 *   k6 run --out json=results-dev.json dev-dvjob_load_test.js
 *
 * Быстрый smoke-прогон (перед полным — рекомендовано):
 *   k6 run --vus 3 --duration 30s dev-dvjob_load_test.js
 *
 * =========================================================
 * 
 * =========================================================
 * Наблюдалось два состояния:
 *   (A) Здоровое:  curl /v1/lookups/specialties → 200 OK за ~0.6s
 *   (B) Деградация: все эндпоинты (включая /health) отвечают ~18s,
 *                   отдельные запросы отклоняются 403 "Отказано в доступе"
 *                   Причина: rate-limit / WAF, срабатывающий после нагрузки
 *                   (напр. серии прогонов k6 с rps >20).
 *
 * Поэтому в скрипте:
 *   - health_spike снижен до пика 20 rps (было 50)
 *   - setup() проверяет реальную скорость стенда и предупреждает
 *   - из сценария resumes/filter убран work_formats (известный баг бэкенда)
 * =========================================================
 */

import http from 'k6/http';
import { check, group } from 'k6';
import {
  REGION, LANG,
  HEADERS_JSON, HEADERS_GET,
  checkResponse, thinkTime,
  contentLoadDur, vacancySearchDur, resumeSearchDur, lookupsDur, errorRate,
  SEARCH_QUERIES, LOCALES, LOOKUP_ENDPOINTS,
  EMPLOYMENT_TYPES, WORK_FORMATS, WORK_SCHEDULES,
  CONTRACT_TYPES, EXPERIENCE_CODES,
  SALARY_FROM, SALARY_CURRENCIES, PAGE_SIZES,
  RESUME_STATUSES, READY_TO_START,
  randomItem, randomIntBetween,
} from './lib/common.js';

// ─── Конфигурация ─────────────────────────────────────────
const BASE_URL = __ENV.BASE_URL || '///////////////////////////';

// ─── Тестовые данные (dev-специфичные) ────────────────────
const NEWS_SLUGS = [
  'pervyi-post', 'novosti-kompanii', 'vakansii-mesyatsa',
];

// Slug'и legal-документов. Реальные значения уточнить через /v1/content/legal-documents
const LEGAL_SLUGS = [
  'privacy-policy', 'terms-of-service', 'user-agreement', 'cookie-policy',
];

// Для parent_id-фильтрации (значения-заглушки; пустой [] — валидный ответ)
const PARENT_ID_PROBES = [
  { ep: '/v1/lookups/cities',      parent_id: 1 },
  { ep: '/v1/lookups/specialties', parent_id: 1 },
  { ep: '/v1/lookups/companies',   parent_id: 1 },
];

// ─── Конфигурация сценариев ───────────────────────────────
export const options = {
  scenarios: {
    // 1. Посетители главной + контент
    content_browsers: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 10 },
        { duration: '1m',  target: 25 },
        { duration: '2m',  target: 25 },
        { duration: '30s', target: 0  },
      ],
      exec: 'contentScenario',
      gracefulRampDown: '10s',
    },

    // 2. Поиск вакансий (основной трафик)
    vacancy_searchers: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 20 },
        { duration: '1m',  target: 50 },
        { duration: '2m',  target: 50 },
        { duration: '30s', target: 0  },
      ],
      exec: 'vacancySearchScenario',
      gracefulRampDown: '10s',
    },

    // 3. Поиск резюме
    resume_searchers: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 5  },
        { duration: '1m',  target: 15 },
        { duration: '2m',  target: 15 },
        { duration: '30s', target: 0  },
      ],
      exec: 'resumeSearchScenario',
      gracefulRampDown: '10s',
    },

    // 4. Справочники (lookups) и статистика
    lookup_users: {
      executor: 'constant-vus',
      vus: 5,
      duration: '4m',
      exec: 'lookupsScenario',
    },

    // 5. Spike-тест на health + api_test.
    // Пик снижен с 50 → 20 rps и VUs с 250 → 100, чтобы не спровоцировать
    // rate-limit/WAF на dev-стенде (в прошлом стенд уходил в ~18s-деградацию).
    health_spike: {
      executor: 'ramping-arrival-rate',
      startRate: 5,
      timeUnit: '1s',
      preAllocatedVUs: 30,
      maxVUs: 100,
      stages: [
        { duration: '30s', target: 5  },
        { duration: '30s', target: 20 },   // ← пик 20 rps (было 50)
        { duration: '1m',  target: 5  },
        { duration: '2m',  target: 5  },
      ],
      exec: 'healthScenario',
      startTime: '10s',
    },
  },

  thresholds: {
    'http_req_duration':               ['p(95)<2000', 'p(99)<4000'],
    'http_req_duration{type:health}':  ['p(95)<500'],
    'http_req_duration{type:search}':  ['p(95)<3000'],
    'http_req_duration{type:content}': ['p(95)<1500'],
    'http_req_duration{type:lookup}':  ['p(95)<1000'],

    'vacancy_search_duration': ['p(95)<3000'],
    'resume_search_duration':  ['p(95)<3000'],
    'content_load_duration':   ['p(95)<1500'],
    'lookups_duration':        ['p(95)<800'],

    'errors':          ['rate<0.05'],
    'http_req_failed': ['rate<0.05'],
    'checks':          ['rate>0.95'],
  },
};

// ─── СЦЕНАРИЙ 1: Контент и главная страница ───────────────
export function contentScenario() {
  group('Home & Content', () => {

    // 404 допустим: на dev может не быть активной layout для региона
    group('Homepage', () => {
      const res = http.get(
        `${BASE_URL}/v1/content/home?region=${REGION}&lang=${LANG}`,
        { headers: HEADERS_GET, tags: { type: 'content', endpoint: 'content_home' } }
      );
      contentLoadDur.add(res.timings.duration);
      checkResponse(res, 'GET /content/home', { type: 'content' }, {
        allowedStatuses: [200, 404],
      });
    });

    thinkTime(1, 2);

    group('Footer', () => {
      const res = http.get(
        `${BASE_URL}/v1/content/footer?region=${REGION}&lang=${LANG}`,
        { headers: HEADERS_GET, tags: { type: 'content', endpoint: 'content_footer' } }
      );
      contentLoadDur.add(res.timings.duration);
      checkResponse(res, 'GET /content/footer', { type: 'content' }, {
        allowedStatuses: [200, 404],
      });
    });

    thinkTime(1, 2);

    group('Contacts', () => {
      const res = http.get(
        `${BASE_URL}/v1/content/contacts?region=${REGION}&lang=${LANG}`,
        { headers: HEADERS_GET, tags: { type: 'content', endpoint: 'content_contacts' } }
      );
      contentLoadDur.add(res.timings.duration);
      checkResponse(res, 'GET /content/contacts', { type: 'content' }, {
        allowedStatuses: [200, 404],
      });
    });

    thinkTime(1, 2);

    group('News list', () => {
      const page = randomIntBetween(1, 3);
      const res = http.get(
        `${BASE_URL}/v1/content/news?region=${REGION}&lang=${LANG}&page=${page}&page_size=10`,
        { headers: HEADERS_GET, tags: { type: 'content', endpoint: 'content_news' } }
      );
      contentLoadDur.add(res.timings.duration);
      checkResponse(res, 'GET /content/news', { type: 'content' });
    });

    thinkTime(1, 3);

    group('News article', () => {
      const slug = randomItem(NEWS_SLUGS);
      const res = http.get(
        `${BASE_URL}/v1/content/news/${slug}?region=${REGION}&lang=${LANG}`,
        { headers: HEADERS_GET, tags: { type: 'content', endpoint: 'content_news_article' } }
      );
      checkResponse(res, 'GET /content/news/{slug}', { type: 'content' }, {
        allowedStatuses: [200, 404],
      });
    });

    thinkTime(1, 2);

    group('Legal docs list', () => {
      const res = http.get(
        `${BASE_URL}/v1/content/legal-documents?region=${REGION}&lang=${LANG}`,
        { headers: HEADERS_GET, tags: { type: 'content', endpoint: 'content_legal_list' } }
      );
      contentLoadDur.add(res.timings.duration);
      checkResponse(res, 'GET /content/legal-documents', { type: 'content' });
    });

    thinkTime(1, 2);

    group('Legal doc by slug', () => {
      const slug = randomItem(LEGAL_SLUGS);
      const res = http.get(
        `${BASE_URL}/v1/content/legal-documents/${slug}?region=${REGION}&lang=${LANG}`,
        { headers: HEADERS_GET, tags: { type: 'content', endpoint: 'content_legal_show' } }
      );
      contentLoadDur.add(res.timings.duration);
      checkResponse(res, 'GET /content/legal-documents/{slug}', { type: 'content' }, {
        allowedStatuses: [200, 404],
      });
    });

    thinkTime(1, 2);

    group('About company', () => {
      const res = http.get(
        `${BASE_URL}/v1/content/about-company?region=${REGION}&lang=${LANG}`,
        { headers: HEADERS_GET, tags: { type: 'content', endpoint: 'content_about' } }
      );
      contentLoadDur.add(res.timings.duration);
      checkResponse(res, 'GET /content/about-company', { type: 'content' }, {
        allowedStatuses: [200, 404],
      });
    });

    group('Feature flags', () => {
      const res = http.get(`${BASE_URL}/v1/feature-flags`, {
        headers: HEADERS_GET,
        tags: { type: 'content', endpoint: 'feature_flags' },
      });
      checkResponse(res, 'GET /feature-flags', { type: 'content' });
    });

    // Публичные (optional auth) promotions v2
    group('Promotions v2', () => {
      const requests = [
        ['GET', `${BASE_URL}/v2/promotions/current`,  null, { headers: HEADERS_GET, tags: { type: 'content', endpoint: 'promotions_current' } }],
        ['GET', `${BASE_URL}/v2/promotions/progress`, null, { headers: HEADERS_GET, tags: { type: 'content', endpoint: 'promotions_progress' } }],
      ];
      const responses = http.batch(requests);
      for (const res of responses) {
        checkResponse(res, 'GET /v2/promotions/*', { type: 'content' }, {
          allowedStatuses: [200, 404],
        });
      }
    });

  });

  thinkTime(2, 5);
}

// ─── СЦЕНАРИЙ 2: Поиск вакансий ──────────────────────────
export function vacancySearchScenario() {
  group('Vacancy Search', () => {

    group('Popular searches', () => {
      const res = http.get(`${BASE_URL}/v1/search/popular?type=vacancy`, {
        headers: HEADERS_GET,
        tags: { type: 'search', endpoint: 'search_popular_vacancy' },
      });
      checkResponse(res, 'GET /search/popular', { type: 'search' });
    });

    thinkTime(1, 2);

    group('Vacancy filter - basic', () => {
      const body = JSON.stringify({
        page:   randomIntBetween(1, 5),
        size:   randomItem(PAGE_SIZES),
        search: [randomItem(SEARCH_QUERIES)],
      });
      const res = http.post(`${BASE_URL}/v1/vacancies/filter`, body, {
        headers: HEADERS_JSON,
        tags: { type: 'search', endpoint: 'vacancies_filter_basic' },
      });
      vacancySearchDur.add(res.timings.duration);
      checkResponse(res, 'POST /vacancies/filter (basic)', { type: 'search' });
    });

    thinkTime(1, 3);

    group('Vacancy filter - advanced', () => {
      const body = JSON.stringify({
        page:             1,
        size:             randomItem(PAGE_SIZES),
        search:           [randomItem(SEARCH_QUERIES)],
        employment_types: [randomItem(EMPLOYMENT_TYPES)],
        work_formats:     [randomItem(WORK_FORMATS)],
        work_schedules:   [randomItem(WORK_SCHEDULES)],
        contract_types:   [randomItem(CONTRACT_TYPES)],
        experiences:      [randomItem(EXPERIENCE_CODES)],
        salary_min:       randomItem(SALARY_FROM),
      });
      const res = http.post(`${BASE_URL}/v1/vacancies/filter`, body, {
        headers: HEADERS_JSON,
        tags: { type: 'search', endpoint: 'vacancies_filter_advanced' },
      });
      vacancySearchDur.add(res.timings.duration);
      checkResponse(res, 'POST /vacancies/filter (advanced)', { type: 'search' });
    });

    thinkTime(1, 3);

    group('Vacancy filter - salary', () => {
      const body = JSON.stringify({
        page:            1,
        size:            20,
        salary_min:      randomItem(SALARY_FROM),
        salary_max:      randomItem(SALARY_FROM) + 200000,
        salary_currency: randomItem(SALARY_CURRENCIES),
      });
      const res = http.post(`${BASE_URL}/v1/vacancies/filter`, body, {
        headers: HEADERS_JSON,
        tags: { type: 'search', endpoint: 'vacancies_filter_salary' },
      });
      vacancySearchDur.add(res.timings.duration);
      checkResponse(res, 'POST /vacancies/filter (salary)', { type: 'search' });
    });

    thinkTime(1, 2);

    group('Vacancy filter - company', () => {
      const body = JSON.stringify({
        page:           1,
        size:           20,
        company_search: [randomItem(['ТОО', 'ООО', 'company', 'group', 'tech'])],
      });
      const res = http.post(`${BASE_URL}/v1/vacancies/filter`, body, {
        headers: HEADERS_JSON,
        tags: { type: 'search', endpoint: 'vacancies_filter_company' },
      });
      vacancySearchDur.add(res.timings.duration);
      checkResponse(res, 'POST /vacancies/filter (company)', { type: 'search' });
    });

    thinkTime(1, 2);

    group('Vacancy filter - all', () => {
      const body = JSON.stringify({
        page: randomIntBetween(1, 10),
        size: 20,
      });
      const res = http.post(`${BASE_URL}/v1/vacancies/filter`, body, {
        headers: HEADERS_JSON,
        tags: { type: 'search', endpoint: 'vacancies_filter_all' },
      });
      vacancySearchDur.add(res.timings.duration);
      checkResponse(res, 'POST /vacancies/filter (all)', { type: 'search' });
    });

    thinkTime(1, 2);

    group('Health check', () => {
      const res = http.get(`${BASE_URL}/health`, {
        headers: HEADERS_GET,
        tags: { type: 'health', endpoint: 'health' },
      });
      checkResponse(res, 'GET /health', { type: 'health' });
    });

  });

  thinkTime(2, 5);
}

// ─── СЦЕНАРИЙ 3: Поиск резюме ─────────────────────────────
export function resumeSearchScenario() {
  group('Resume Search', () => {

    group('Popular resume searches', () => {
      const res = http.get(`${BASE_URL}/v1/search/popular?type=resume`, {
        headers: HEADERS_GET,
        tags: { type: 'search', endpoint: 'search_popular_resume' },
      });
      checkResponse(res, 'GET /search/popular (resume)', { type: 'search' });
    });

    thinkTime(1, 2);

    group('Resume text search', () => {
      const q = randomItem(SEARCH_QUERIES);
      const res = http.get(
        `${BASE_URL}/v1/resumes/search/match?search=${encodeURIComponent(q)}&size=20`,
        { headers: HEADERS_GET, tags: { type: 'search', endpoint: 'resume_text_search' } }
      );
      resumeSearchDur.add(res.timings.duration);
      checkResponse(res, 'GET /resumes/search/match', { type: 'search' });
    });

    thinkTime(1, 2);

    group('Resume filter - basic', () => {
      const body = JSON.stringify({
        page:   randomIntBetween(1, 5),
        size:   randomItem(PAGE_SIZES),
        search: [randomItem(SEARCH_QUERIES)],
      });
      const res = http.post(`${BASE_URL}/v1/resumes/filter`, body, {
        headers: HEADERS_JSON,
        tags: { type: 'search', endpoint: 'resumes_filter_basic' },
      });
      resumeSearchDur.add(res.timings.duration);
      checkResponse(res, 'POST /resumes/filter (basic)', { type: 'search' });
    });

    thinkTime(1, 3);

    // ИЗВЕСТНЫЙ БАГ БЭКЕНДА (DVJOB-0192):
    // POST /v1/resumes/filter с полем work_formats → 500 server_error
    // Root cause: SQLSTATE[42703] column resumes.work_format_code does not exist.
    // После фикса — раскомментировать work_formats ниже.
    group('Resume filter - by status', () => {
      const body = JSON.stringify({
        page:          1,
        size:          20,
        resume_status: randomItem(RESUME_STATUSES),
        // work_formats: [randomItem(WORK_FORMATS_RESUME)],  // TODO: БАГ 500, тикет DVJOB-0192
      });
      const res = http.post(`${BASE_URL}/v1/resumes/filter`, body, {
        headers: HEADERS_JSON,
        tags: { type: 'search', endpoint: 'resumes_filter_status' },
      });
      resumeSearchDur.add(res.timings.duration);
      checkResponse(res, 'POST /resumes/filter (status)', { type: 'search' });
    });

    thinkTime(1, 3);

    // Расширенный фильтр резюме (без work_formats — см. баг выше)
    group('Resume filter - advanced', () => {
      const body = JSON.stringify({
        page:             1,
        size:             randomItem(PAGE_SIZES),
        employment_types: [randomItem(EMPLOYMENT_TYPES)],
        work_schedules:   [randomItem(WORK_SCHEDULES)],
        education_levels: ['higher'],
        experiences:      [randomItem(EXPERIENCE_CODES)],
        ready_to_start:   randomItem(READY_TO_START),
        salary_min:       randomItem(SALARY_FROM),
        salary_currency:  randomItem(SALARY_CURRENCIES),
      });
      const res = http.post(`${BASE_URL}/v1/resumes/filter`, body, {
        headers: HEADERS_JSON,
        tags: { type: 'search', endpoint: 'resumes_filter_advanced' },
      });
      resumeSearchDur.add(res.timings.duration);
      checkResponse(res, 'POST /resumes/filter (advanced)', { type: 'search' });
    });

    thinkTime(1, 3);

    group('Resume filter - has_video', () => {
      const body = JSON.stringify({
        page:      1,
        size:      20,
        has_video: true,
      });
      const res = http.post(`${BASE_URL}/v1/resumes/filter`, body, {
        headers: HEADERS_JSON,
        tags: { type: 'search', endpoint: 'resumes_filter_has_video' },
      });
      resumeSearchDur.add(res.timings.duration);
      checkResponse(res, 'POST /resumes/filter (has_video)', { type: 'search' });
    });

    thinkTime(2, 4);
  });

  thinkTime(2, 5);
}

// ─── СЦЕНАРИЙ 4: Справочники и статистика ─────────────────
export function lookupsScenario() {
  group('Lookups & Stats', () => {

    group('Platform stats', () => {
      const endpoints = [
        '/v1/stats/vacancies',
        '/v1/stats/resumes',
        '/v1/stats/users',
      ];
      const requests = endpoints.map((ep) => [
        'GET', `${BASE_URL}${ep}`, null,
        { headers: HEADERS_GET, tags: { type: 'lookup', endpoint: 'stats' } },
      ]);
      const responses = http.batch(requests);
      for (const [i, res] of responses.entries()) {
        lookupsDur.add(res.timings.duration);
        checkResponse(res, `GET ${endpoints[i]}`, { type: 'lookup' });
      }
    });

    thinkTime(1, 2);

    group('Lookups batch', () => {
      const selected = LOOKUP_ENDPOINTS
        .slice()
        .sort(() => Math.random() - 0.5)
        .slice(0, randomIntBetween(4, 6));

      const requests = selected.map((ep) => [
        'GET', `${BASE_URL}${ep}`, null,
        { headers: HEADERS_GET, tags: { type: 'lookup', endpoint: ep } },
      ]);

      const responses = http.batch(requests);
      for (const [i, res] of responses.entries()) {
        lookupsDur.add(res.timings.duration);
        checkResponse(res, `GET ${selected[i]}`, { type: 'lookup' });
      }
    });

    thinkTime(1, 2);

    group('Lookups with parent_id', () => {
      const probes = PARENT_ID_PROBES
        .slice()
        .sort(() => Math.random() - 0.5)
        .slice(0, 2);

      const requests = probes.map((p) => [
        'GET', `${BASE_URL}${p.ep}?parent_id=${p.parent_id}`, null,
        { headers: HEADERS_GET, tags: { type: 'lookup', endpoint: `${p.ep}_parent` } },
      ]);

      const responses = http.batch(requests);
      for (const [i, res] of responses.entries()) {
        lookupsDur.add(res.timings.duration);
        checkResponse(res, `GET ${probes[i].ep}?parent_id`, { type: 'lookup' }, {
          allowedStatuses: [200, 404],
        });
      }
    });

    thinkTime(1, 2);

    group('i18n', () => {
      const locale = randomItem(LOCALES);
      const res = http.get(`${BASE_URL}/v1/i18n/${locale}`, {
        headers: HEADERS_GET,
        tags: { type: 'lookup', endpoint: 'i18n' },
      });
      lookupsDur.add(res.timings.duration);
      checkResponse(res, `GET /i18n/${locale}`, { type: 'lookup' });
    });

    thinkTime(1, 2);

    group('Available tests', () => {
      const res = http.get(`${BASE_URL}/v1/tests`, {
        headers: HEADERS_GET,
        tags: { type: 'lookup', endpoint: 'tests' },
      });
      checkResponse(res, 'GET /tests', { type: 'lookup' });
    });

    thinkTime(2, 4);
  });

  thinkTime(2, 4);
}

// ─── СЦЕНАРИЙ 5: Health-check (spike) ─────────────────────
export function healthScenario() {
  group('Health & API Test', () => {
    const res1 = http.get(`${BASE_URL}/health`, {
      headers: HEADERS_GET,
      tags: { type: 'health', endpoint: 'health' },
    });
    const ok1 = check(res1, { 'health: status 200': (r) => r.status === 200 });
    errorRate.add(!ok1);

    const res2 = http.get(`${BASE_URL}/v1/test`, {
      headers: HEADERS_GET,
      tags: { type: 'health', endpoint: 'api_test' },
    });
    const ok2 = check(res2, { 'api_test: status 2xx': (r) => r.status >= 200 && r.status < 300 });
    errorRate.add(!ok2);
  });

  sleep(0.5);
}

// ─── SETUP ────────────────────────────────────────────────
export function setup() {
  console.log('=== dvjob.kz DEV Load Test ===');
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Region:   ${REGION}`);
  console.log(`Lang:     ${LANG}`);
  console.log('');

  // 1. Проверка health
  const health = http.get(`${BASE_URL}/health`, { headers: HEADERS_GET });
  if (health.status !== 200) {
    console.warn(`⚠ WARNING: /health → ${health.status}. Стенд может быть не готов.`);
  } else {
    console.log(`✓ /health → 200 (${health.timings.duration.toFixed(0)} ms)`);
  }

  // 2. Контрольная проверка СКОРОСТИ на публичном справочнике.
  // На здоровом dev — ~0.6s, prod — ~0.9s. Если > 2s — стенд деградирован.
  const speedProbe = http.get(`${BASE_URL}/v1/lookups/specialties`, {
    headers: HEADERS_GET,
  });
  const probeMs = speedProbe.timings.duration;
  if (speedProbe.status !== 200) {
    console.warn(`⚠ WARNING: /v1/lookups/specialties → ${speedProbe.status}. Возможно, WAF/rate-limit.`);
  } else if (probeMs > 2000) {
    console.warn(`⚠ WARNING: /v1/lookups/specialties → ${probeMs.toFixed(0)} ms (>2000 ms).`);
    console.warn('  Стенд в состоянии ДЕГРАДАЦИИ. Полный прогон даст нечитаемые метрики.');
    console.warn('  Рекомендуется прервать (Ctrl+C) и подождать 5-10 мин.');
  } else {
    console.log(`✓ /v1/lookups/specialties → 200 (${probeMs.toFixed(0)} ms) — стенд здоров`);
  }

  // 3. Контрольная проба известного бага DVJOB-0192
  const bugProbe = http.post(
    `${BASE_URL}/v1/resumes/filter`,
    JSON.stringify({ page: 1, size: 1, work_formats: ['on_site'] }),
    { headers: HEADERS_JSON }
  );
  if (bugProbe.status === 500) {
    console.warn('⚠ KNOWN BUG (DVJOB-0192): POST /v1/resumes/filter + work_formats → 500');
    console.warn('  Поле закомментировано в сценарии resumeSearchScenario.');
  } else if (bugProbe.status === 200) {
    console.log('✓ resumes/filter + work_formats работает — можно разкомментировать в сценарии.');
  }

  console.log('');
  console.log('Starting scenarios...');
  console.log('Совет: следите за http_req_duration в реальном времени.');
  console.log('Если p(95) > 5s в первые 60 секунд — остановите (Ctrl+C).');
  console.log('');

  return { startTime: Date.now() };
}

// ─── TEARDOWN ─────────────────────────────────────────────
export function teardown(data) {
  const duration = ((Date.now() - data.startTime) / 1000).toFixed(1);
  console.log(`\n=== DEV test completed in ${duration}s ===`);
  console.log('Проверьте THRESHOLDS выше — если красные, см. детали в отчёте.');
}