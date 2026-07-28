import { FileApi, type FileEntry } from "./file-api.js";
import { closeOpenDialog, confirmDialog, promptDialog } from "./dialogs.js";
import { closeFileViewer, openFileViewer } from "./file-viewer.js";

type SortKey = "name" | "size" | "modified";

const SORT_COLUMNS: ReadonlyArray<{ key: SortKey; label: string }> = [
  { key: "name", label: "Name" },
  { key: "size", label: "Size" },
  { key: "modified", label: "Modified" },
];

export class FileExplorerController {
  private path = ".";
  private generation = 0;
  private abort?: AbortController;
  private entries: FileEntry[] = [];
  private maxEmbeddedDownloadBytes = 0;
  private actionActive = false;
  private lifecycleGeneration = 0;
  private sortKey: SortKey = "name";
  private sortAscending = true;

  constructor(
    private readonly mount: HTMLElement,
    private readonly api: FileApi,
    private readonly setStatus: (value: string) => void,
    private download?: (name: string, bytes: ArrayBuffer) => Promise<void>,
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
      this.maxEmbeddedDownloadBytes = result.maxEmbeddedDownloadBytes;
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
    this.lifecycleGeneration += 1;
    this.generation += 1;
    this.abort?.abort();
    // Modals live on document.body, so clearing the mount would otherwise
    // leave one stranded on screen with nothing behind it.
    closeFileViewer();
    closeOpenDialog();
    this.mount.replaceChildren();
  }

  setDownload(
    download?: (name: string, bytes: ArrayBuffer) => Promise<void>,
  ): void {
    this.download = download;
    if (this.mount.dataset.state === "ready") this.renderList();
  }

