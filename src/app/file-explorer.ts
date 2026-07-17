import { FileApi, type FileEntry } from "./file-api.js";

export class FileExplorerController {
  private path = ".";
  private generation = 0;
  private abort?: AbortController;
  private entries: FileEntry[] = [];

  constructor(
    private readonly mount: HTMLElement,
    private readonly api: FileApi,
    private readonly setStatus: (value: string) => void,
    private readonly download?: (
      name: string,
      bytes: ArrayBuffer,
    ) => Promise<void>,
  ) {
    this.renderShell();
  }

  async load(path = this.path): Promise<void> {
    this.abort?.abort();
    const controller = new AbortController();
    this.abort = controller;
    const generation = ++this.generation;
    this.path = path;
    this.mount.dataset.state = "loading";
    this.setStatus("Loading files");
    try {
      const result = await this.api.list(path, controller.signal);
      if (generation !== this.generation) return;
      this.entries = result.entries;
      this.renderList();
      this.mount.dataset.state = "ready";
      this.setStatus(
        `${result.entries.length} file${result.entries.length === 1 ? "" : "s"}`,
      );
    } catch (error) {
      if (controller.signal.aborted) return;
      this.mount.dataset.state = "error";
      this.renderError(error);
      this.setStatus("Files unavailable");
    }
  }

  dispose(): void {
    this.generation += 1;
    this.abort?.abort();
    this.mount.replaceChildren();
  }

  private renderShell(): void {
    const toolbar = document.createElement("div");
    toolbar.className = "files__toolbar";
    for (const [label, action] of [
      ["Up", () => void this.load(parentPath(this.path))],
      ["Refresh", () => void this.load()],
      ["New folder", () => void this.createFolder()],
      ["Upload", () => this.chooseUpload()],
    ] as const) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.addEventListener("click", action);
      toolbar.append(button);
    }
    const breadcrumb = document.createElement("code");
    breadcrumb.className = "files__breadcrumb";
    breadcrumb.dataset.role = "breadcrumb";
    const list = document.createElement("div");
    list.className = "files__list";
    list.dataset.role = "list";
    this.mount.replaceChildren(toolbar, breadcrumb, list);
  }

  private renderList(): void {
    const breadcrumb = this.mount.querySelector<HTMLElement>(
      '[data-role="breadcrumb"]',
    )!;
    breadcrumb.textContent = this.path === "." ? "Home" : `Home / ${this.path}`;
    const list = this.mount.querySelector<HTMLElement>('[data-role="list"]')!;
    list.replaceChildren();
    if (this.entries.length === 0) {
      const empty = document.createElement("p");
      empty.className = "files__empty";
      empty.textContent = "This folder is empty";
      list.append(empty);
      return;
    }
    for (const entry of this.entries) {
      const row = document.createElement("div");
      row.className = "files__row";
      const name = document.createElement("button");
      name.type = "button";
      name.className = "files__name";
      name.textContent = entry.name;
      if (entry.kind === "directory")
        name.addEventListener("click", () => void this.load(entry.path));
      else name.disabled = true;
      const kind = document.createElement("span");
      kind.textContent = entry.kind;
      const size = document.createElement("span");
      size.textContent = entry.kind === "file" ? formatBytes(entry.size) : "";
      const actions = document.createElement("span");
      actions.className = "files__row-actions";
      if (entry.kind === "file" && this.download)
        actions.append(
          this.actionButton("Download", () => void this.downloadEntry(entry)),
        );
      actions.append(
        this.actionButton("Rename", () => void this.renameEntry(entry)),
        this.actionButton("Delete", () => void this.deleteEntry(entry)),
      );
      row.append(name, kind, size, actions);
      list.append(row);
    }
  }

  private actionButton(label: string, action: () => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", action);
    return button;
  }
  private renderError(error: unknown): void {
    const list = this.mount.querySelector<HTMLElement>('[data-role="list"]')!;
    const message = document.createElement("p");
    message.className = "files__error";
    message.textContent =
      error instanceof Error ? error.message : "Unable to load files";
    const retry = this.actionButton("Retry", () => void this.load());
    list.replaceChildren(message, retry);
  }
  private async createFolder(): Promise<void> {
    const name = window.prompt("Folder name")?.trim();
    if (!name) return;
    await this.api.mutate("mkdir", [joinPath(this.path, name)]);
    await this.load();
  }
  private async renameEntry(entry: FileEntry): Promise<void> {
    const name = window.prompt("New name", entry.name)?.trim();
    if (!name || name === entry.name) return;
    await this.api.mutate("rename", [entry.path, joinPath(this.path, name)]);
    await this.load();
  }
  private async deleteEntry(entry: FileEntry): Promise<void> {
    if (!window.confirm(`Delete ${entry.name}?`)) return;
    await this.api.mutate("delete", [entry.path]);
    await this.load();
  }
  private chooseUpload(): void {
    const input = document.createElement("input");
    input.type = "file";
    input.addEventListener(
      "change",
      () => {
        const file = input.files?.[0];
        if (file) void this.upload(file);
      },
      { once: true },
    );
    input.click();
  }
  private async upload(file: File): Promise<void> {
    const controller = new AbortController();
    this.abort = controller;
    await this.api.upload(
      joinPath(this.path, file.name),
      file,
      controller.signal,
    );
    await this.load();
  }
  private async downloadEntry(entry: FileEntry): Promise<void> {
    if (!this.download) return;
    const controller = new AbortController();
    this.abort = controller;
    await this.download(
      entry.name,
      await this.api.download(entry.path, controller.signal),
    );
  }
}

function joinPath(parent: string, name: string): string {
  return parent === "." ? name : `${parent}/${name}`;
}
function parentPath(path: string): string {
  if (path === "." || !path.includes("/")) return ".";
  return path.slice(0, path.lastIndexOf("/")) || ".";
}
function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
