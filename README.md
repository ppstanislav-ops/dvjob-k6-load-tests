# k6 Load Tests — job-платформы DVjob 

Набор нагрузочных тестов для публичного API job-платформы (dev / prod).
Написаны на [k6](https://k6.io/).

[![k6](https://img.shields.io/badge/k6-v0.49%2B-7D64FF)](https://k6.io/)


## Содержимое

| Файл | Назначение | Целевой стенд |
|------|-----------|---------------|
| `dev-dvjob_load_test.js`      | Полный нагрузочный тест  нового тестовго стенда                                         | dev / staging |
| `pro_dvjob_load_test.js`      | Полный нагрузочный тест  старого тестовго стенда                                        | old / staging |
| `dvjob_load_test.js`          | Облегчённый нагрузочный тест production сайта (сниженная нагрузка, доп. safety-checks)  | production |


## Требования

- k6 v0.49+ — [инструкция по установке](https://k6.io/docs/get-started/installation/)
- Сетевой доступ к тестируемому API (адрес передаётся через `BASE_URL`, см. ниже)

## Быстрый старт

```bash
# Быстрый dev-smoke (3 VU, 30 с)
k6 run --vus 3 --duration 30s load_test.js

# Полный dev-прогон
k6 run -e BASE_URL=https://api.example.com -e REGION=xx -e LANG=en load_test.js

# Полный dev-прогон с сохранением результатов
k6 run --out json=results-dev-$(date +%F).json load_test.js

# Прод-прогон — ТОЛЬКО по согласованию с DevOps/владельцем продукта!
k6 run -e BASE_URL=https://api.example.com load_test_prod.js
```

После любого прогона в текущей папке появятся:
- `summary.html` — наглядный HTML-отчёт (открыть в браузере);
- `summary.json` — полный JSON со всеми метриками и thresholds.

### Сценарии нагрузки

1. `content_browsers` — главная, футер, контакты, новости, legal-документы, feature-flags, promotions v2.
2. `vacancy_searchers` — популярные запросы и несколько вариантов фильтра вакансий.
3. `resume_searchers` — match-поиск, фильтры по статусу, расширенный, `has_video`.
4. `lookup_users` — справочники, статистика, i18n, доступные тесты.
5. `health_spike` — spike-проверка `/health` и `/v1/test`.

### Кастомные метрики

- `errors` (Rate)
- `vacancy_search_duration`, `resume_search_duration`, `content_load_duration`, `lookups_duration` (Trend)
- `api_calls_total` (Counter)

Все имеют `thresholds` в `options`. Красные threshold'ы = регрессия.

## Известные ограничения

- На стендах с активным rate-limiting/WAF агрессивная нагрузка может вызывать деградацию
  (рост латентности, 403/429-ответы). `setup()` делает пробный запрос к «лёгкому» эндпоинту
  и предупреждает (dev) либо останавливает прогон (prod), если время ответа превышает
  порог `DEGRADATION_THRESHOLD_MS` (по умолчанию 2000 мс, настраивается через ENV).
- Пиковые значения в сценариях (`health_spike` и др.) заданы консервативно по умолчанию —
  подберите их под конкретный стенд перед первым запуском.
- Перед прод-прогоном обязательно согласуйте окно с DevOps/SRE — см. предупреждение
  в шапке `load_test_prod.js`.