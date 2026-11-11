# API

База: `/api`. Формат: JSON. Пари: цели центове. Автентикация: `Authorization: Bearer <token>` (получава се от `register`/`login`). Всички маршрути изискват вход, освен отбелязаните „публичен“.

## Общи правила

- **Валидиране:** zod схеми от `packages/shared/src/validation.ts` на границата на системата.
- **Грешки:** `{ statusCode, code, message }`. Кодове: `VALIDATION` (400), `UNAUTHORIZED` (401), `INSUFFICIENT_FUNDS` (402), `FORBIDDEN` (403), `NOT_FOUND` (404), `CONFLICT`/`INSUFFICIENT_GOODS` (409), `RATE_LIMIT` (429), `INTERNAL` (500).
- **Идемпотентност:** заглавка `Idempotency-Key` (до 120 знака) за строителство, парцели, компании, поръчки, кредити, погасяване, преводи. Повторна заявка със същия ключ връща записания отговор.
- **Лимити:** глобално 300 заявки/мин на IP (`RATE_LIMIT_PER_MIN`); вход/регистрация 10/мин; смяна на парола 5/мин; поръчки 30/мин; чат 20/мин (+ 6 съобщения/10 s); основаване на град 5/мин.

## Маршрути

### Автентикация

| Метод | Път           | Тяло                                                                                      | Бележки          |
| ----- | ------------- | ----------------------------------------------------------------------------------------- | ---------------- |
| POST  | `/auth/guest` | създава автоматичен играч (без регистрация) и връща дълга сесия; ограничен на 5/мин от IP |
| GET   | `/auth/me`    | —                                                                                         | `{user, wallet}` |

### Свят и аналитика

| GET | `/world`                            | публичен: seed, размер, тик, интервал, базова лихва                 |
| --- | ----------------------------------- | ------------------------------------------------------------------- |
| GET | `/catalog`                          | публичен: стоки, зони, услуги, предприятия, технологии, баланс      |
| GET | `/world/region?x0&y0&x1&y1`         | публичен: парцели и плочки на градовете (макс. 256×256)             |
| GET | `/world/parcel-price?cityId&px&py`  | публичен: цена и профил на парцел                                   |
| GET | `/news`                             | публичен: световни събития                                          |
| GET | `/analytics/overview`               | публичен: население, БВП, ценови индекс, кредит, пари, време за тик |
| GET | `/analytics/leaderboard`            | публичен                                                            |
| GET | `/analytics/invest?cityId&type&x&y` | инвестиционен симулатор                                             |
| GET | `/wallet`                           | портфейл и история                                                  |

### Градове

| GET   | `/cities?mine=1`                  | списък (свои или всички)                                                                                                                                                       |
| ----- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| POST  | `/cities`                         | `{name, x?, y?}` – основаване                                                                                                                                                  |
| GET   | `/cities/:id`                     | пълен изглед за собственика; публичен подмножество за другите                                                                                                                  |
| GET   | `/cities/:id/layers`              | слоеве (само собственик)                                                                                                                                                       |
| GET   | `/cities/:id/issues`              | сигнали от гражданите: `{open, recent}` (само собственик)                                                                                                                      |
| POST  | `/cities/:id/issues/:issueId/fix` | изпраща ремонтен екип; таксува бюджета (цена × степен); идемпотентно                                                                                                           |
| GET   | `/cities/:id/history?days`        | времеви ред + прогноза (финансите само за собственика)                                                                                                                         |
| GET   | `/cities/:id/events`              | събития                                                                                                                                                                        |
| GET   | `/cities/:id/finance`             | регистър и кредитна оферта (само собственик)                                                                                                                                   |
| POST  | `/cities/:id/build`               | `{action:'road'                                                                                                                                                                | 'junction' | 'zone' | 'dezone' | 'service' | 'bulldoze', tiles:[{x,y}], roadClass?:'street' | 'avenue' | 'highway' | 'rural' | 'industrial', control?:'roundabout' | 'signals' | 'none', zone?, service?}` – смяна на категорията на път плаща разликата; кръстовище изисква ≥3 съседни пътя |
| POST  | `/cities/:id/build` (още)         | `{action:'sidewalk', remove?, tiles}` – тротоари върху път / пешеходна алея на празна земя; `{action:'busstop', remove?, tiles:[{x,y}]}` – автобусна спирка (не на кръстовище) |
| POST  | `/cities/:id/undo`                | „Отмени“ последното строителство: връща плочките и парите, ако градът не се е променил след това (същия или следващия игрови ден)                                              |
| POST  | `/cities/:id/links`               | `{toCityId}` – магистрала до друг град (цена 150 € × разстояние, до 160 плочки); превозът на стоки между двата града е 50% по-евтин                                            |
| GET   | `/world/links`                    | всички магистрали (за картата)                                                                                                                                                 |
| POST  | `/cities/:id/parcels`             | `{px, py}` – съседен парцел                                                                                                                                                    |
| PATCH | `/cities/:id/policy`              | данъци, бюджет, субсидии, тарифи, мито, санкции, енергиен приоритет                                                                                                            |
| POST  | `/cities/:id/funding`             | `{amount}` от портфейла                                                                                                                                                        |
| POST  | `/cities/:id/public-research`     | `{techId}` (изисква университет)                                                                                                                                               |

