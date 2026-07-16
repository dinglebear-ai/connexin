export interface ShellElements {
  container: HTMLElement;
  status: HTMLParagraphElement;
  commandStrip: HTMLFormElement;
  commandInput: HTMLInputElement;
  insertButton: HTMLButtonElement;
  terminalMount: HTMLDivElement;
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
  const title = document.createElement("h1");
  title.id = "quick-shell-title";
  title.textContent = "quick-shell";
  const status = document.createElement("p");
  status.className = "shell__status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.setAttribute("aria-atomic", "true");
  status.textContent = "Waiting";
  header.append(title, status);

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
  insertButton.disabled = true;
  commandStrip.append(commandInput, insertButton);

  const terminalMount = document.createElement("div");
  terminalMount.className = "terminal";
  terminalMount.setAttribute("role", "region");
  terminalMount.setAttribute("aria-label", "Terminal output");

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
  sendButton.disabled = true;
  const downloadButton = document.createElement("button");
  downloadButton.type = "button";
  downloadButton.textContent = "Download output";
  downloadButton.disabled = true;
  downloadButton.hidden = true;
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.textContent = "Close";
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
  dialogActions.append(cancelButton, confirmButton);
  dialog.append(dialogTitle, textarea, meta, warnings, fallback, dialogActions);

  container.append(header, commandStrip, terminalMount, actions, dialog);

  return {
    container,
    status,
    commandStrip,
    commandInput,
    insertButton,
    terminalMount,
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
