// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { confirmDialog, promptDialog } from "../../src/app/dialogs.js";

function activeDialog(): HTMLDialogElement {
  const dialog = document.querySelector("dialog");
  if (!dialog) throw new Error("no dialog mounted");
  return dialog;
}

function click(value: "confirm" | "cancel"): void {
  activeDialog()
    .querySelector<HTMLButtonElement>(`[value="${value}"]`)!
    .click();
}

describe("dialogs", () => {
  beforeEach(() => document.body.replaceChildren());

  describe("promptDialog", () => {
    it("resolves the trimmed input and unmounts on confirm", async () => {
      const pending = promptDialog({ title: "Rename", label: "New name" });
      activeDialog().querySelector("input")!.value = "  notes.txt  ";
      click("confirm");

      await expect(pending).resolves.toBe("notes.txt");
      expect(document.querySelector("dialog")).toBeNull();
    });

    it("seeds the input with the current value", async () => {
      const pending = promptDialog({
        title: "Rename",
        label: "New name",
        value: "old.txt",
      });
      expect(activeDialog().querySelector("input")!.value).toBe("old.txt");
      click("cancel");
      await pending;
    });

    it("resolves undefined on cancel", async () => {
      const pending = promptDialog({ title: "New folder", label: "Name" });
      activeDialog().querySelector("input")!.value = "ignored";
      click("cancel");

      await expect(pending).resolves.toBeUndefined();
      expect(document.querySelector("dialog")).toBeNull();
    });

    it("treats a whitespace-only entry as no answer", async () => {
      const pending = promptDialog({ title: "New folder", label: "Name" });
      activeDialog().querySelector("input")!.value = "   ";
      click("confirm");

      await expect(pending).resolves.toBeUndefined();
    });

    it("resolves undefined when dismissed with Escape", async () => {
      const pending = promptDialog({ title: "New folder", label: "Name" });
      activeDialog().close();

      await expect(pending).resolves.toBeUndefined();
    });
  });

  describe("confirmDialog", () => {
    it("resolves true only on explicit confirmation", async () => {
      const pending = confirmDialog({ title: "Delete", message: "Sure?" });
      click("confirm");
      await expect(pending).resolves.toBe(true);
    });

    it("resolves false on cancel", async () => {
      const pending = confirmDialog({ title: "Delete", message: "Sure?" });
      click("cancel");
      await expect(pending).resolves.toBe(false);
    });

    it("resolves false when dismissed without choosing", async () => {
      const pending = confirmDialog({ title: "Delete", message: "Sure?" });
      activeDialog().close();
      await expect(pending).resolves.toBe(false);
    });

    it("marks the danger action so it is styled as destructive", () => {
      void confirmDialog({
        title: "Delete",
        message: "Sure?",
        confirmLabel: "Delete",
        tone: "danger",
      });
      const confirm =
        activeDialog().querySelector<HTMLButtonElement>("[value='confirm']")!;
      expect(confirm.dataset.variant).toBe("danger");
      expect(confirm.textContent).toBe("Delete");
    });

    it("renders untrusted names as text, never markup", () => {
      void confirmDialog({
        title: "Delete",
        message: 'Delete "<img src=x onerror=alert(1)>"?',
      });
      const message = activeDialog().querySelector(".modal__message")!;
      expect(message.querySelector("img")).toBeNull();
      expect(message.textContent).toContain("<img src=x onerror=alert(1)>");
    });
  });

  it("supersedes an already-open modal instead of stacking", async () => {
    const first = confirmDialog({ title: "First", message: "one" });
    const second = confirmDialog({ title: "Second", message: "two" });

    await expect(first).resolves.toBe(false);
    expect(document.querySelectorAll("dialog")).toHaveLength(1);
    expect(activeDialog().querySelector("h2")!.textContent).toBe("Second");

    click("confirm");
    await expect(second).resolves.toBe(true);
    expect(document.querySelector("dialog")).toBeNull();
  });

  it("labels each dialog by its own heading", () => {
    void confirmDialog({ title: "Delete file", message: "Sure?" });
    const dialog = activeDialog();
    const headingId = dialog.querySelector("h2")!.id;
    expect(headingId).not.toBe("");
    expect(dialog.getAttribute("aria-labelledby")).toBe(headingId);
  });
});