  private renderShell(): void {
    const toolbar = document.createElement("div");
    toolbar.className = "files__toolbar";
    for (const [label, action] of [
      ["Up", () => void this.load(parentPath(this.path))],
      ["Refresh", () => void this.load()],
      ["New folder", () => void this.runAction(() => this.createFolder())],
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
    this.mount.replaceChildren(
      toolbar,
      breadcrumb,
      this.renderColumnHeader(),
      list,
    );
  }

  /** Sortable column header. Kept outside the list so it survives re-renders. */
  private renderColumnHeader(): HTMLElement {
    const header = document.createElement("div");
    // Deliberately not `.files__row` — that selector must only ever match data
    // rows, so callers can count entries without filtering the header out.
    header.className = "files__head";
    header.dataset.role = "head";
    header.setAttribute("role", "row");

    for (const column of SORT_COLUMNS) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "files__sort";
      button.textContent = column.label;
      button.dataset.key = column.key;
      button.setAttribute("role", "columnheader");
      button.addEventListener("click", () => this.toggleSort(column.key));
      header.append(button);
    }

    const spacer = document.createElement("span");
    spacer.className = "files__row-actions";
    header.append(spacer);
    this.paintSortIndicators(header);
    return header;
  }

  /**
   * Update the sort affordances in place. Rebuilding the header instead would
   * discard the button the operator just activated, dropping keyboard focus.
   */
  private paintSortIndicators(header: Element): void {
    for (const button of header.querySelectorAll<HTMLElement>(".files__sort")) {
      const active = button.dataset.key === this.sortKey;
      // Communicates both the active column and its direction to screen readers.
      button.setAttribute(
        "aria-sort",
        active ? (this.sortAscending ? "ascending" : "descending") : "none",
      );
      if (active) button.dataset.active = this.sortAscending ? "asc" : "desc";
      else delete button.dataset.active;
    }
  }

  private toggleSort(key: SortKey): void {
    if (this.sortKey === key) this.sortAscending = !this.sortAscending;
    else {
      this.sortKey = key;
      // Names read naturally A→Z; size and time are most useful largest/newest first.
      this.sortAscending = key === "name";
    }
    const header = this.mount.querySelector('[data-role="head"]');
    if (header) this.paintSortIndicators(header);
    if (this.mount.dataset.state === "ready") this.renderList();
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
    for (const entry of this.sortedEntries()) {
      const row = document.createElement("div");
      row.className = "files__row";
      row.dataset.kind = entry.kind;
      const name = document.createElement("button");
      name.type = "button";
      name.className = "files__name";
      name.append(kindIcon(entry.kind), document.createTextNode(entry.name));
      name.title = `${entry.name} — ${formatMode(entry.mode, entry.kind)}`;
      if (entry.kind === "directory")
        name.addEventListener("click", () => void this.load(entry.path));
      else if (entry.kind === "file")
        name.addEventListener(
          "click",
          () => void this.runAction(() => this.viewEntry(entry), false),
        );
      // Symlinks and specials have no meaningful content to open.
      else name.disabled = true;
      const size = document.createElement("span");
      size.className = "files__size";
      size.textContent = entry.kind === "file" ? formatBytes(entry.size) : "";
      const modified = document.createElement("span");
      modified.className = "files__modified";
      modified.textContent = formatModified(entry.modified);
      if (entry.modified > 0)
        modified.title = new Date(entry.modified).toLocaleString();
      const actions = document.createElement("span");
      actions.className = "files__row-actions";
      if (
        entry.kind === "file" &&
        this.download &&
        entry.size <= this.maxEmbeddedDownloadBytes
      )
        actions.append(
          this.actionButton(
            "Download",
            () => void this.runAction(() => this.downloadEntry(entry), false),
          ),
        );
      actions.append(
        this.actionButton(
          "Rename",
          () => void this.runAction(() => this.renameEntry(entry)),
        ),
        this.actionButton(
          "Delete",
          () => void this.runAction(() => this.deleteEntry(entry)),
        ),
      );
      row.append(name, size, modified, actions);
      list.append(row);
    }
  }

  /** Directories always lead, then the chosen column. Name is the tiebreaker. */
  private sortedEntries(): FileEntry[] {
    const direction = this.sortAscending ? 1 : -1;
    return [...this.entries].sort((left, right) => {
      const leftDir = left.kind === "directory" ? 0 : 1;
      const rightDir = right.kind === "directory" ? 0 : 1;
      if (leftDir !== rightDir) return leftDir - rightDir;
      const ordered = compareBy(this.sortKey, left, right) * direction;
      return ordered || left.name.localeCompare(right.name);
    });
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
    const name = await promptDialog({
      title: "New folder",
      label: "Folder name",
      placeholder: "untitled",
      confirmLabel: "Create",
    });
    if (!name) return;
    await this.api.mutate("mkdir", { path: joinPath(this.path, name) });
  }
  private async renameEntry(entry: FileEntry): Promise<void> {
    const name = await promptDialog({
      title: "Rename",
      label: "New name",
      value: entry.name,
      confirmLabel: "Rename",
    });
    if (!name || name === entry.name) return;
    await this.api.mutate("rename", {
      from: entry.path,
      to: joinPath(this.path, name),
      expectedFingerprint: entry.fingerprint,
      overwrite: false,
    });
  }
  private async deleteEntry(entry: FileEntry): Promise<void> {
    const confirmed = await confirmDialog({
      title: `Delete ${entry.kind}`,
      message: `Permanently delete "${entry.name}"? This cannot be undone.`,
      confirmLabel: "Delete",
      tone: "danger",
    });
    if (!confirmed) return;
    if (entry.kind === "other") throw new Error("Unsupported file type");
    await this.api.mutate("delete", {
      path: entry.path,
      expectedFingerprint: entry.fingerprint,
      kind: entry.kind,
    });
  }
  private chooseUpload(): void {
    const input = document.createElement("input");
    input.type = "file";
    input.addEventListener(
      "change",
      () => {
        const file = input.files?.[0];
        if (file) void this.runAction(() => this.upload(file));
      },
      { once: true },
    );
    input.click();
  }
  private async upload(file: File): Promise<void> {
    const controller = new AbortController();
    this.abort = controller;
    const existing = this.entries.find((entry) => entry.name === file.name);
    if (existing && existing.kind !== "file")
      throw new Error("A non-file entry already uses that name");
    if (
      existing &&
      !(await confirmDialog({
        title: "Overwrite file",
        message: `"${file.name}" already exists here. Replace it with the uploaded copy?`,
        confirmLabel: "Overwrite",
        tone: "danger",
      }))
    )
      return;
    await this.api.upload(
      joinPath(this.path, file.name),
      file,
      controller.signal,
      existing,
    );
  }
  /**
   * Open a file in the read-only viewer. Uses the same lease-checked download
   * the Download button uses, but does not require the host's downloadFile
   * capability — previewing never leaves the app.
   */
  private async viewEntry(entry: FileEntry): Promise<void> {
    await openFileViewer({ name: entry.name, size: entry.size }, (signal) =>
      this.api.download(entry, signal),
    );
  }

  private async downloadEntry(entry: FileEntry): Promise<void> {
    if (!this.download) return;
    const controller = new AbortController();
    this.abort = controller;
    await this.download(
      entry.name,
      await this.api.download(entry, controller.signal),
    );
  }

  private async runAction(
    operation: () => Promise<void>,
    refresh = true,
  ): Promise<void> {
    if (this.actionActive) return;
    const generation = this.lifecycleGeneration;
    this.actionActive = true;
    for (const button of this.mount.querySelectorAll("button"))
      button.disabled = true;
    try {
      await operation();
      if (generation !== this.lifecycleGeneration) return;
      if (refresh) await this.load();
    } catch (error) {
      if (generation !== this.lifecycleGeneration) return;
      this.setStatus(
        error instanceof Error ? error.message : "File action failed",
      );
    } finally {
      if (generation === this.lifecycleGeneration) {
        this.actionActive = false;
        for (const button of this.mount.querySelectorAll("button"))
          button.disabled = false;
      }
    }
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

function compareBy(key: SortKey, left: FileEntry, right: FileEntry): number {
  if (key === "size") return left.size - right.size;
  if (key === "modified") return left.modified - right.modified;
  return left.name.localeCompare(right.name, undefined, { numeric: true });
}

const RELATIVE_UNITS: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 24 * 60 * 60 * 1000],
  ["month", 30 * 24 * 60 * 60 * 1000],
  ["day", 24 * 60 * 60 * 1000],
  ["hour", 60 * 60 * 1000],
  ["minute", 60 * 1000],
];

/** `modified` arrives as Unix milliseconds from the Go SFTP helper. */
function formatModified(modified: number): string {
  if (!Number.isFinite(modified) || modified <= 0) return "";
  const elapsed = Date.now() - modified;
  if (elapsed < 60_000) return "just now";
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, size] of RELATIVE_UNITS) {
    if (Math.abs(elapsed) >= size)
      return format.format(-Math.round(elapsed / size), unit);
  }
  return "just now";
}

