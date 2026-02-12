import {
  App,
  Component,
  EventRef,
  FuzzySuggestModal,
  Menu,
  Modal,
  MarkdownRenderer,
  Notice,
  Plugin,
  PluginSettingTab,
  requestUrl,
  Setting,
  TAbstractFile,
  TFile,
  TFolder
} from "obsidian";

type SummaryFilePayload = {
  path: string;
  kind: "markdown" | "excalidraw" | "audio_transcript" | "text" | "image";
  content: string;
};

type SummaryPayload = {
  folderPath: string;
  files: SummaryFilePayload[];
};

type ChatMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

type ChatLogEntry = ChatMessage & {
  timestamp?: string;
};

type ChatApiResponse = {
  message: string;
  artifactPaths: string[];
};

type ChatTheme = "classic" | "glass" | "quiet";

type ExplorerContextMenuWorkspace = {
  on(
    name: "file-explorer-context-menu",
    callback: (menu: Menu, file: TAbstractFile | null) => void
  ): EventRef;
};

interface FolderSummarySettings {
  apiHost: string;
  apiKey: string;
  apiSummaryPath: string;
  apiTranscriptionPath: string;
  apiChatPath: string;
  summaryFileName: string;
  chatTheme: ChatTheme;
}

const DEFAULT_SETTINGS: FolderSummarySettings = {
  apiHost: "",
  apiKey: "",
  apiSummaryPath: "/summaries",
  apiTranscriptionPath: "/transcriptions",
  apiChatPath: "/chat",
  summaryFileName: "_summary.md",
  chatTheme: "quiet"
};

const CHAT_SYSTEM_PROMPT =
  "You are a helpful assistant. Use the provided folder summary as context.";

const SUPPORTED_AUDIO_EXTENSIONS = new Set([
  "mp3",
  "wav",
  "m4a",
  "ogg",
  "flac",
  "opus"
]);
const SUPPORTED_IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
const ALL_AUDIO_EXTENSIONS = new Set([
  "mp3",
  "wav",
  "m4a",
  "aac",
  "ogg",
  "flac",
  "opus",
  "webm"
]);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const CONTEXT_DIR = "4senseContext";
const ARTIFACTS_DIR = "artefacts";
const CHAT_LOG_PREFIX = "chat-";
const CHAT_STATE_FILE = "chat-state.json";
const SNAPSHOT_FILE = "snapshot.json";
const STREAM_RENDER_INTERVAL_MS = 120;
const STREAM_TYPING_TICK_MS = Math.max(24, Math.floor(STREAM_RENDER_INTERVAL_MS / 4));
const STREAM_TYPING_BASE_STEP = 2;
const STREAM_TYPING_CATCHUP_WINDOW = 20;
const CHAT_WEBSOCKET_QUERY_PARAM = "websocket";
const CHAT_WEBSOCKET_QUERY_VALUE = "True";
const CHAT_WEBSOCKET_OPEN_TIMEOUT_MS = 8000;

export default class FolderSummaryPlugin extends Plugin {
  settings: FolderSummarySettings;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.addSettingTab(new FolderSummarySettingTab(this.app, this));

    this.addCommand({
      id: "summarize-folder-select",
      name: "Summarize folder (select)",
      callback: () => this.openFolderSelectModal(folder => this.summarizeFolder(folder))
    });

    this.addCommand({
      id: "summarize-current-folder",
      name: "Summarize current file folder",
      callback: () => this.summarizeCurrentFileFolder()
    });