### Компании, производство, иновации

| GET    | `/companies` · `/companies/mine` · `/companies/:id`   | публична/поверителна информация според ролята |
| ------ | ----------------------------------------------------- | --------------------------------------------- |
| POST   | `/companies`                                          | `{name, hqCityId, capital}`                   |
| POST   | `/companies/:id/facilities`                           | `{cityId, type, x, y}` (право `operate`)      |
| POST   | `/companies/facilities/:fid/upgrade`                  | изразходва 5 машини                           |
| POST   | `/companies/:id/research`                             | `{techId}` (право `research`)                 |
| GET    | `/companies/:id/ledger`                               | регистър (само роли)                          |
| GET    | `/tech`                                               | технологии и патенти                          |
| POST   | `/tech/patents/:id/fee` · `/tech/patents/:id/license` | такса / лиценз                                |
| DELETE | `/tech/patents/:id/license/:companyId`                | прекратяване                                  |

### Пазар и договори

| GET      | `/market/summary` · `/market/book/:instrument` | публични                      |
| -------- | ---------------------------------------------- | ----------------------------- |
| GET      | `/market/orders`                               | моите отворени поръчки        |
| POST     | `/market/orders`                               | `{instrument:'GOOD:<id>'      | 'SHARE:<companyId>', side, quantity, price, companyId?, cityId?}` |
| DELETE   | `/market/orders/:id`                           | отмяна (връща ескроу/резерва) |
| GET/POST | `/contracts`                                   | списък / оферта               |
| POST     | `/contracts/:id/accept                         | reject                        | cancel                                                            | terminate` |     |

### Банка

| GET | `/bank/offer?type=COMPANY|CITY&id` | рейтинг, лихва, лимит |
| --- | --- | --- |
| GET/POST | `/bank/loans` | `{borrowerType, borrowerId, amount, termDays}` |
| POST | `/bank/loans/:id/repay` · `/bank/loans/:id/restructure` | |

### Управление, дипломация, социални

| GET/POST | `/proposals` | `{scopeType:'COMPANY'|'ALLIANCE', scopeId, kind, payload}` |
| --- | --- | --- |
| POST | `/proposals/:id/vote` | `{approve}` |
| GET/POST | `/alliances` · `/alliances/:id/invite` · `/alliances/invites/:id/accept|decline` · `/alliances/leave` | |
| GET/POST | `/social/chat?channel` | канали: `global`, `dm:<userId>`, `company:<id>`, `alliance:<id>` |
| GET/POST | `/social/friends` · `POST /social/block/:userId` · `POST /social/report` | |
| POST | `/social/moderate/:userId` | `{minutes}` – само ADMIN |
| GET/POST | `/social/notifications` · `/social/notifications/read` | |
| GET | `/social/users?q` | търсене по име |
| GET | `/health` · `/metrics` | публични: състояние на базата и симулацията; метрики |

## WebSocket (socket.io, път `/socket.io`)

Свързване: `io({ path: '/socket.io', auth: { token } })`. Събития от сървъра:

| Събитие        | Стая        | Данни                                                  |
| -------------- | ----------- | ------------------------------------------------------ |
| `tick`         | всички      | `{tick}` – нов игрови ден                              |
| `city`         | собственика | `{cityId}` – градът е обновен                          |
| `cityChanged`  | всички      | `{cityId}` – за обновяване на картата                  |
| `market`       | всички      | `{instrument}` – промяна в книгата                     |
| `notification` | потребителя | `{kind, message}`                                      |
| `chat`         | канала      | `{id, channel, senderId, senderName, body, createdAt}` |

Клиент → сървър: `join(channel)` – абониране за корпоративен/съюзен канал (сървърът проверява правата). Изпращането на съобщения е през REST (валидиране и лимити). При прекъсване клиентът се свързва отново автоматично и презарежда данните при следващия тик.
