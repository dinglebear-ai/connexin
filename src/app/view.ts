export interface ShellElements {
  container: HTMLElement;
  status: HTMLParagraphElement;
  sessionSummary: HTMLDivElement;
  commandStrip: HTMLFormElement;
  commandInput: HTMLInputElement;
  insertButton: HTMLButtonElement;
  terminalMount: HTMLDivElement;
  transcript: HTMLPreElement;
  actions: HTMLDivElement;
  connectButton: HTMLButtonElement;
  displayModeButton: HTMLButtonElement;
  sendButton: HTMLButtonElement;
  downloadButton: HTMLButtonElement;
  closeButton: HTMLButtonElement;
  dialog: HTMLDialogElement;
  textarea: HTMLTextAreaElement;
  meta: HTMLParagraphElement;
  warnings: HTMLUListElement;
  fallback: HTMLTextAreaElement;
  cancelButton: HTMLButtonElement;
  confirmButton: HTMLButtonElement;
}

export function buildShell(): ShellElements {
  const container = document.createElement("section");
  container.className = "shell";
  container.setAttribute("aria-labelledby", "quick-shell-title");

  const header = document.createElement("header");
  header.className = "shell__header";
  const identity = document.createElement("div");
  identity.className = "shell__identity";
  const mark = document.createElement("span");
  mark.className = "shell__mark";
  mark.setAttribute("aria-hidden", "true");
  mark.textContent = ">_";
  const title = document.createElement("h1");
  title.id = "quick-shell-title";
  title.className = "shell__product";
  title.textContent = "Quick Shell";
  const descriptor = document.createElement("span");
  descriptor.className = "shell__descriptor";
  descriptor.textContent = "SSH terminal";
  identity.append(mark, title, descriptor);
  const status = document.createElement("p");
  status.className = "shell__status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.setAttribute("aria-atomic", "true");
  status.textContent = "Waiting";
  status.dataset.tone = "neutral";
  header.append(identity, status);

  const sessionSummary = document.createElement("div");
  sessionSummary.className = "shell__summary";
  sessionSummary.hidden = true;
  sessionSummary.setAttribute("aria-live", "polite");

  const commandStrip = document.createElement("form");
  commandStrip.className = "command-strip";
  const commandInput = document.createElement("input");
  commandInput.type = "text";
  commandInput.autocomplete = "off";
  commandInput.spellcheck = false;
  commandInput.placeholder = "Suggested command";
  commandInput.setAttribute("aria-label", "Suggested command");
  const insertButton = document.createElement("button");
  insertButton.type = "submit";
  insertButton.textContent = "Insert";
  insertButton.dataset.variant = "primary";
  insertButton.disabled = true;
  commandStrip.append(commandInput, insertButton);

  const terminalMount = document.createElement("div");
  terminalMount.className = "terminal";
  terminalMount.setAttribute("role", "region");
  terminalMount.setAttribute("aria-label", "Terminal output");
  const transcript = document.createElement("pre");
  transcript.className = "terminal-transcript sr-only";
  transcript.setAttribute("aria-label", "Terminal transcript");
  transcript.setAttribute("aria-live", "polite");

  const actions = document.createElement("div");
  actions.className = "actions";
  actions.setAttribute("aria-label", "Session actions");
  const connectButton = document.createElement("button");
  connectButton.type = "button";
  connectButton.textContent = "Reconnect";
  connectButton.disabled = true;
  connectButton.hidden = true;
  const displayModeButton = document.createElement("button");
  displayModeButton.type = "button";
  displayModeButton.textContent = "Fullscreen";
  displayModeButton.hidden = true;
  const sendButton = document.createElement("button");
  sendButton.type = "button";
  sendButton.textContent = "Send output";
  sendButton.dataset.variant = "primary";
  sendButton.disabled = true;
  const downloadButton = document.createElement("button");
  downloadButton.type = "button";
  downloadButton.textContent = "Download output";
  downloadButton.disabled = true;
  downloadButton.hidden = true;
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.textContent = "Close";
  closeButton.dataset.variant = "danger";
  closeButton.disabled = true;
  actions.append(
    connectButton,
    displayModeButton,
    sendButton,
    downloadButton,
    closeButton,
  );

  const dialog = document.createElement("dialog");
  dialog.className = "send-dialog";
  dialog.setAttribute("aria-labelledby", "quick-shell-send-title");
  dialog.setAttribute(
    "aria-describedby",
    "quick-shell-send-meta quick-shell-send-warnings",
  );
  const dialogTitle = document.createElement("h2");
  dialogTitle.id = "quick-shell-send-title";
  dialogTitle.textContent = "Send output";
  const textarea = document.createElement("textarea");
  textarea.rows = 12;
  textarea.spellcheck = false;
  textarea.setAttribute("aria-label", "Output to send");
  const meta = document.createElement("p");
  meta.id = "quick-shell-send-meta";
  meta.className = "send-dialog__meta";
  const warnings = document.createElement("ul");
  warnings.id = "quick-shell-send-warnings";
  warnings.className = "send-dialog__warnings";
  warnings.setAttribute("aria-live", "polite");
  const fallback = document.createElement("textarea");
  fallback.className = "send-dialog__fallback";
  fallback.readOnly = true;
  fallback.hidden = true;
  fallback.setAttribute("aria-label", "Fallback output to copy");
  const dialogActions = document.createElement("div");
  dialogActions.className = "send-dialog__actions";
  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.textContent = "Cancel";
  const confirmButton = document.createElement("button");
  confirmButton.type = "button";
  confirmButton.textContent = "Confirm";
  confirmButton.dataset.variant = "primary";
  dialogActions.append(cancelButton, confirmButton);
  dialog.append(dialogTitle, textarea, meta, warnings, fallback, dialogActions);

  container.append(
    header,
    sessionSummary,
    commandStrip,
    terminalMount,
    transcript,
    actions,
    dialog,
  );

  return {
    container,
    status,
    sessionSummary,
    commandStrip,
    commandInput,
    insertButton,
    terminalMount,
    transcript,
    actions,
    connectButton,
    displayModeButton,
    sendButton,
    downloadButton,
    closeButton,
    dialog,
    textarea,
    meta,
    warnings,
    fallback,
    cancelButton,
    confirmButton,
  };
}