    this.app.workspace.onLayoutReady(() => this.registerUiActions());
  }

  onunload(): void {}

  private async summarizeCurrentFileFolder(): Promise<void> {
    const folder = this.getCurrentFileFolder();
    if (!folder) {
      new Notice("No active file to determine folder.");
      return;
    }
    await this.summarizeFolder(folder);
  }

  private getCurrentFileFolder(): TFolder | null {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) {
      return null;
    }
    const parent = activeFile.parent;
    return parent instanceof TFolder ? parent : null;
  }

  private openFolderSelectModal(onSelect: (folder: TFolder) => void): void {
    const modal = new FolderSuggestModal(this.app, onSelect);
    modal.open();
  }

  private registerUiActions(): void {
    this.addRibbonIcon("sparkles", "Chat with assistant", () => {
      this.openFolderSelectModal(selected => this.openChatForFolder(selected));
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        const folder = this.resolveFolderFromAbstractFile(file);
        if (!folder) {
          return;
        }
        menu.addItem(item =>
          item
            .setTitle("4Sense: Chat with assistant")
            .setIcon("sparkles")
            .onClick(() => this.openChatForFolder(folder))
        );
      })
    );

    const workspace = this.app.workspace as unknown as ExplorerContextMenuWorkspace;
    this.registerEvent(
      workspace.on("file-explorer-context-menu", (menu, file) => {
        const folder = this.resolveFolderFromAbstractFile(file);
        if (!folder) {
          return;
        }
        menu.addItem(item =>
          item
            .setTitle("4Sense: Chat with assistant")
            .setIcon("sparkles")
            .onClick(() => this.openChatForFolder(folder))
        );
      })
    );
  }

  private resolveFolderFromAbstractFile(
    file: TAbstractFile | null
  ): TFolder | null {
    if (!file) {
      return null;
    }
    if (file instanceof TFolder) {
      return file;
    }
    if (file instanceof TFile && file.parent instanceof TFolder) {
      return file.parent;
    }
    return null;
  }

  private async summarizeFolder(folder: TFolder, filesOverride?: TFile[]): Promise<void> {
    const progress = new StepProgressModal(this.app);
    progress.open();
    try {
      progress.setStatus("Сканирую файлы...");
      const files = filesOverride ?? this.collectFilesInFolder(folder);
      const {
        textFiles,
        audioFiles,
        imageFiles,
        unsupportedAudioFiles,
        skippedFiles
      } = this.splitFiles(files);
      if (textFiles.length === 0 && audioFiles.length === 0 && imageFiles.length === 0) {
        new Notice("No supported files found in the selected folder.");
        return;
      }

      if (unsupportedAudioFiles.length > 0) {
        const names = unsupportedAudioFiles
          .map(file => file.name)
          .slice(0, 3)
          .join(", ");
        const more =
          unsupportedAudioFiles.length > 3
            ? ` (+${unsupportedAudioFiles.length - 3} more)`
            : "";
        new Notice(`Unsupported audio formats: ${names}${more}`);
      }

      if (skippedFiles.length > 0) {
        new Notice(`Skipping ${skippedFiles.length} unsupported files.`);
      }

      progress.setStatus("Готовлю данные...");
      // Build payload in a stable file order to keep summaries deterministic.
      const payload = await this.buildSummaryPayload(
        folder,
        files,
        audioFiles.length,
        imageFiles,
        (step: string) => progress.setStatus(step)
      );

      progress.setStatus("Отправляю данные на суммаризацию...");
      const summary = await this.callSummaryApi(payload);

      progress.setStatus("Сохраняю саммари...");
      await this.writeSummaryFile(folder, summary);
      await this.writeSnapshot(folder, files);
      new Notice("Summary saved.");
    } catch (error) {
      this.showErrorModal(error);
    } finally {
      progress.close();
    }
  }

  private collectFilesInFolder(folder: TFolder): TFile[] {
    const contextPath = this.getContextPath(folder);
    const artifactsPath = this.getArtifactsPath(folder);
    const summaryPath = `${contextPath}/${this.settings.summaryFileName}`;
    const files: TFile[] = [];
    const traverse = (node: TFolder): void => {
      for (const child of node.children) {
        if (child instanceof TFolder) {
          if (
            child.path === contextPath ||
            child.path.startsWith(`${contextPath}-`) ||
            child.path === artifactsPath ||
            child.path.startsWith(`${artifactsPath}/`)
          ) {
            continue;
          }
          traverse(child);
          continue;
        }
        if (!(child instanceof TFile)) {
          continue;
        }
        if (
          child.path === summaryPath ||
          child.path.startsWith(`${contextPath}/`) ||
          child.path.startsWith(`${contextPath}-`) ||
          child.path.startsWith(`${artifactsPath}/`)
        ) {
          continue;
        }
        files.push(child);
      }
    };
    traverse(folder);
    files.sort((a, b) => a.stat.ctime - b.stat.ctime);
    return files;
  }

  private async buildSummaryPayload(
    folder: TFolder,
    orderedFiles: TFile[],
    totalAudioFiles: number,
    imageFiles: TFile[],
    onStep?: (step: string) => void
  ): Promise<SummaryPayload> {
    const filePayloads: SummaryFilePayload[] = [];
    const imageSet = new Set(imageFiles.map(file => file.path));
    let audioIndex = 0;
    for (const file of orderedFiles) {
      if (this.isMarkdownFile(file)) {
        const content = await this.app.vault.read(file);
        filePayloads.push({
          path: file.path,
          kind: this.isExcalidrawFile(file) ? "excalidraw" : "markdown",
          content
        });
        continue;
      }
      if (imageSet.has(file.path)) {
        const size = file.stat.size;
        if (size > MAX_IMAGE_BYTES) {
          if (onStep) {
            onStep(`Пропускаю большое изображение: ${file.name}`);
          }
          continue;
        }
        if (onStep) {
          onStep(`Добавляю изображение: ${file.name}`);
        }
        const base64 = arrayBufferToBase64(await this.app.vault.readBinary(file));
        filePayloads.push({
          path: file.path,
          kind: "image",
          content: base64
        });
        continue;
      }
      if (this.isSupportedAudioFile(file)) {
        audioIndex += 1;
        if (onStep) {
          onStep(
            `Транскрибирую аудио ${audioIndex}/${totalAudioFiles}: ${file.name}`
          );
        }
        // Transcribe audio sequentially to avoid flooding the API.
        const transcript = await this.callTranscriptionApi(file);
        if (!transcript) {
          continue;
        }
        filePayloads.push({
          path: file.path,
          kind: "audio_transcript",
          content: transcript
        });
      }
    }
    return {
      folderPath: folder.path,
      files: filePayloads
    };
  }

  private async callSummaryApi(payload: SummaryPayload): Promise<string> {
    if (!this.settings.apiHost) {
      throw new Error("API host is not configured. Set it in plugin settings.");
    }

    const url = this.buildApiUrl(this.settings.apiSummaryPath);
    const headers: Record<string, string> = {
      "Content-Type": "application/json"
    };
    if (this.settings.apiKey) {
      headers.Authorization = `Bearer ${this.settings.apiKey}`;
    }

    const result = await this.requestJson(url, headers, payload);
    if (
      typeof result === "object" &&
      result !== null &&
      typeof (result as { summary?: unknown }).summary === "string"
    ) {
      return (result as { summary: string }).summary;
    }
    throw new Error("Summary API returned an unexpected response.");
  }

  private async writeSummaryFile(folder: TFolder, summary: string): Promise<void> {
    await this.ensureContextFolder(folder);
    const summaryPath = this.getSummaryFilePath(folder);
    await this.replaceTextFile(summaryPath, summary);
  }

  private async replaceTextFile(path: string, content: string): Promise<void> {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await this.app.vault.process(existing, () => content);
      return;
    }
    await this.app.vault.create(path, content);
  }

  private async appendTextFile(
    path: string,
    content: string,
    prefixForCreate = ""
  ): Promise<void> {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await this.app.vault.process(existing, previous => previous + content);
      return;
    }
    await this.app.vault.create(path, `${prefixForCreate}${content}`);
  }

  private async openChatForFolder(folder: TFolder): Promise<void> {
    try {
      const files = this.collectFilesInFolder(folder);
      const snapshotState = await this.getSnapshotState(folder, files);
      if (snapshotState.changed) {
        // Archive context when folder contents changed to preserve prior chat state.
        await this.archiveContextFolder(folder);
        await this.ensureContextFolder(folder);
        await this.writeSnapshot(folder, files);
      } else if (!snapshotState.exists) {
        await this.ensureContextFolder(folder);
        await this.writeSnapshot(folder, files);
      }
      await this.ensureContextFolder(folder);
      await this.ensureArtifactsFolder(folder);

      let summary = await this.readSummaryFile(folder);
      if (!summary) {
        await this.summarizeFolder(folder, files);
        summary = await this.readSummaryFile(folder);
      }
      if (!summary) {
        new Notice("Summary file not found. Unable to open chat.");
        return;
      }

      const chatLogPath = await this.getOrCreateChatLog(folder);
      let history = await this.loadChatHistory(chatLogPath);
      if (history.length === 0) {
        // Migrate legacy JSON history into the current markdown log.
        const fallback = await this.findChatHistory(folder, chatLogPath, true);
        if (fallback) {
          history = this.stripTimestamps(fallback.entries);
          await this.writeChatLog(chatLogPath, fallback.entries);
        }
      }

      const modal = new ChatModal(
        this.app,
        this,
        summary,
        folder.name || folder.path || "",
        folder.path ?? "",
        this.settings.chatTheme,
        history,
        async (messages, summaryText, onChunk, signal) =>
          this.callChatApiStream(summaryText, messages, onChunk, signal),
        async content => this.saveAssistantResponse(folder, content),
        async (role, content) => this.appendChatLog(chatLogPath, role, content),
        async (paths, onStatus) =>
          this.downloadArtifacts(folder, paths, onStatus)
      );
      modal.open();
    } catch (error) {
      this.showErrorModal(error);
    }
  }

  private async readSummaryFile(folder: TFolder): Promise<string | null> {
    const summaryPath = this.getSummaryFilePath(folder);
    const file = this.app.vault.getAbstractFileByPath(summaryPath);
    if (!(file instanceof TFile)) {
      return null;
    }
    return this.app.vault.read(file);
  }

  private async callChatApi(
    summary: string,
    messages: ChatMessage[],
    signal?: AbortSignal
  ): Promise<ChatApiResponse> {
    void signal;
    if (!this.settings.apiHost) {
      throw new Error("API host is not configured. Set it in settings.");
    }

    const url = this.buildApiUrl(this.settings.apiChatPath);
    const headers: Record<string, string> = {
      "Content-Type": "application/json"
    };
    if (this.settings.apiKey) {
      headers.Authorization = `Bearer ${this.settings.apiKey}`;
    }

    const result = await this.requestJson(
      url,
      headers,
      { summary, messages: this.stripTimestamps(messages) },
      signal
    );
    const content =
      typeof result === "object" && result !== null
        ? (result as { message?: unknown; response?: unknown; content?: unknown })
            .message ??
          (result as { message?: unknown; response?: unknown; content?: unknown })
            .response ??
          (result as { message?: unknown; response?: unknown; content?: unknown })
            .content
        : undefined;
    if (typeof content === "string") {
      return {
        message: content,
        artifactPaths: this.extractArtifactPaths(content)
      };
    }

    throw new Error("Chat API returned an unexpected response.");
  }

  private async callChatApiStream(
    summary: string,
    messages: ChatMessage[],
    onChunk: (chunk: string) => void,
    signal?: AbortSignal
  ): Promise<ChatApiResponse> {
    try {
      return await this.callChatApiWebSocket(summary, messages, onChunk, signal);
    } catch (error) {
      if (this.isAbortError(error)) {
        throw error;
      }
      // Fallback to HTTP chat endpoint if websocket stream is unavailable.
      const response = await this.callChatApi(summary, messages, signal);
      if (response.message.length > 0) {
        onChunk(response.message);
      }
      return response;
    }
  }

  private async callChatApiWebSocket(
    summary: string,
    messages: ChatMessage[],
    onChunk: (chunk: string) => void,
    signal?: AbortSignal
  ): Promise<ChatApiResponse> {
    if (!this.settings.apiHost) {
      throw new Error("API host is not configured. Set it in settings.");
    }
    if (typeof WebSocket !== "function") {
      throw new Error("WebSocket is not available in this environment.");
    }

    const url = this.buildChatWebSocketUrl();
    const payload = JSON.stringify({
      summary,
      messages: this.stripTimestamps(messages),
      apiKey: this.settings.apiKey || undefined
    });

    return new Promise<ChatApiResponse>((resolve, reject) => {
      let settled = false;
      let fullText = "";
      const socket = new WebSocket(url);

      const cleanup = () => {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        if (signal) {
          signal.removeEventListener("abort", onAbort);
        }
        window.clearTimeout(openTimeout);
      };

      const resolveOnce = (result: ChatApiResponse) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(result);
      };

      const rejectOnce = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      };

      const finalizeWithText = (text: string) => {
        resolveOnce({
          message: text,
          artifactPaths: this.extractArtifactPaths(text)
        });
      };

      const onAbort = () => {
        try {
          socket.close(1000, "aborted");
        } catch {
          // no-op
        }
        rejectOnce(new Error("Request aborted"));
      };

      const handleFrame = (frame: unknown): void => {
        if (typeof frame === "string") {
          const trimmed = frame.trim();
          if (trimmed === "[DONE]" || trimmed === "__DONE__") {
            finalizeWithText(fullText);
            try {
              socket.close(1000, "done");
            } catch {
              // no-op
            }
            return;
          }
          fullText += frame;
          onChunk(frame);
          return;
        }

        if (!frame || typeof frame !== "object") {
          return;
        }

        const packet = frame as {
          type?: unknown;
          text?: unknown;
          message?: unknown;
          response?: unknown;
          content?: unknown;
          done?: unknown;
          error?: unknown;
        };

        if (packet.type === "error") {
          const detail =
            typeof packet.message === "string"
              ? packet.message
              : typeof packet.error === "string"
                ? packet.error
                : "Chat websocket error.";
          throw new Error(detail);
        }

        if (packet.type === "chunk") {
          const chunk = typeof packet.text === "string" ? packet.text : "";
          if (chunk.length > 0) {
            fullText += chunk;
            onChunk(chunk);
          }
          return;
        }

        if (packet.type === "done" || packet.done === true) {
          finalizeWithText(fullText);
          try {
            socket.close(1000, "done");
          } catch {
            // no-op
          }
          return;
        }

        const textCandidate =
          typeof packet.message === "string"
            ? packet.message
            : typeof packet.response === "string"
              ? packet.response
              : typeof packet.content === "string"
                ? packet.content
                : typeof packet.text === "string"
                  ? packet.text
                  : null;
        if (textCandidate !== null) {
          fullText += textCandidate;
          onChunk(textCandidate);
        }
      };

      const openTimeout = window.setTimeout(() => {
        try {
          socket.close();
        } catch {
          // no-op
        }
        rejectOnce(new Error("WebSocket connection timed out."));
      }, CHAT_WEBSOCKET_OPEN_TIMEOUT_MS);

      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }

      socket.onopen = () => {
        window.clearTimeout(openTimeout);
        socket.send(payload);
      };

      socket.onmessage = event => {
        if (settled) {
          return;
        }
        try {
          if (typeof event.data === "string") {
            const raw = event.data;
            try {
              handleFrame(JSON.parse(raw));
            } catch {
              handleFrame(raw);
            }
            return;
          }
          if (event.data instanceof ArrayBuffer) {
            const raw = new TextDecoder().decode(event.data);
            try {
              handleFrame(JSON.parse(raw));
            } catch {
              handleFrame(raw);
            }
            return;
          }
          handleFrame(String(event.data ?? ""));
        } catch (error) {
          rejectOnce(
            error instanceof Error ? error : new Error("Failed to process websocket frame.")
          );
        }
      };

      socket.onerror = () => {
        rejectOnce(new Error("WebSocket connection failed."));
      };

      socket.onclose = event => {
        if (settled) {
          return;
        }
        if (event.code === 1000) {
          finalizeWithText(fullText);
          return;
        }
        if (fullText.length > 0) {
          finalizeWithText(fullText);
          return;
        }
        rejectOnce(new Error(`WebSocket closed with code ${event.code}.`));
      };
    });
  }

  private async callTranscriptionApi(file: TFile): Promise<string | null> {
    if (!this.settings.apiHost) {
      throw new Error("API host is not configured. Set it in settings.");
    }
    const url = this.buildApiUrl(this.settings.apiTranscriptionPath);
    const audioBuffer = await this.app.vault.readBinary(file);
    const audioContentType = this.getAudioContentType(file);
    const body = {
      path: file.path,
      name: file.name,
      data: arrayBufferToBase64(audioBuffer),
      contentType: audioContentType
    };
    const headers: Record<string, string> = {
      "Content-Type": "application/json"
    };
    if (this.settings.apiKey) {
      headers.Authorization = `Bearer ${this.settings.apiKey}`;
    }
    headers["X-Audio-Content-Type"] = audioContentType;

    const result = await this.requestJson(url, headers, body);
    const transcript =
      typeof result === "object" && result !== null
        ? (result as { text?: unknown; transcript?: unknown; transcription?: unknown })
            .text ??
          (result as { text?: unknown; transcript?: unknown; transcription?: unknown })
            .transcript ??
          (result as { text?: unknown; transcript?: unknown; transcription?: unknown })
            .transcription ??
          null
        : null;
    if (typeof transcript === "string" && transcript.length > 0) {
      return transcript;
    }
    throw new Error("Transcription API returned an unexpected response.");
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private buildApiUrl(path: string): string {
    const host = this.settings.apiHost.trim();
    const base = host.endsWith("/") ? host : `${host}/`;
    const suffix = path.trim().replace(/^\/+/u, "");
    return new URL(suffix, base).toString();
  }

  private buildChatWebSocketUrl(): string {
    const httpUrl = this.buildApiUrl(this.settings.apiChatPath);
    const url = new URL(httpUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    if (!url.searchParams.has(CHAT_WEBSOCKET_QUERY_PARAM)) {
      url.searchParams.set(CHAT_WEBSOCKET_QUERY_PARAM, CHAT_WEBSOCKET_QUERY_VALUE);
    }
    return url.toString();
  }

  private getContextPath(folder: TFolder): string {
    const prefix = folder.path ? `${folder.path}/` : "";
    return `${prefix}${CONTEXT_DIR}`;
  }

  private getArtifactsPath(folder: TFolder): string {
    return `${this.getContextPath(folder)}/${ARTIFACTS_DIR}`;
  }

  private getSummaryFilePath(folder: TFolder): string {
    return `${this.getContextPath(folder)}/${this.settings.summaryFileName}`;
  }

  private async ensureFolderExists(path: string): Promise<void> {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFolder) {
      return;
    }
    if (existing) {
      throw new Error(`Path exists but is not a folder: ${path}`);
    }
    await this.app.vault.createFolder(path);
  }

  private async ensureContextFolder(folder: TFolder): Promise<void> {
    await this.ensureFolderExists(this.getContextPath(folder));
  }

  private async ensureArtifactsFolder(folder: TFolder): Promise<void> {
    await this.ensureFolderExists(this.getArtifactsPath(folder));
  }

  private async requestJson(
    url: string,
    headers: Record<string, string>,
    body: unknown,
    signal?: AbortSignal
  ): Promise<unknown> {
    void signal;
    const response = await requestUrl({
      url,
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });
    if (response.status < 200 || response.status >= 300) {
      const detail = this.extractErrorDetail(response);
      throw new Error(detail ?? `API error: ${response.status}`);
    }
    if (response.json) {
      return response.json;
    }
    try {
      return JSON.parse(response.text);
    } catch (error) {
      throw new Error("API returned non-JSON response.");
    }
  }

  private extractErrorDetail(response: {
    json?: unknown;
    text: string;
    status: number;
  }): string | null {
    const parsed =
      typeof response.json === "object" && response.json !== null
        ? (response.json as { detail?: unknown; message?: unknown })
        : null;
    const detail = parsed?.detail ?? parsed?.message;
    if (typeof detail === "string" && detail.trim().length > 0) {
      return detail.trim();
    }
    if (response.text && response.text.trim().length > 0) {
      return response.text.trim();
    }
    return null;
  }

  private showErrorModal(error: unknown): void {
    const message =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "Unknown error.";
    const modal = new ErrorModal(this.app, message);
    modal.open();
  }

  private isAbortError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }
    return error.message.toLowerCase().includes("abort");
  }

  private async getSnapshotState(
    folder: TFolder,
    files: TFile[]
  ): Promise<{ exists: boolean; changed: boolean }> {
    // Snapshot tracks file mtimes to detect when a summary/chat context is stale.
    const snapshot = await this.readSnapshot(folder);
    if (!snapshot) {
      return { exists: false, changed: false };
    }
    const currentMap = new Map(files.map(file => [file.path, file.stat.mtime]));
    if (snapshot.files.length !== currentMap.size) {
      return { exists: true, changed: true };
    }
    for (const entry of snapshot.files) {
      const currentMtime = currentMap.get(entry.path);
      if (currentMtime === undefined || currentMtime !== entry.mtime) {
        return { exists: true, changed: true };
      }
    }
    return { exists: true, changed: false };
  }

  private async readSnapshot(
    folder: TFolder
  ): Promise<{ files: { path: string; mtime: number }[] } | null> {
    const path = `${this.getContextPath(folder)}/${SNAPSHOT_FILE}`;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      return null;
    }
    try {
      const content = await this.app.vault.read(file);
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  private async writeSnapshot(folder: TFolder, files: TFile[]): Promise<void> {
    await this.ensureContextFolder(folder);
    const snapshot = {
      files: files.map(file => ({ path: file.path, mtime: file.stat.mtime }))
    };
    const path = `${this.getContextPath(folder)}/${SNAPSHOT_FILE}`;
    const content = JSON.stringify(snapshot, null, 2);
    await this.replaceTextFile(path, content);
  }

  private async archiveContextFolder(folder: TFolder): Promise<void> {
    const contextPath = this.getContextPath(folder);
    const existing = this.app.vault.getAbstractFileByPath(contextPath);
    if (!(existing instanceof TFolder)) {
      return;
    }
    // Keep historical context for comparison/review by timestamped archive.
    const archivedPath = `${contextPath}-${this.formatTimestamp(new Date())}`;
    await this.app.vault.rename(existing, archivedPath);
  }

  private async getOrCreateChatLog(folder: TFolder): Promise<string> {
    await this.ensureContextFolder(folder);
    const state = await this.readChatState(folder);
    if (state?.activeLogPath) {
      const existing = this.app.vault.getAbstractFileByPath(state.activeLogPath);
      if (existing instanceof TFile && existing.extension === "md") {
        return state.activeLogPath;
      }
    }
    const existing = this.getLatestChatLogPath(folder);
    if (existing) {
      await this.writeChatState(folder, existing);
      return existing;
    }
    const filename = `${CHAT_LOG_PREFIX}${this.formatTimestamp(new Date())}.md`;
    const path = `${this.getContextPath(folder)}/${filename}`;
    await this.app.vault.create(path, "# Chat history\n\n");
    await this.writeChatState(folder, path);
    return path;
  }

  private getLatestChatLogPath(folder: TFolder): string | null {
    const candidates = this.getChatLogCandidates(folder);
    if (candidates.length === 0) {
      return null;
    }
    candidates.sort((a, b) => b.stat.mtime - a.stat.mtime);
    return candidates[0].path;
  }

  private getChatLogCandidates(folder: TFolder, includeJson = false): TFile[] {
    const contextPath = this.getContextPath(folder);
    const candidates: TFile[] = [];
    const includeByExtension = (file: TFile): boolean =>
      includeJson
        ? file.extension === "md" || file.extension === "json"
        : file.extension === "md";
    const collectFromContextTree = (node: TFolder): void => {
      for (const child of node.children) {
        if (child instanceof TFolder) {
          collectFromContextTree(child);
          continue;
        }
        if (
          child instanceof TFile &&
          child.name.startsWith(CHAT_LOG_PREFIX) &&
          includeByExtension(child)
        ) {
          candidates.push(child);
        }
      }
    };
    const contextRoots = folder.children.filter(
      child =>
        child instanceof TFolder &&
        (child.path === contextPath || child.path.startsWith(`${contextPath}-`))
    ) as TFolder[];
    for (const root of contextRoots) {
      collectFromContextTree(root);
    }
    return candidates;
  }

  private async findChatHistory(
    folder: TFolder,
    currentPath: string,
    includeJson: boolean
  ): Promise<{ path: string; entries: ChatLogEntry[] } | null> {
    const candidates = this.getChatLogCandidates(folder, includeJson);
    if (candidates.length === 0) {
      return null;
    }
    candidates.sort((a, b) => b.stat.mtime - a.stat.mtime);
    for (const file of candidates) {
      if (file.path === currentPath) {
        continue;
      }
      const entries = await this.loadChatEntries(file.path);
      if (entries.length > 0) {
        return { path: file.path, entries };
      }
    }
    return null;
  }

  private async loadChatHistory(path: string): Promise<ChatMessage[]> {
    const entries = await this.loadChatEntries(path);
    return this.stripTimestamps(entries);
  }

  private async loadChatEntries(path: string): Promise<ChatLogEntry[]> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      return [];
    }
    const content = await this.app.vault.read(file);
    return this.parseChatLog(content);
  }

  private parseChatLog(content: string): ChatLogEntry[] {
    const trimmed = content.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      // Legacy JSON history support (migrated to markdown on open).
      try {
        const parsed = JSON.parse(trimmed) as
          | { messages?: unknown; history?: unknown; items?: unknown; log?: unknown }
          | unknown[];
        const rawItems = Array.isArray(parsed)
          ? parsed
          : (parsed.messages ??
              parsed.history ??
              parsed.items ??
              parsed.log ??
              []) as unknown;
        const items = Array.isArray(rawItems) ? rawItems : [];
        return items
          .map(item => {
            if (!item || typeof item !== "object") {
              return null;
            }
            const record = item as Record<string, unknown>;
            const role =
              record.role ?? record.type ?? record.author ?? record.sender ?? null;
            if (role !== "user" && role !== "assistant" && role !== "system") {
              return null;
            }
            const contentValue =
              record.content ?? record.text ?? record.message ?? "";
            if (typeof contentValue !== "string") {
              return null;
            }
            return {
              role,
              content: contentValue,
              timestamp: this.extractTimestamp(record)
            } as ChatLogEntry;
          })
          .filter((item): item is ChatLogEntry => Boolean(item));
      } catch {
        // fall through to markdown parsing
      }
    }
    const messages: ChatLogEntry[] = [];
    const lines = content.split(/\r?\n/);
    let currentRole: "user" | "assistant" | null = null;
    let currentTimestamp: string | undefined;
    let buffer: string[] = [];
    const flush = () => {
      if (currentRole && buffer.length > 0) {
        const text = buffer.join("\n").trim();
        if (text.length > 0) {
          messages.push({
            role: currentRole,
            content: text,
            timestamp: currentTimestamp
          });
        }
      }
    };
    for (const line of lines) {
      const match = line.match(/^## \[(.+)\] (user|assistant)$/u);
      if (match) {
        flush();
        currentRole = match[2] as "user" | "assistant";
        currentTimestamp = match[1];
        buffer = [];
        continue;
      }
      if (line.startsWith("# Chat history")) {
        continue;
      }
      buffer.push(line);
    }
    flush();
    return messages;
  }

  private async appendChatLog(
    path: string,
    role: "user" | "assistant",
    content: string
  ): Promise<void> {
    // Markdown log is the single source of truth for chat history.
    const timestamp = new Date().toISOString();
    const entry = `## [${timestamp}] ${role}\n${content}\n\n`;
    await this.appendTextFile(path, entry, "# Chat history\n\n");
  }

  private async writeChatLog(path: string, history: ChatLogEntry[]): Promise<void> {
    const header = "# Chat history\n\n";
    const entries = history
      .filter(message => message.role === "user" || message.role === "assistant")
      .map(
        message => {
          // Preserve source timestamps when available during migration.
          const timestamp = message.timestamp ?? new Date().toISOString();
          return `## [${timestamp}] ${message.role}\n${message.content}\n\n`;
        }
      )
      .join("");
    const content = header + entries;
    await this.replaceTextFile(path, content);
  }

  private stripTimestamps(entries: ChatLogEntry[] | ChatMessage[]): ChatMessage[] {
    return entries.map(message => ({ role: message.role, content: message.content }));
  }

  private extractTimestamp(record: Record<string, unknown>): string | undefined {
    const raw =
      record.timestamp ??
      record.time ??
      record.created_at ??
      record.createdAt ??
      record.date ??
      record.ts ??
      null;
    return this.normalizeTimestamp(raw) ?? undefined;
  }

  private normalizeTimestamp(value: unknown): string | null {
    if (typeof value === "string") {
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed.toISOString();
      }
      return null;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      const asMs = value < 1e12 ? value * 1000 : value;
      const parsed = new Date(asMs);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed.toISOString();
      }
    }
    return null;
  }

  private getChatStatePath(folder: TFolder): string {
    return `${this.getContextPath(folder)}/${CHAT_STATE_FILE}`;
  }

  private async readChatState(
    folder: TFolder
  ): Promise<{ activeLogPath: string } | null> {
    const path = this.getChatStatePath(folder);
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      return null;
    }
    try {
      const content = await this.app.vault.read(file);
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  private async writeChatState(folder: TFolder, activeLogPath: string): Promise<void> {
    await this.ensureContextFolder(folder);
    const path = this.getChatStatePath(folder);
    const payload = JSON.stringify({ activeLogPath }, null, 2);
    await this.replaceTextFile(path, payload);
  }

  private extractArtifactPaths(text: string): string[] {
    // Parse artifact list from assistant response block.
    const lines = text.split(/\r?\n/);
    const paths: string[] = [];
    let inBlock = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("Артефакты:")) {
        inBlock = true;
        continue;
      }
      if (!inBlock) {
        continue;
      }
      const match = trimmed.match(/^-\s*(\/artifacts\/\S+)/u);
      if (match) {
        paths.push(match[1]);
        continue;
      }
      if (trimmed.length > 0) {
        break;
      }
    }
    return paths;
  }

  private async downloadArtifacts(
    folder: TFolder,
    paths: string[],
    onStatus: (path: string, status: string) => void
  ): Promise<void> {
    if (!this.settings.apiHost) {
      throw new Error("API host is not configured. Set it in settings.");
    }
    // Artifacts are stored under 4senseContext/artefacts for each folder.
    await this.ensureArtifactsFolder(folder);
    for (const path of paths) {
      onStatus(path, "загрузка");
      try {
        const url = this.buildApiUrl(path);
        const headers: Record<string, string> = {};
        if (this.settings.apiKey) {
          headers.Authorization = `Bearer ${this.settings.apiKey}`;
        }
        const response = await requestUrl({
          url,
          method: "GET",
          headers
        });
        if (response.status < 200 || response.status >= 300) {
          throw new Error(`Artifact download failed: ${response.status}`);
        }
        const buffer =
          response.arrayBuffer ??
          new TextEncoder().encode(response.text ?? "").buffer;
        const name = this.getArtifactFilename(path);
        const targetPath = `${this.getArtifactsPath(folder)}/${name}`;
        const existing = this.app.vault.getAbstractFileByPath(targetPath);
        if (existing instanceof TFile) {
          await this.app.vault.modifyBinary(existing, buffer);
        } else {
          await this.app.vault.createBinary(targetPath, buffer);
        }
        onStatus(path, "готово");
      } catch (error) {
        onStatus(path, "ошибка");
      }
    }
  }

  private getArtifactFilename(path: string): string {
    const cleaned = path.split("?")[0];
    const last = cleaned.split("/").pop() ?? cleaned;
    try {
      return decodeURIComponent(last);
    } catch {
      return last;
    }
  }

  private splitFiles(files: TFile[]): {
    textFiles: TFile[];
    audioFiles: TFile[];
    imageFiles: TFile[];
    unsupportedAudioFiles: TFile[];
    skippedFiles: TFile[];
  } {
    const textFiles: TFile[] = [];
    const audioFiles: TFile[] = [];
    const imageFiles: TFile[] = [];
    const unsupportedAudioFiles: TFile[] = [];
    const skippedFiles: TFile[] = [];

    for (const file of files) {
      if (this.isSupportedAudioFile(file)) {
        audioFiles.push(file);
        continue;
      }
      if (this.isImageFile(file)) {
        imageFiles.push(file);
        continue;
      }
      if (this.isAnyAudioFile(file)) {
        unsupportedAudioFiles.push(file);
        continue;
      }
      if (this.isMarkdownFile(file)) {
        textFiles.push(file);
        continue;
      }
      skippedFiles.push(file);
    }

    return { textFiles, audioFiles, imageFiles, unsupportedAudioFiles, skippedFiles };
  }

  private isMarkdownFile(file: TFile): boolean {
    return file.extension === "md";
  }

  private isExcalidrawFile(file: TFile): boolean {
    return file.path.endsWith(".excalidraw.md");
  }

  private isSupportedAudioFile(file: TFile): boolean {
    return SUPPORTED_AUDIO_EXTENSIONS.has(file.extension.toLowerCase());
  }

  private isAnyAudioFile(file: TFile): boolean {
    return ALL_AUDIO_EXTENSIONS.has(file.extension.toLowerCase());
  }

  private isImageFile(file: TFile): boolean {
    return SUPPORTED_IMAGE_EXTENSIONS.has(file.extension.toLowerCase());
  }

  private getAudioContentType(file: TFile): string {
    const ext = file.extension.toLowerCase();
    switch (ext) {
      case "mp3":
      case "m4a":
        return "audio/mpeg";
      case "ogg":
      case "opus":
        return "audio/ogg;codecs=opus";
      case "flac":
        return "audio/flac";
      case "wav":
        return "audio/x-pcm;bit=16;rate=16000";
      default:
        throw new Error(`Unsupported audio format: .${ext}`);
    }
  }

  private async saveAssistantResponse(
    folder: TFolder,
    content: string
  ): Promise<void> {
    await this.ensureContextFolder(folder);
    const prefix = `${this.getContextPath(folder)}/`;
    const timestamp = this.formatTimestamp(new Date());
    const baseName = `ai-response-${timestamp}.md`;
    let filePath = `${prefix}${baseName}`;
    let index = 1;
    while (this.app.vault.getAbstractFileByPath(filePath)) {
      filePath = `${prefix}ai-response-${timestamp}-${index}.md`;
      index += 1;
    }
    await this.app.vault.create(filePath, content);
    new Notice(`Saved response to ${filePath}`);
  }

  private formatTimestamp(date: Date): string {
    const day = String(date.getDate()).padStart(2, "0");
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const year = String(date.getFullYear()).slice(-2);
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    const seconds = String(date.getSeconds()).padStart(2, "0");
    return `${day}-${month}-${year}T${hours}-${minutes}-${seconds}`;
  }
}

