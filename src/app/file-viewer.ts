/**
 * Read-only text file viewer.
 *
 * Content is fetched through the same lease-checked download path the Download
 * button uses, so there is no new server surface here — the server has already
 * verified the fingerprint and size before any bytes reach us. Everything below
 * is presentation, and every remote string is written via textContent so a
 * hostile file can never inject markup.
 */

/**
 * Files larger than this are refused before any bytes are fetched. The server
 * allows up to `maxEmbeddedDownloadBytes` (8 MiB by default), but that much
 * text in a single <pre> locks up the tab — and nobody reads a 8 MiB file in a
 * modal. Download remains available for anything bigger.
 */
export const MAX_VIEWABLE_BYTES = 1024 * 1024;

/** Rendering more than this many lines janks layout; the tail is dropped. */
const MAX_VIEWABLE_LINES = 5000;

/** Bytes inspected when deciding whether content is binary. */
const SNIFF_BYTES = 8000;

export interface ViewableFile {
  name: string;
  size: number;
}

export type DecodeResult =
  { kind: "text"; text: string; truncatedLines: boolean } | { kind: "binary" };

/**
 * A NUL in the leading bytes is the standard binary heuristic (it is what git
 * uses). UTF-16 text trips it too, which is acceptable: we cannot render it
 * usefully here either way.
 */
export function isProbablyBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, SNIFF_BYTES);
  for (let index = 0; index < limit; index += 1)
    if (bytes[index] === 0) return true;
  return false;
}

/** Decode as strict UTF-8, refusing anything that is not valid text. */
export function decodeTextFile(buffer: ArrayBuffer): DecodeResult {
  const bytes = new Uint8Array(buffer);
  if (isProbablyBinary(bytes)) return { kind: "binary" };

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // Invalid UTF-8 — treat as binary rather than rendering replacement chars.
    return { kind: "binary" };
  }

  const lines = text.split("\n");
  if (lines.length <= MAX_VIEWABLE_LINES)
    return { kind: "text", text, truncatedLines: false };
  return {
    kind: "text",
    text: lines.slice(0, MAX_VIEWABLE_LINES).join("\n"),
    truncatedLines: true,
  };
}

export function formatViewerBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Open `file` in a modal and resolve once it is dismissed. `load` is the
 * lease-checked fetch; it receives an AbortSignal that fires if the operator
 * closes the viewer mid-download.
 */
export function openFileViewer(
  file: ViewableFile,
  load: (signal: AbortSignal) => Promise<ArrayBuffer>,
): Promise<void> {
  const controller = new AbortController();
  const view = buildViewerDialog(file);

  // Supersede any viewer still on screen so modals cannot stack.
  openViewer?.close();
  openViewer = view.dialog;

  document.body.append(view.dialog);
  if (typeof view.dialog.showModal === "function") view.dialog.showModal();
  else view.dialog.open = true;
  view.closeButton.focus();

  const dismissed = new Promise<void>((resolve) => {
    view.dialog.addEventListener(
      "close",
      () => {
        if (openViewer === view.dialog) openViewer = undefined;
        controller.abort();
        view.dialog.remove();
        resolve();
      },
      { once: true },
    );
  });

  if (file.size > MAX_VIEWABLE_BYTES)
    view.showNotice(
      `This file is ${formatViewerBytes(file.size)}. Preview is limited to ${formatViewerBytes(MAX_VIEWABLE_BYTES)} — use Download to read the whole file.`,
    );
  else
    void load(controller.signal)
      .then((buffer) => {
        if (controller.signal.aborted) return;
        const decoded = decodeTextFile(buffer);
        if (decoded.kind === "binary")
          view.showNotice(
            "This looks like a binary file, so there is nothing to preview. Use Download to fetch it.",
          );
        else view.showText(decoded.text, decoded.truncatedLines);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        view.showNotice(
          error instanceof Error ? error.message : "Unable to read this file",
        );
      });

  return dismissed;
}

interface ViewerDialog {
  dialog: HTMLDialogElement;
  closeButton: HTMLButtonElement;
  showText(text: string, truncatedLines: boolean): void;
  showNotice(message: string): void;
}

function buildViewerDialog(file: ViewableFile): ViewerDialog {
  const dialog = document.createElement("dialog");
  dialog.className = "send-dialog file-viewer";
  dialog.dataset.state = "loading";

  const titleId = `quick-shell-viewer-title-${++viewerSeq}`;
  dialog.setAttribute("aria-labelledby", titleId);

  const heading = document.createElement("h2");
  heading.id = titleId;
  heading.className = "file-viewer__title";
  heading.textContent = file.name;

  const meta = document.createElement("p");
  meta.className = "send-dialog__meta";
  meta.textContent = formatViewerBytes(file.size);

  const body = document.createElement("pre");
  body.className = "file-viewer__body";
  body.tabIndex = 0;
  body.setAttribute("role", "document");
  body.setAttribute("aria-live", "polite");
  body.textContent = "Loading…";

  const actions = document.createElement("div");
  actions.className = "send-dialog__actions";
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.textContent = "Close";
  closeButton.addEventListener("click", () => dialog.close());
  actions.append(closeButton);

  dialog.append(heading, meta, body, actions);

  return {
    dialog,
    closeButton,
    showText(text, truncatedLines) {
      dialog.dataset.state = "ready";
      // textContent, never innerHTML: file contents are untrusted input.
      body.textContent = text;
      const lines = text ? text.split("\n").length : 0;
      meta.textContent = text
        ? `${formatViewerBytes(file.size)} · ${lines} line${lines === 1 ? "" : "s"}${
            truncatedLines ? ` (first ${MAX_VIEWABLE_LINES} shown)` : ""
          }`
        : `${formatViewerBytes(file.size)} · empty file`;
      if (!text) body.textContent = "This file is empty";
    },
    showNotice(message) {
      dialog.dataset.state = "notice";
      body.textContent = message;
    },
  };
}

let viewerSeq = 0;
let openViewer: HTMLDialogElement | undefined;

/**
 * Dismiss an open viewer. Called when the file explorer tears down, so a
 * modal cannot outlive the panel that opened it.
 */
export function closeFileViewer(): void {
  openViewer?.close();
}