/**
 * Render the permission bits as `rwxr-xr-x`. `mode` is a Go `fs.FileMode`, so
 * the type bits live high and only the low 9 bits are POSIX permissions.
 */
function formatMode(mode: number, kind: FileEntry["kind"]): string {
  if (!Number.isFinite(mode)) return "unknown permissions";
  const prefix =
    kind === "directory"
      ? "d"
      : kind === "symlink"
        ? "l"
        : kind === "file"
          ? "-"
          : "?";
  let out = "";
  for (let bit = 8; bit >= 0; bit -= 1)
    out += (mode >> bit) & 1 ? "rwx"[(8 - bit) % 3] : "-";
  return prefix + out;
}

const ICON_PATHS: Record<FileEntry["kind"], string> = {
  directory: "M1.5 3.5h4l1.2 1.6h6.8v7.4h-12z",
  file: "M3.5 1.5h5l3.5 3.5v9h-8.5z M8.5 1.5v3.5h3.5",
  symlink: "M3.5 1.5h5l3.5 3.5v9h-8.5z M5.5 9.5h4m0 0-1.6-1.6m1.6 1.6-1.6 1.6",
  other: "M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z",
};

function kindIcon(kind: FileEntry["kind"]): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("class", "files__icon");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", ICON_PATHS[kind]);
  svg.append(path);
  return svg;
}