class FolderSuggestModal extends FuzzySuggestModal<TFolder> {
  private onSelect: (folder: TFolder) => void;
  private folders: TFolder[];

  constructor(app: App, onSelect: (folder: TFolder) => void) {
    super(app);
    this.onSelect = onSelect;
    this.folders = this.collectFolders();
    this.setPlaceholder("Select a folder to summarize");
  }

  getItems(): TFolder[] {
    return this.folders;
  }

  getItemText(item: TFolder): string {
    return item.path || "/";
  }

  onChooseItem(item: TFolder): void {
    this.onSelect(item);
  }

  private collectFolders(): TFolder[] {
    const all = this.app.vault.getAllLoadedFiles();
    const folders: TFolder[] = [];
    for (const file of all) {
      if (file instanceof TFolder) {
        folders.push(file);
      }
    }
    return folders;
  }
}

class ChatModal extends Modal {
  private markdownComponent: Component;
  private summary: string;
  private folderLabel: string;
  private theme: ChatTheme;
  private useSummary: boolean;
  private onStream: (
    messages: ChatMessage[],
    summary: string,
    onChunk: (chunk: string) => void,
    signal?: AbortSignal
  ) => Promise<ChatApiResponse>;
  private onSave: (content: string) => Promise<void>;
  private onLog: (role: "user" | "assistant", content: string) => Promise<void>;
  private onDownloadArtifacts: (
    paths: string[],
    onStatus: (path: string, status: string) => void
  ) => Promise<void>;
  private messages: ChatMessage[];
  private markdownSourcePath: string;
  private isWaiting: boolean;
  private requestCounter: number;
  private canceledRequest: number | null;
  private currentAbort: AbortController | null;
  private streamingRenderTarget: HTMLElement | null;
  private streamingRenderText: string;
  private streamingTypingTimer: number | null;
  private streamingTypingProgress: number;
  private streamingFinalizeTarget: { body: HTMLElement; text: string } | null;
  private viewportTarget: VisualViewport | null;
  private viewportHandler: EventListener | null;

