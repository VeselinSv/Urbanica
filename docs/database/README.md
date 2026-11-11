# База данни

PostgreSQL (локално 17 чрез `embedded-postgres`, в облака – управлявана). Достъп чрез Prisma 6; критичните операции използват параметризирани raw SQL заявки (`$executeRaw`/`$queryRaw` с шаблонни параметри – без конкатенация на вход от потребителя). Схема: `packages/database/prisma/schema.prisma`.

## Таблици

| Група      | Таблица                                                                                  | Предназначение                                                                                                              | Ключове / ограничения                                                                              |
| ---------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Профили    | `User`                                                                                   | акаунт, scrypt хеш на паролата, роля, `lastActiveAt`, `mutedUntil`                                                          | уникални `username`, `email`                                                                       |
|            | `Session`                                                                                | сесии (SHA-256 хеш на токена, срок 30 дни)                                                                                  | уникален `tokenHash`, FK → User (cascade)                                                          |
|            | `PasswordReset`                                                                          | еднократни кодове (хеш, 1 час)                                                                                              | уникален `tokenHash`                                                                               |
| Свят       | `World`                                                                                  | seed, размер, **часовник** (`tick`, `lastTickAt`, `tickIntervalMs`), макро (базова лихва, ценови индекс, EMA, кредит)       | един ред (id=1)                                                                                    |
|            | `TickRun`                                                                                | продължителност и фази на всеки тик (наблюдение)                                                                            | PK `tick`                                                                                          |
|            | `WorkerLease`                                                                            | лиз за единствен активен worker                                                                                             | PK `id`=1                                                                                          |
| Пари       | `Account`                                                                                | сметки на потребители, градове, компании, системни                                                                          | уникални `(ownerType, ownerId)`; CHECK `allowNegative OR balance >= 0`                             |
|            | `LedgerEntry`                                                                            | **финансов регистър**                                                                                                       | уникален `idempotencyKey`; CHECK `amount > 0`; индекси по `(from, id)`, `(to, id)`, `(kind, tick)` |
|            | `IdempotencyRecord`                                                                      | отговори на идемпотентни заявки                                                                                             | PK `(userId, key)`                                                                                 |
| Градове    | `City`                                                                                   | собственик, произход, **плочки (JSON)**, население, политики, статистика, производни слоеве, `version`, `lastTick`, дефицит | индекси `ownerId`, `(originX, originY)`                                                            |
|            | `Parcel`                                                                                 | собственост върху парцел 8×8                                                                                                | **PK `(px, py)`** – гарантира единствен собственик                                                 |
|            | `CityIssue`                                                                              | сигнали от гражданите: вид, плочка, степен 1–3, статус OPEN/FIXING/RESOLVED, подател, текст, ден на ремонта                 | индекс `(cityId, status)`; CHECK за степен, статус и цена ≥ 0                                      |
|            | `CityLink`                                                                               | магистрала между два града (дължина, цена, кой я е построил) – превозът между тях е по-евтин                                | уникален `(aId, bId)`; CHECK `aId < bId`, цена ≥ 0, дължина > 0                                    |
|            | `CityStat`                                                                               | времеви ред на статистиката                                                                                                 | PK `(cityId, tick)`                                                                                |
| Компании   | `Company`, `Shareholding`, `CompanyRole`                                                 | компании, акции (с резервирани), роли                                                                                       | CHECK `reserved <= shares`, `totalShares > 0`                                                      |
|            | `Facility`                                                                               | съоръжения (персонал, ток, състояние, модернизации)                                                                         | **уникален `(x, y)`**                                                                              |
|            | `Inventory`                                                                              | наличности по компания/град/стока (свободни + резервирани, средна себестойност)                                             | PK `(companyId, cityId, good)`; CHECK ≥ 0                                                          |
|            | `CompanyStat`                                                                            | дневни отчети                                                                                                               | PK `(companyId, tick)`                                                                             |
| Пазар      | `MarketState`                                                                            | референтна/последна цена, обеми по инструмент                                                                               | PK `instrument`                                                                                    |
|            | `MarketOrder`                                                                            | поръчки (ескроу, остатък)                                                                                                   | CHECK `0 <= remaining <= quantity`, `escrow >= 0`; индекс `(instrument, side, status, price)`      |
|            | `Trade`, `PriceHistory`, `Shipment`                                                      | сделки, история на цените, доставки                                                                                         | индекси по инструмент, статус/падеж                                                                |
| Финанси    | `Loan`                                                                                   | кредити                                                                                                                     | CHECK `outstanding >= 0`; индекс `(status, nextDueTick)`                                           |
|            | `Contract`                                                                               | договори за доставка                                                                                                        | индекс `(status, nextDueTick)`                                                                     |
| Управление | `Proposal`, `Vote`                                                                       | предложения и гласове                                                                                                       | PK `(proposalId, voterId)`                                                                         |
| Иновации   | `ResearchProject`, `Patent`, `License`                                                   | изследвания, патенти, лицензи                                                                                               | уникален `Patent.techId`                                                                           |
| Дипломация | `Alliance`, `AllianceMember`, `AllianceInvite`, `AllianceSanction`                       | съюзи                                                                                                                       | уникален `AllianceMember.userId` (един съюз)                                                       |
| Социални   | `ChatMessage`, `Friendship`, `Block`, `Report`, `Notification`, `WorldEvent`, `AuditLog` | комуникация, модерация, известия, новини, журнал                                                                            | индекси по канал/потребител                                                                        |

