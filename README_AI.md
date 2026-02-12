# DevBrief (Obsidian Plugin) — описание для API

Этот документ описывает поведение плагина, форматы данных и ожидания от API.
Цель — реализовать сервис, который корректно принимает данные от плагина:
- транскрибирует аудио,
- суммаризирует тексты,
- ведёт чат с агентом с учётом суммари.

## 1. Назначение плагина

DevBrief помогает разработчику быстро:
- собрать контекст папки (markdown + excalidraw + транскрипции аудио),
- получить саммари в той же папке,
- вести чат с агентом, используя саммари как контекст,
- сохранять выбранные ответы агента в папку проекта.

## 2. Поведение в Obsidian

### 2.1. Выбор рабочей папки
- При клике на иконку чата (sparkles) всегда открывается модалка выбора папки.
- Далее, в зависимости от наличия саммари:
  - если саммари нет — оно создаётся и потом открывается чат,
  - если саммари есть — чат открывается сразу.

### 2.2. Саммари
- Саммари сохраняется в файл (по умолчанию `_summary.md`) в выбранной папке.
- Саммари создаётся через API суммаризации.

### 2.3. Чат
- Чат отправляет на API историю сообщений + текст саммари.
- Ответ агента показывается в чате.
- Под каждым ответом агента есть кнопка «Сохранить».
  - При нажатии ответ сохраняется в файл в той же папке.
  - Формат имени файла: `ai-response-DD-MM-YYThh-mm-ss.md`
  - Пример: `ai-response-09-02-26T14-05-33.md`

## 3. Типы файлов

Плагин ищет файлы в выбранной папке (рекурсивно) и делит их на:

1. **Текстовые**
   - `.md` (обычные markdown)
   - `.excalidraw.md`

2. **Аудио**
   - `mp3`, `wav`, `m4a`, `aac`, `ogg`, `flac`, `opus`, `webm`

3. **Остальные**
   - игнорируются

## 4. Настройки плагина

Плагин использует единый `API host` и `API key`, но разные URI:

- `apiTranscriptionPath` — транскрипция аудио
- `apiSummaryPath` — суммаризация текста
- `apiChatPath` — чат с агентом

Примеры значений:
- `API host`: `https://api.example.com`
- `Transcription endpoint path`: `/transcriptions`
- `Summary endpoint path`: `/summaries`
- `Chat endpoint path`: `/chat`

## 5. Контракты API

Ниже приведён рекомендуемый формат запросов и ответов.
Он соответствует текущей реализации плагина.

### 5.1. Транскрипция аудио

**Endpoint:** `POST {API_HOST}{apiTranscriptionPath}`

**Request JSON:**
```json
{
  "path": "project/audio/meeting.m4a",
  "name": "meeting.m4a",
  "data": "<base64>"
}
```

**Response JSON (любой из вариантов):**
```json
{ "text": "..." }
```
или
```json
{ "transcript": "..." }
```
или
```json
{ "transcription": "..." }
```

Плагин берёт первое непустое поле из `text | transcript | transcription`.

### 5.2. Суммаризация папки

**Endpoint:** `POST {API_HOST}{apiSummaryPath}`

**Request JSON:**
```json
{
  "folderPath": "project/docs",
  "files": [
    {
      "path": "project/docs/README.md",
      "kind": "markdown",
      "content": "# Title\n..."
    },
    {
      "path": "project/docs/diagram.excalidraw.md",
      "kind": "excalidraw",
      "content": "{...}"
    },
    {
      "path": "project/docs/meeting.m4a",
      "kind": "audio_transcript",
      "content": "Текст транскрипции..."
    }
  ]
}
```

**Response JSON:**
```json
{ "summary": "# Summary\n..." }
```

Плагин ожидает строку в поле `summary`.

### 5.3. Чат с агентом (WebSocket по умолчанию)

Плагин сначала пытается подключиться к:

**Endpoint (WS):** `GET ws(s)://{API_HOST}{apiChatPath}?websocket=True`

Если WS недоступен, используется fallback:

**Endpoint (HTTP):** `POST {API_HOST}{apiChatPath}`

#### 5.3.1. WebSocket request (первое сообщение клиента)

После открытия WS плагин отправляет JSON:
```json
{
  "summary": "# Summary\n...",
  "messages": [
    { "role": "system", "content": "You are a helpful assistant..." },
    { "role": "user", "content": "С чего начать?" }
  ],
  "apiKey": "sk-..."
}
```

`apiKey` может отсутствовать, если не задан в настройках.

#### 5.3.2. WebSocket response (сообщения сервера)

Поддерживаемые форматы:

1) Chunk:
```json
{ "type": "chunk", "text": "..." }
```

2) Done:
```json
{ "type": "done" }
```

3) Error:
```json
{ "type": "error", "message": "..." }
```

Также допускаются:
- plain text чанки (строка),
- маркеры завершения строкой: `[DONE]` или `__DONE__`.

#### 5.3.3. HTTP fallback request/response

**Request JSON:**
```json
{
  "summary": "# Summary\n...",
  "messages": [
    { "role": "system", "content": "You are a helpful assistant..." },
    { "role": "user", "content": "С чего начать?" }
  ]
}
```

**Response JSON (любой из вариантов):**
```json
{ "message": "..." }
```
или
```json
{ "response": "..." }
```
или
```json
{ "content": "..." }
```

Плагин берёт первое непустое поле из `message | response | content`.

## 6. Аутентификация

Для HTTP (`/summaries`, `/transcriptions`, HTTP fallback `/chat`) при заданном `API key`
плагин добавляет заголовок:

```
Authorization: Bearer <API_KEY>
```

Для WebSocket (`/chat?websocket=True`) `apiKey` передаётся в первом JSON-сообщении клиента
в поле `apiKey`.

## 7. Ошибки

Если API вернул код, отличный от 2xx:
- суммаризация и чат выбрасывают ошибку (ошибка видна в консоли Obsidian),
- транскрипция тоже выбрасывает ошибку.

Рекомендуется на стороне API:
- возвращать читаемые сообщения об ошибке,
- не отдавать огромные payload при ошибках.

## 8. Примечания по реализации API

- Плагин отправляет **весь контент файлов** без предварительной фильтрации.
- Для аудио используется base64.
- Для chat API в запросе всегда есть `summary` и массив `messages`.
- Саммари хранится в файле в папке проекта и используется как контекст.