  constructor(
    app: App,
    markdownComponent: Component,
    summary: string,
    folderLabel: string,
    markdownSourcePath: string,
    theme: ChatTheme,
    initialMessages: ChatMessage[],
    onStream: (
      messages: ChatMessage[],
      summary: string,
      onChunk: (chunk: string) => void,
      signal?: AbortSignal
    ) => Promise<ChatApiResponse>,
    onSave: (content: string) => Promise<void>,
    onLog: (role: "user" | "assistant", content: string) => Promise<void>,
    onDownloadArtifacts: (
      paths: string[],
      onStatus: (path: string, status: string) => void
    ) => Promise<void>
  ) {
    super(app);
    this.markdownComponent = markdownComponent;
    this.summary = summary;
    this.folderLabel = folderLabel;
    this.theme = theme;
    this.useSummary = true;
    this.markdownSourcePath = markdownSourcePath;
    this.onStream = onStream;
    this.onSave = onSave;
    this.onLog = onLog;
    this.onDownloadArtifacts = onDownloadArtifacts;
    this.messages = [
      { role: "system", content: CHAT_SYSTEM_PROMPT },
      ...initialMessages
    ];
    this.isWaiting = false;
    this.requestCounter = 0;
    this.canceledRequest = null;
    this.currentAbort = null;
    this.streamingRenderTarget = null;
    this.streamingRenderText = "";
    this.streamingTypingTimer = null;
    this.streamingTypingProgress = 0;
    this.streamingFinalizeTarget = null;
    this.viewportTarget = null;
    this.viewportHandler = null;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.modalEl.addClass("folder-summary-chat-modal");
    contentEl.addClass("folder-summary-chat");
    if (this.theme === "glass") {
      this.modalEl.addClass("folder-summary-chat-modal--glass");
      contentEl.addClass("folder-summary-chat--glass");
    }
    if (this.theme === "quiet") {
      this.modalEl.addClass("folder-summary-chat-modal--quiet");
      contentEl.addClass("folder-summary-chat--quiet");
    }

    const headerRow = contentEl.createEl("div");
    headerRow.addClass("folder-summary-chat__header");
    const header = headerRow.createEl("h3", { text: "Chat with assistant" });
    header.addClass("folder-summary-chat__title");
    const closeButton = headerRow.createEl("button");
    closeButton.addClass("folder-summary-chat__close");
    closeButton.setAttr("aria-label", "Close chat");
    const closeGlyph = closeButton.createEl("span", { text: "×" });
    closeGlyph.addClass("folder-summary-chat__close-glyph");
    closeButton.onclick = () => this.close();

    const output = contentEl.createEl("div");
    output.addClass("folder-summary-chat__output");
    output.tabIndex = -1;

    for (const message of this.messages) {
      if (message.role === "user" || message.role === "assistant") {
        this.appendMessage(output, message.role, message.content);
      }
    }

    const input = contentEl.createEl("textarea");
    input.addClass("folder-summary-chat__input");
    input.placeholder = "Ask a question...";
    const keepInputVisible = () => {
      window.setTimeout(() => {
        input.scrollIntoView({ block: "nearest", behavior: "auto" });
      }, 80);
    };
    const syncViewportHeight = () => {
      const viewportHeight =
        typeof window.visualViewport?.height === "number"
          ? window.visualViewport.height
          : window.innerHeight;
      this.modalEl.style.setProperty(
        "--folder-summary-chat-vh",
        `${Math.max(320, Math.round(viewportHeight))}px`
      );
    };
    syncViewportHeight();
    const viewport = window.visualViewport;
    if (viewport) {
      const onViewportChange: EventListener = () => {
        syncViewportHeight();
        if (document.activeElement === input) {
          keepInputVisible();
        }
      };
      viewport.addEventListener("resize", onViewportChange);
      viewport.addEventListener("scroll", onViewportChange);
      this.viewportTarget = viewport;
      this.viewportHandler = onViewportChange;
    }
    input.addEventListener("focus", () => {
      syncViewportHeight();
      keepInputVisible();
    });

    const actionButton = contentEl.createEl("button", { text: "Send" });
    actionButton.addClass("folder-summary-chat__send");

    const setWaiting = (waiting: boolean) => {
      this.isWaiting = waiting;
      input.disabled = waiting;
      if (waiting) {
        actionButton.setText("Stop");
        actionButton.addClass("folder-summary-chat__send--stop");
      } else {
        actionButton.setText("Send");
        actionButton.removeClass("folder-summary-chat__send--stop");
      }
    };

    const sendMessage = async () => {
      const text = input.value.trim();
      if (!text || this.isWaiting) {
        return;
      }
      input.value = "";
      this.appendMessage(output, "user", text);
      this.messages.push({ role: "user", content: text });
      await this.onLog("user", text);
      this.resetStreamingState();
      const streaming = this.appendLoadingMessage(output);
      output.scrollTop = output.scrollHeight;
      setWaiting(true);
      const requestId = ++this.requestCounter;
      const abortController = new AbortController();
      this.currentAbort = abortController;
      let fullText = "";
      let hasChunk = false;
      const ensureStreamingReady = () => {
        if (hasChunk) {
          return;
        }
        hasChunk = true;
        streaming.wrapper.removeClass("folder-summary-chat__message--loading");
        streaming.body.empty();
        streaming.body.addClass("folder-summary-chat__message-body--streaming");
      };
      try {
        const response = await this.onStream(
          this.messages,
          this.useSummary ? this.summary : "",
          chunk => {
            ensureStreamingReady();
            fullText += chunk;
            this.updateStreamingMessage(streaming.body, fullText);
            output.scrollTop = output.scrollHeight;
          },
          abortController.signal
        );
        if (this.canceledRequest === requestId) {
          streaming.wrapper.remove();
        } else {
          if (!hasChunk) {
            ensureStreamingReady();
          }
          const finalText = response.message || fullText;
          this.messages.push({ role: "assistant", content: finalText });
          this.finalizeStreamingMessage(streaming.body, finalText);
          await this.onLog("assistant", finalText);
          if (response.artifactPaths.length > 0) {
            const statusMap = this.renderArtifactStatus(
              streaming.wrapper,
              response.artifactPaths
            );
            void this.onDownloadArtifacts(response.artifactPaths, (path, status) => {
              const item = statusMap.get(path);
              if (item) {
                item.status.setText(status);
                item.open.classList.toggle(
                  "folder-summary-chat__artifact-open--disabled",
                  status !== "готово"
                );
              }
            });
          }
        }
      } catch (error) {
        if (this.canceledRequest !== requestId) {
          const message =
            error instanceof Error
              ? error.message
              : "Failed to fetch response.";
          if (message.toLowerCase().includes("abort")) {
            streaming.wrapper.remove();
          } else {
            ensureStreamingReady();
            this.updateStreamingMessage(streaming.body, message);
          }
        } else {
          streaming.wrapper.remove();
        }
      } finally {
        setWaiting(false);
        this.canceledRequest = null;
        this.currentAbort = null;
      }
      output.scrollTop = output.scrollHeight;
    };

    actionButton.onclick = () => {
      if (this.isWaiting) {
        this.canceledRequest = this.requestCounter;
        this.currentAbort?.abort();
        setWaiting(false);
        return;
      }
      void sendMessage();
    };

    input.addEventListener("keydown", event => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void sendMessage();
      }
    });

    const actionsRow = contentEl.createEl("div");
    actionsRow.addClass("folder-summary-chat__actions");
    actionsRow.appendChild(actionButton);

    const summaryButton = actionsRow.createEl("button", { text: "Summary" });
    summaryButton.addClass("folder-summary-chat__summary-open");

    const summaryToggle = actionsRow.createEl("label");
    summaryToggle.addClass("folder-summary-chat__summary-toggle");
    const checkbox = summaryToggle.createEl("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.addClass("folder-summary-chat__summary-checkbox");
    summaryToggle.createEl("span").addClass("folder-summary-chat__summary-slider");
    const summaryLabel = summaryToggle.createEl("span", { text: "Use summary" });
    summaryLabel.addClass("folder-summary-chat__summary-toggle-label");
    checkbox.addEventListener("change", () => {
      this.useSummary = checkbox.checked;
    });

    const summarySheet = contentEl.createEl("div");
    summarySheet.addClass("folder-summary-chat__summary-sheet");
    summarySheet.addClass("folder-summary-chat__summary-sheet--hidden");
    summarySheet.setAttr("aria-hidden", "true");

    const summaryPanel = summarySheet.createEl("div");
    summaryPanel.addClass("folder-summary-chat__summary-panel");

    const summaryPanelHeader = summaryPanel.createEl("div");
    summaryPanelHeader.addClass("folder-summary-chat__summary-header");
    summaryPanelHeader.createEl("div", {
      text: `Summary: ${this.folderLabel}`
    }).addClass("folder-summary-chat__summary-header-title");
    const closeSummaryButton = summaryPanelHeader.createEl("button", {
      text: "Close"
    });
    closeSummaryButton.addClass("folder-summary-chat__summary-close");

    const summaryText = summaryPanel.createEl("pre", { text: this.summary });
    summaryText.addClass("folder-summary-chat__summary-text");

    const openSummarySheet = () => {
      summarySheet.removeClass("folder-summary-chat__summary-sheet--hidden");
      summarySheet.setAttr("aria-hidden", "false");
      closeSummaryButton.focus();
    };
    const closeSummarySheet = () => {
      summarySheet.addClass("folder-summary-chat__summary-sheet--hidden");
      summarySheet.setAttr("aria-hidden", "true");
    };

    summaryButton.onclick = () => openSummarySheet();
    closeSummaryButton.onclick = () => closeSummarySheet();
    summarySheet.addEventListener("click", event => {
      if (event.target === summarySheet) {
        closeSummarySheet();
      }
    });
    contentEl.addEventListener("keydown", event => {
      if (
        event.key === "Escape" &&
        !summarySheet.classList.contains("folder-summary-chat__summary-sheet--hidden")
      ) {
        event.preventDefault();
        closeSummarySheet();
      }
    });
    window.setTimeout(() => {
      if (document.activeElement === closeButton) {
        output.focus({ preventScroll: true });
      }
    }, 0);
  }

  onClose(): void {
    this.currentAbort?.abort();
    this.currentAbort = null;
    this.resetStreamingState();
    if (this.viewportTarget && this.viewportHandler) {
      this.viewportTarget.removeEventListener("resize", this.viewportHandler);
      this.viewportTarget.removeEventListener("scroll", this.viewportHandler);
    }
    this.viewportTarget = null;
    this.viewportHandler = null;
    this.modalEl.style.removeProperty("--folder-summary-chat-vh");
    this.modalEl.removeClass("folder-summary-chat-modal");
    this.modalEl.removeClass("folder-summary-chat-modal--glass");
    this.modalEl.removeClass("folder-summary-chat-modal--quiet");
    this.contentEl.removeClass("folder-summary-chat--glass");
    this.contentEl.removeClass("folder-summary-chat--quiet");
    this.contentEl.empty();
  }

  private appendMessage(
    container: HTMLElement,
    role: "user" | "assistant",
    text: string
  ): void {
    const wrapper = container.createEl("div");
    wrapper.addClass("folder-summary-chat__message");
    wrapper.addClass(
      role === "user"
        ? "folder-summary-chat__message--user"
        : "folder-summary-chat__message--assistant"
    );
    const title = wrapper.createEl("div", {
      text: role === "user" ? "Вы" : "Помощник"
    });
    title.addClass("folder-summary-chat__message-title");
    const body = wrapper.createEl("div");
    body.addClass("folder-summary-chat__message-body");

    if (role === "assistant") {
      this.renderAssistantMarkdown(body, text);
      const actions = wrapper.createEl("div");
      actions.addClass("folder-summary-chat__message-actions");
      const saveButton = actions.createEl("button", { text: "Сохранить" });
      saveButton.addClass("folder-summary-chat__message-save");
      saveButton.onclick = () => void this.onSave(text);
    } else {
      body.setText(text);
    }
  }

  private appendLoadingMessage(container: HTMLElement): {
    wrapper: HTMLElement;
    body: HTMLElement;
  } {
    const wrapper = container.createEl("div");
    wrapper.addClass("folder-summary-chat__message");
    wrapper.addClass("folder-summary-chat__message--assistant");
    wrapper.addClass("folder-summary-chat__message--loading");

    const title = wrapper.createEl("div", { text: "Помощник" });
    title.addClass("folder-summary-chat__message-title");

    const body = wrapper.createEl("div");
    body.addClass("folder-summary-chat__message-body");
    const dots = body.createEl("span");
    dots.addClass("folder-summary-chat__loading-dots");
    for (let i = 0; i < 3; i += 1) {
      const dot = dots.createEl("span", { text: "." });
      dot.addClass("folder-summary-chat__loading-dot");
      dot.setAttr("aria-hidden", "true");
    }

    return { wrapper, body };
  }

  private updateStreamingMessage(body: HTMLElement, text: string): void {
    body.addClass("folder-summary-chat__message-body--streaming");
    this.updateTypingText(body, text);
  }

  private finalizeStreamingMessage(body: HTMLElement, text: string): void {
    this.queueFinalize(body, text);
  }

  private renderAssistantMarkdown(body: HTMLElement, text: string): void {
    body.empty();
    void MarkdownRenderer.render(
      this.app,
      text,
      body,
      this.markdownSourcePath,
      this.markdownComponent
    );
  }

  private updateTypingText(body: HTMLElement, text: string): void {
    if (this.streamingRenderTarget !== body) {
      this.streamingRenderTarget = body;
      this.streamingTypingProgress = 0;
    }
    this.streamingRenderText = text;
    if (this.streamingTypingTimer === null) {
      this.streamingTypingTimer = window.setInterval(
        () => this.tickStreamingTyping(),
        STREAM_TYPING_TICK_MS
      );
    }
  }

  private stopStreamingTyping(): void {
    if (this.streamingTypingTimer !== null) {
      window.clearInterval(this.streamingTypingTimer);
      this.streamingTypingTimer = null;
    }
    this.streamingTypingProgress = 0;
  }

  private tickStreamingTyping(): void {
    if (!this.streamingRenderTarget) {
      this.stopStreamingTyping();
      return;
    }
    const fullText = this.streamingRenderText;
    if (!fullText) {
      this.stopStreamingTyping();
      return;
    }
    const remaining = fullText.length - this.streamingTypingProgress;
    if (remaining <= 0) {
      if (this.streamingFinalizeTarget) {
        const target = this.streamingFinalizeTarget;
        this.streamingFinalizeTarget = null;
        this.completeFinalize(target.body, target.text);
      } else {
        this.stopStreamingTyping();
      }
      return;
    }
    const catchup = Math.ceil(remaining / STREAM_TYPING_CATCHUP_WINDOW);
    const step = Math.max(STREAM_TYPING_BASE_STEP, catchup);
    this.streamingTypingProgress = Math.min(fullText.length, this.streamingTypingProgress + step);
    this.streamingRenderTarget.setText(fullText.slice(0, this.streamingTypingProgress));
  }

  private queueFinalize(body: HTMLElement, text: string): void {
    this.streamingFinalizeTarget = { body, text };
    if (this.streamingTypingTimer === null) {
      this.completeFinalize(body, text);
    }
  }

  private completeFinalize(body: HTMLElement, text: string): void {
    this.stopStreamingTyping();
    body.removeClass("folder-summary-chat__message-body--streaming");
    this.renderAssistantMarkdown(body, text);
  }

  private resetStreamingState(): void {
    this.stopStreamingTyping();
    this.streamingRenderText = "";
    this.streamingRenderTarget = null;
    this.streamingTypingProgress = 0;
    this.streamingFinalizeTarget = null;
  }

  private renderArtifactStatus(
    wrapper: HTMLElement,
    paths: string[]
  ): Map<string, { status: HTMLElement; open: HTMLAnchorElement }> {
    const statusMap = new Map<string, { status: HTMLElement; open: HTMLAnchorElement }>();
    const title = wrapper.createEl("div", { text: "Артефакты" });
    title.addClass("folder-summary-chat__artifact-title");
    const list = wrapper.createEl("ul");
    list.addClass("folder-summary-chat__artifact-list");
    for (const path of paths) {
      const name = this.extractFilename(path);
      const downloaded = this.isArtifactDownloaded(path);
      const item = list.createEl("li");
      item.addClass("folder-summary-chat__artifact-item");
      const label = item.createEl("a", { text: name });
      label.href = "#";
      label.onclick = event => {
        event.preventDefault();
        if (label.classList.contains("folder-summary-chat__artifact-open--disabled")) {
          new Notice("Артефакт ещё не скачан.");
          return;
        }
        void this.openArtifact(path);
      };
      label.addClass("folder-summary-chat__artifact-name");
      label.addClass("folder-summary-chat__artifact-open");
      if (!downloaded) {
        label.addClass("folder-summary-chat__artifact-open--disabled");
      }
      const status = item.createEl("span", { text: downloaded ? "готово" : "ожидание" });
      status.addClass("folder-summary-chat__artifact-status");
      statusMap.set(path, { status, open: label });
    }
    return statusMap;
  }

  private getArtifactLocalPath(apiPath: string): string {
    const prefix = this.markdownSourcePath ? `${this.markdownSourcePath}/` : "";
    return `${prefix}${CONTEXT_DIR}/${ARTIFACTS_DIR}/${this.extractFilename(apiPath)}`;
  }

  private isArtifactDownloaded(apiPath: string): boolean {
    const artifact = this.app.vault.getAbstractFileByPath(this.getArtifactLocalPath(apiPath));
    return artifact instanceof TFile;
  }

  private async openArtifact(apiPath: string): Promise<void> {
    const path = this.getArtifactLocalPath(apiPath);
    const artifact = this.app.vault.getAbstractFileByPath(path);
    if (!(artifact instanceof TFile)) {
      new Notice("Артефакт ещё не скачан.");
      return;
    }
    await this.app.workspace.getLeaf(true).openFile(artifact);
  }

  private extractFilename(path: string): string {
    const cleaned = path.split("?")[0];
    const last = cleaned.split("/").pop() ?? cleaned;
    try {
      return decodeURIComponent(last);
    } catch {
      return last;
    }
  }
}

