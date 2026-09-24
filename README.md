# dvjob — k6 Load Tests

Набор нагрузочных и smoke-тестов для публичного API **dvjob.kz** (dev / prod).
Написаны на [k6](https://k6.io/).

[![k6](https://img.shields.io/badge/k6-v0.49%2B-7D64FF)](https://k6.io/)

⚠️ Безопасность

- Перед прогоном на проде: уведомить дежурных, приглушить алерты, выбрать окно низкого трафика.
- Перед полным прогоном полезно сделать smoke: `k6 run smoke-prod-test.js`.

## Содержимое

| Файл | Назначение | Целевой стенд |
|------|-----------|---------------|
| `smoke-prod-test.js`      | Быстрый smoke: 1 VU, 20 с, 5 эндпоинтов | prod |
| `dev-dvjob_load_test.js`  | Полный нагрузочный тест                  | dev / staging |

> ℹ️ Файл `pro_dvjob_load_test.js` — устаревший дубликат `dev-dvjob_load_test.js` с опечаткой в `BASE_URL` (`api.dvjob.pro`). Удалите его.

## Требования

- k6 v0.49+** — [инструкция по установке](https://k6.io/docs/get-started/installation/)
- Сетевой доступ к `api.***************`

## Быстрый старт

```bash
# Smoke на прод (безопасно, читает только публичные эндпоинты)
k6 run smoke-prod-test.js

# Быстрый dev-smoke (3 VU, 30 с)
k6 run --vus 3 --duration 30s dev-dvjob_load_test.js

# Полный dev-прогон
k6 run dev-dvjob_load_test.js

# Полный dev-прогон с сохранением результатов
k6 run --out json=results-dev-$(date +%F).json dev-dvjob_load_test.js

```

## Переменные окружения

| Переменная   | По умолчанию              | Описание |
|--------------|---------------------------|----------|
| `BASE_URL`   | зависит от скрипта        | Базовый URL API |
| `REGION`     | `kz`                      | Регион контента |
| `LANG`       | `ru`                      | Язык (`ru` / `kz` / `en`) |
| `USER_AGENT` | `k6-dvjob-load-test/2.0`  | User-Agent в запросах |

Пример:

```bash
k6 run \
  -e BASE_URL=************** \
  -e REGION=kz \
  -e LANG=ru \
  dev-dvjob_load_test.js
```

## Что покрывается

### Сценарии нагрузки

1. content_browsers — главная, футер, контакты, новости, legal-документы, feature-flags, promotions v2.
2. vacancy_searchers — популярные запросы и 5 вариантов фильтра вакансий.
3. resume_searchers — match-поиск, фильтры по статусу, расширенный, `has_video`.
4. lookup_users — справочники, статистика, i18n, доступные тесты.
5. health_spike — spike-проверка `/health` и `/v1/test`.

### Кастомные метрики

- `errors` (Rate)
- `vacancy_search_duration`, `resume_search_duration`, `content_load_duration`, `lookups_duration` (Trend)
- `api_calls_total` (Counter)

Все имеют `thresholds` в `options`. Красные threshold'ы = регрессия.

## Известные ограничения

- Dev-стенд : после серии нагрузочных прогонов (rps > 20) наблюдаются rate-limit/WAF-деградации
  (~18 с на все запросы, 403 на отдельные). Пик `health_spike` на dev снижен до 20 rps,
  `setup()` предупреждает при `probe > 2000 ms`.