`City.lastBuild` (JSON) пази последното строителство на града – предишното и новото състояние на засегнатите плочки и цената – за „Отмени“ (виж `undoBuild`). Миграции `20261111180000_city_links` и `20261111190000_city_undo` (само добавящи).

Ограниченията CHECK са в миграцията `20261110210000_integrity_constraints` – защита на ниво база, независимо от приложния код.

## Финансов регистър

`transfer(tx, {from, to, amount, kind, key, tick, ref})` в `packages/domain/src/ledger.ts`:

1. `INSERT … ON CONFLICT (idempotencyKey) DO NOTHING RETURNING id` – ако записът съществува, операцията е вече изпълнена (повторен опит/рестарт) и не се прави нищо.
2. `UPDATE Account SET balance = balance − amount WHERE id = from AND (allowNegative OR balance >= amount)` – при 0 засегнати реда се хвърля `INSUFFICIENT_FUNDS` и **цялата транзакция** (включително записа) се отменя.
3. `UPDATE Account SET balance = balance + amount WHERE id = to`.

`tryTransfer` заключва сметката (`FOR UPDATE`) и проверява наличността, без да прекъсва транзакцията (за дневните разходи на worker-а; позволява частично плащане при ликвидация).

Ключовете са детерминистични: `city:<id>:<tick>:in:income_tax`, `fac:<id>:<tick>:WAGES`, `trade:<id>:proceeds`, `loanpay:<id>:<dueTick>` и т.н. – повторно изпълнение на тик не дублира плащания (интеграционен тест).

## Конкурентност

- **Градове:** редакциите на играча заключват реда (`SELECT … FOR UPDATE`) и увеличават `version`; worker-ът записва с `UPDATE … WHERE version = v AND lastTick = t` и при конфликт преизчислява.
- **Пазар:** `pg_advisory_xact_lock(hashtext(instrument))` сериализира съпоставянето на един инструмент; насрещните поръчки се заключват с `FOR UPDATE`; резервирането е условно (`quantity >= q`).
- **Парцели и съоръжения:** уникални ключове – вторият едновременен опит получава конфликт (409).
- **Кредити:** advisory lock по кредитополучател – паралелните заявки не надвишават лимита.
- `withTx` повтаря транзакцията при deadlock/serialization failure (до 3 пъти).

## Миграции

```bash
npm run db:migrate:dev -- --name <име>   # разработка: създава и прилага миграция
npm run db:migrate                        # production/CI: prisma migrate deploy
```

Миграциите са в `packages/database/prisma/migrations` и се комитват. Docker образът прилага `prisma migrate deploy` при стартиране на API. Правило: само добавящи (backward-compatible) промени между версии; разрушителни промени – на две стъпки (нова колона → миграция на данни → премахване в следваща версия).

## Запазване

Всяко действие на играча е транзакция в базата (няма критично състояние само в паметта или в браузъра). Worker-ът записва след всеки тик; при рестарт всичко се зарежда от базата.

## Резервни копия и възстановяване

- `npm run db:backup` – логическо копие (gzip JSON) в консистентен снимък (`REPEATABLE READ READ ONLY`) – `scripts/backup-lib.mjs`. Не изисква `pg_dump`.
- `node scripts/db-restore.mjs <файл> --yes` – в една транзакция: проверка на схемата, `TRUNCATE`, вмъкване по реда на външните ключове, синхронизиране на броячите. При грешка – пълен rollback.
- Процедурата е проверена с интеграционен тест (`tests/integration/backup.test.ts`): копие → промени → възстановяване → идентични бройки, тик и инварианти → нови записи без конфликт на броячите.
- В production: включете ежедневните автоматични копия на платформата + периодичен `pg_dump -Fc` (виж docs/deployment).