class FolderSummarySettingTab extends PluginSettingTab {
  private plugin: FolderSummaryPlugin;

  constructor(app: App, plugin: FolderSummaryPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("API host")
      .setDesc("Host URL for the future summary/chat API.")
      .addText(text =>
        text
          .setPlaceholder("https://api.example.com")
          .setValue(this.plugin.settings.apiHost)
          .onChange(async value => {
            this.plugin.settings.apiHost = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("API key")
      .setDesc("API key used for authentication.")
      .addText(text =>
        text
          .setPlaceholder("sk-...")
          .setValue(this.plugin.settings.apiKey)
          .onChange(async value => {
            this.plugin.settings.apiKey = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Summary endpoint path")
      .setDesc("Path for summary API (relative to host).")
      .addText(text =>
        text
          .setPlaceholder("/summaries")
          .setValue(this.plugin.settings.apiSummaryPath)
          .onChange(async value => {
            this.plugin.settings.apiSummaryPath = value.trim() || "/summaries";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Transcription endpoint path")
      .setDesc("Path for audio transcription API (relative to host).")
      .addText(text =>
        text
          .setPlaceholder("/transcriptions")
          .setValue(this.plugin.settings.apiTranscriptionPath)
          .onChange(async value => {
            this.plugin.settings.apiTranscriptionPath =
              value.trim() || "/transcriptions";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Chat endpoint path")
      .setDesc("Path for chat API (relative to host).")
      .addText(text =>
        text
          .setPlaceholder("/chat")
          .setValue(this.plugin.settings.apiChatPath)
          .onChange(async value => {
            this.plugin.settings.apiChatPath = value.trim() || "/chat";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Summary file name")
      .setDesc("File name for the summary saved in the folder.")
      .addText(text =>
        text
          .setPlaceholder("_summary.md")
          .setValue(this.plugin.settings.summaryFileName)
          .onChange(async value => {
            this.plugin.settings.summaryFileName = value.trim() || "_summary.md";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Chat theme")
      .setDesc("Visual style for the chat modal.")
      .addDropdown(dropdown =>
        dropdown
          .addOption("glass", "iOS Glass")
          .addOption("quiet", "iOS Calm")
          .addOption("classic", "iOS Classic")
          .setValue(this.plugin.settings.chatTheme)
          .onChange(async value => {
            this.plugin.settings.chatTheme =
              value === "classic" || value === "quiet" ? value : "glass";
            await this.plugin.saveSettings();
          })
      );
  }
}

class StepProgressModal extends Modal {
  private statusEl: HTMLElement | null = null;

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("devbrief-progress");

    const spinner = contentEl.createEl("div");
    spinner.addClass("devbrief-progress__spinner");

    const status = contentEl.createEl("div", { text: "..." });
    status.addClass("devbrief-progress__status");
    this.statusEl = status;
  }

  setStatus(text: string): void {
    if (this.statusEl) {
      this.statusEl.setText(text);
    }
  }

  onClose(): void {
    this.contentEl.empty();
    this.statusEl = null;
  }
}

class ErrorModal extends Modal {
  private message: string;

  constructor(app: App, message: string) {
    super(app);
    this.message = message;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("devbrief-error");

    contentEl.createEl("h3", { text: "Ошибка" });
    contentEl.createEl("p", { text: "Произошла ошибка при обращении к API." });
    contentEl.createEl("pre", { text: this.message });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}
