/**
 * In-app modal dialogs.
 *
 * Replaces `window.prompt` / `window.confirm`, which a sandboxed MCP App iframe
 * may block outright and which never match the host theme when it does allow
 * them. Markup and class names mirror the send-dialog built in view.ts so both
 * pick up the same styling.
 */

export interface PromptOptions {
  title: string;
  label: string;
  value?: string;
  confirmLabel?: string;
  placeholder?: string;
  /** Rendered under the input; use for destructive-path context. */
  hint?: string;
}

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  tone?: "default" | "danger";
}

let openDialog: HTMLDialogElement | undefined;

/**
 * Dismiss an open prompt/confirm as a cancellation. Called when the surface
 * that raised it tears down, so a modal cannot outlive it.
 */
export function closeOpenDialog(): void {
  openDialog?.close("cancel");
}

/**
 * Ask for a single line of text. Resolves to the trimmed value, or `undefined`
 * if the operator cancelled (Escape, Cancel, or backdrop dismissal).
 */
export function promptDialog(
  options: PromptOptions,
): Promise<string | undefined> {
  const { dialog, form } = createDialog(options.title);

  const field = document.createElement("label");
  field.className = "modal__field";
  const labelText = document.createElement("span");
  labelText.textContent = options.label;
  const input = document.createElement("input");
  input.type = "text";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.required = true;
  input.value = options.value ?? "";
  if (options.placeholder) input.placeholder = options.placeholder;
  field.append(labelText, input);
  form.append(field);

  if (options.hint) {
    const hint = document.createElement("p");
    hint.className = "modal__hint";
    hint.textContent = options.hint;
    form.append(hint);
  }

  form.append(buildActions({ confirmLabel: options.confirmLabel ?? "Save" }));

  return present(dialog, () => {
    input.focus();
    input.select();
  }).then((confirmed) => {
    if (!confirmed) return undefined;
    const value = input.value.trim();
    return value || undefined;
  });
}

/** Ask a yes/no question. Resolves true only on explicit confirmation. */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  const { dialog, form } = createDialog(options.title);

  const message = document.createElement("p");
  message.className = "modal__message";
  message.textContent = options.message;
  form.append(message);

  const actions = buildActions({
    confirmLabel: options.confirmLabel ?? "Confirm",
    tone: options.tone,
  });
  form.append(actions);

  return present(dialog, () => {
    // Focus Cancel, not the destructive action, so a stray Enter is harmless.
    actions.querySelector<HTMLButtonElement>("[value='cancel']")?.focus();
  });
}

function createDialog(title: string): {
  dialog: HTMLDialogElement;
  form: HTMLFormElement;
} {
  const dialog = document.createElement("dialog");
  dialog.className = "send-dialog modal";

  const titleId = `quick-shell-modal-title-${++dialogSeq}`;
  dialog.setAttribute("aria-labelledby", titleId);

  const heading = document.createElement("h2");
  heading.id = titleId;
  heading.textContent = title;

  // method="dialog" gives us native Enter-to-submit and sets returnValue from
  // the activated button, so no keydown handling is needed.
  const form = document.createElement("form");
  form.method = "dialog";

  dialog.append(heading, form);
  return { dialog, form };
}

let dialogSeq = 0;

function buildActions(options: {
  confirmLabel: string;
  tone?: "default" | "danger";
}): HTMLDivElement {
  const actions = document.createElement("div");
  actions.className = "send-dialog__actions";

  const cancel = document.createElement("button");
  cancel.type = "submit";
  cancel.value = "cancel";
  cancel.textContent = "Cancel";

  const confirm = document.createElement("button");
  confirm.type = "submit";
  confirm.value = "confirm";
  confirm.textContent = options.confirmLabel;
  confirm.dataset.variant = options.tone === "danger" ? "danger" : "primary";

  actions.append(cancel, confirm);
  return actions;
}

/**
 * Mount, show, and await the dialog. Always removes the node and clears the
 * singleton, so a rejected action can't leave an orphan modal behind.
 */
function present(
  dialog: HTMLDialogElement,
  onOpen: () => void,
): Promise<boolean> {
  // Only one modal at a time; a second request supersedes the first.
  openDialog?.close("cancel");

  document.body.append(dialog);
  openDialog = dialog;

  return new Promise<boolean>((resolve) => {
    dialog.addEventListener(
      "close",
      () => {
        if (openDialog === dialog) openDialog = undefined;
        dialog.remove();
        resolve(dialog.returnValue === "confirm");
      },
      { once: true },
    );

    // happy-dom and older engines lack showModal; fall back to a non-modal open
    // so tests and degraded hosts still see a usable dialog.
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.open = true;

    onOpen();
  });
}
