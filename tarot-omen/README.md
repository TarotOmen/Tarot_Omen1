# Tarot Omen — Telegram Mini App

MVP: вопрос пользователя → случайный расклад из 3 карт (Rider-Waite, 78 карт) →
анимация тасования и открытия → AI-интерпретация именно этого вопроса и этих карт
(через Anthropic API, ключ хранится только на сервере).

## Структура проекта

```
tarot-omen/
├── frontend/              React + TypeScript + Vite, Telegram Mini Apps API
│   ├── src/
│   │   ├── components/    QuestionScreen, RevealScreen, InterpretationScreen, CardView
│   │   ├── data/cards.ts  полная колода из 78 карт + логика случайного выбора
│   │   ├── telegram.ts    интеграция с Telegram WebApp (theme, haptics, share)
│   │   └── styles/        dark premium стили
│   └── api/interpret.js   ← serverless-функция для деплоя на Vercel (вариант 1)
└── backend/                отдельный Express-сервер (вариант 2, для Railway/Render/VPS)
    └── server.js
```

Оба backend-варианта (`frontend/api/interpret.js` и `backend/server.js`) делают одно
и то же: принимают вопрос + 3 карты, вызывают Claude, возвращают текст интерпретации.
Нужен только один из них — какой вам удобнее деплоить.

## Важно: что я не смог сделать сам

В этой среде у меня нет доступа к сети (нельзя выполнить `npm install`, вызвать
Anthropic API, задеплоить на хостинг или открыть настоящий Telegram-бот). Поэтому:

- Код написан полностью и готов к запуску, но **не собирался и не тестировался
  автоматически** — перед первым запуском стоит выполнить `npm run build` у себя
  и проверить консоль на ошибки.
- Деплой, привязку к боту и добавление `ANTHROPIC_API_KEY` нужно сделать вам —
  ниже пошагово, это занимает 10–15 минут.

## 1. Запуск локально

```bash
# backend (вариант с отдельным сервером)
cd tarot-omen/backend
cp .env.example .env       # впишите свой ANTHROPIC_API_KEY
npm install
npm run dev                # слушает http://localhost:8787

# frontend, в новом терминале
cd tarot-omen/frontend
cp .env.example .env       # VITE_API_BASE_URL=http://localhost:8787
npm install
npm run dev                # http://localhost:5173
```

Откройте `http://localhost:5173` в браузере — приложение работает и вне Telegram
(просто не будет темы/haptics от Telegram, это нормально).

## 2. Деплой — рекомендуемый способ (Vercel, один проект)

Самый простой путь: задеплоить папку `frontend/` целиком на Vercel — она уже
содержит `api/interpret.js`, который Vercel автоматически превратит в serverless-
эндпоинт `/api/interpret`. Отдельный backend-сервер тогда не нужен.

1. Залейте `tarot-omen/frontend` в GitHub-репозиторий (или используйте Vercel CLI
   без гита: `npx vercel` из папки `frontend`).
2. На [vercel.com](https://vercel.com) → New Project → импортируйте репозиторий.
3. Framework Preset: Vite (определится автоматически).
4. В Project Settings → Environment Variables добавьте:
   - `ANTHROPIC_API_KEY` — ваш ключ Anthropic API (обязательно).
5. Deploy. После сборки Vercel даст вам HTTPS URL вида
   `https://tarot-omen.vercel.app` — это и есть URL вашего Mini App.
6. `VITE_API_BASE_URL` можно оставить пустым — фронтенд и `/api` живут на одном
   домене, отдельный базовый URL не нужен.

### Альтернатива: раздельный деплой

Если хотите отдельно хостить backend (Railway, Render, свой VPS):

1. Задеплойте `tarot-omen/backend` (например, Railway → New Project → Deploy from
   repo → укажите `backend/` как root). Добавьте переменную `ANTHROPIC_API_KEY` и,
   по желанию, `ALLOWED_ORIGIN` (URL вашего фронтенда).
2. Задеплойте `tarot-omen/frontend` отдельно (Vercel/Netlify), указав
   `VITE_API_BASE_URL=https://<ваш-backend-url>`.

## 3. Подключение к уже существующему Telegram-боту

Бот уже создан, новый создавать не нужно — просто указываем ему адрес Mini App:

1. Откройте [@BotFather](https://t.me/BotFather) в Telegram.
2. Отправьте `/mybots` → выберите вашего бота.
3. **Bot Settings → Menu Button → Configure Menu Button** (или `/setmenubutton` в
   старых версиях интерфейса).
4. В качестве URL укажите ваш задеплоенный адрес, например
   `https://tarot-omen.vercel.app` — обязательно `https://`.
5. Задайте текст кнопки, например `🔮 Tarot Omen`.
6. (Опционально) `/newapp` в BotFather позволяет также зарегистрировать Mini App
   отдельной записью (с иконкой и описанием) и получить прямую deep-link ссылку
   `t.me/<bot>/<shortname>` — удобно для кнопки Share.
7. Откройте вашего бота в Telegram → нажмите кнопку меню → приложение откроется
   внутри Telegram, определит `Telegram.WebApp` и применит тему.

## 4. Что нужно лично от вас

- **`ANTHROPIC_API_KEY`** — без него `/api/interpret` вернёт понятную ошибку
  ("Server is not configured with an API key yet"), но приложение не упадёт.
  Получить ключ: [console.anthropic.com](https://console.anthropic.com).
- Выполнить `npm install` и деплой (шаги выше) — я не могу обратиться к npm-
  registry или к хостингам из этой среды.
- После первого деплоя — проверить полный сценарий вживую (вопрос → Reveal →
  анимация → интерпретация → Share) и сообщить, если что-то ведёт себя не так;
  я поправлю код.

## Что сознательно не добавлено (по ТЗ)

Регистрация, аккаунты, подписки, платежи, Stars, реклама, история раскладов,
профили, астрология/нумерология/руны, доп. колоды, web research, соц. рейтинги,
сложная админка — ничего этого в MVP нет, как и просили.
