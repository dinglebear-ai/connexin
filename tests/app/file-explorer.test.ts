// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FileExplorerController } from "../../src/app/file-explorer.js";

describe("FileExplorerController", () => {
  beforeEach(() => document.body.replaceChildren());

  it("renders hostile names as text and navigates folders", async () => {
    const mount = document.createElement("div");
    document.body.append(mount);
    const api = {
      list: vi.fn(async () => ({
        entries: [
          {
            name: "<img src=x onerror=1>",
            path: "folder",
            kind: "directory",
            size: 0,
            modified: 0,
            mode: 0,
            fingerprint: "x",
          },
        ],
        maxEmbeddedDownloadBytes: 1,
      })),
      mutate: vi.fn(),
      upload: vi.fn(),
      download: vi.fn(),
    } as any;
    const controller = new FileExplorerController(mount, api, vi.fn());
    await controller.load();
    expect(mount.textContent).toContain("<img src=x onerror=1>");
    expect(mount.querySelector("img")).toBeNull();
    (mount.querySelector(".files__name") as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(api.list).toHaveBeenLastCalledWith("folder", expect.anything()),
    );
  });

  it("suppresses stale directory responses", async () => {
    const mount = document.createElement("div");
    document.body.append(mount);
    let resolveFirst!: (value: any) => void;
    const first = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    const api = {
      list: vi
        .fn()
        .mockReturnValueOnce(first)
        .mockResolvedValueOnce({
          entries: [
            {
              name: "new",
              path: "new",
              kind: "file",
              size: 1,
              modified: 0,
              mode: 0,
              fingerprint: "x",
            },
          ],
          maxEmbeddedDownloadBytes: 1,
        }),
    } as any;
    const controller = new FileExplorerController(mount, api, vi.fn());
    const old = controller.load("old");
    const current = controller.load("new");
    await current;
    resolveFirst({
      entries: [
        {
          name: "old",
          path: "old",
          kind: "file",
          size: 1,
          modified: 0,
          mode: 0,
          fingerprint: "x",
        },
      ],
      maxEmbeddedDownloadBytes: 1,
    });
    await old;
    expect(mount.querySelector(".files__name")?.textContent).toBe("new");
  });

  it("hides download actions above the embedded download cap", async () => {
    const mount = document.createElement("div");
    document.body.append(mount);
    const api = {
      list: vi.fn(async () => ({
        entries: [
          {
            name: "small.txt",
            path: "small.txt",
            kind: "file",
            size: 1,
            modified: 0,
            mode: 0,
            fingerprint: "x",
          },
          {
            name: "large.bin",
            path: "large.bin",
            kind: "file",
            size: 2,
            modified: 0,
            mode: 0,
            fingerprint: "y",
          },
        ],
        maxEmbeddedDownloadBytes: 1,
      })),
      mutate: vi.fn(),
      upload: vi.fn(),
      download: vi.fn(),
    } as any;
    const controller = new FileExplorerController(mount, api, vi.fn(), vi.fn());
    await controller.load();
    // Look rows up by name rather than index: rows are sorted for display, so
    // position does not track the order the server listed them in.
    const rowFor = (name: string) =>
      [...mount.querySelectorAll(".files__row")].find((row) =>
        row.querySelector(".files__name")?.textContent?.includes(name),
      );
    expect(rowFor("small.txt")?.textContent).toContain("Download");
    expect(rowFor("large.bin")?.textContent).not.toContain("Download");
  });

  describe("opening files", () => {
    async function explorer(download: () => Promise<ArrayBuffer>) {
      const mount = document.createElement("div");
      document.body.append(mount);
      const api = {
        list: vi.fn(async () => ({
          entries: [
            {
              name: "README.md",
              path: "README.md",
              kind: "file",
              size: 12,
              modified: 0,
              mode: 0o644,
              fingerprint: "x",
            },
            {
              name: "docs",
              path: "docs",
              kind: "directory",
              size: 0,
              modified: 0,
              mode: 0o755,
              fingerprint: "y",
            },
          ],
          maxEmbeddedDownloadBytes: 1024,
        })),
        mutate: vi.fn(),
        upload: vi.fn(),
        download: vi.fn(download),
      } as any;
      const controller = new FileExplorerController(mount, api, vi.fn());
      await controller.load();
      return { mount, api, controller };
    }

    const clickName = (mount: HTMLElement, name: string) =>
      [...mount.querySelectorAll<HTMLButtonElement>(".files__name")]
        .find((button) => button.textContent?.includes(name))!
        .click();

    it("opens a file in the viewer when its name is clicked", async () => {
      const contents = "# Hello\nworld\n";
      const { mount, api } = await explorer(
        async () => new TextEncoder().encode(contents).buffer as ArrayBuffer,
      );

      clickName(mount, "README.md");
      await vi.waitFor(() =>
        expect(document.querySelector(".file-viewer__body")?.textContent).toBe(
          contents,
        ),
      );
      // Reads go through the same lease-checked download the button uses.
      expect(api.download).toHaveBeenCalledOnce();
    });

    it("keeps file names actionable without a host download capability", async () => {
      // No download callback passed: previewing must still work, because it
      // never hands bytes to the host.
      const { mount } = await explorer(
        async () => new TextEncoder().encode("hi").buffer as ArrayBuffer,
      );
      const name = [
        ...mount.querySelectorAll<HTMLButtonElement>(".files__name"),
      ].find((button) => button.textContent?.includes("README.md"))!;
      expect(name.disabled).toBe(false);
    });

    it("navigates into directories rather than opening them", async () => {
      const { mount, api } = await explorer(async () => new ArrayBuffer(0));

      clickName(mount, "docs");
      await vi.waitFor(() =>
        expect(api.list).toHaveBeenLastCalledWith("docs", expect.anything()),
      );
      expect(document.querySelector(".file-viewer")).toBeNull();
      expect(api.download).not.toHaveBeenCalled();
    });

    it("dismisses an open viewer when the explorer is disposed", async () => {
      const { mount, controller } = await explorer(
        () => new Promise<ArrayBuffer>(() => {}),
      );

      clickName(mount, "README.md");
      await vi.waitFor(() =>
        expect(document.querySelector(".file-viewer")).not.toBeNull(),
      );

      controller.dispose();
      expect(document.querySelector(".file-viewer")).toBeNull();
    });
  });

  describe("sorting", () => {
    const entry = (over: Partial<Record<string, unknown>>) => ({
      name: "f",
      path: "f",
      kind: "file",
      size: 0,
      modified: 0,
      mode: 0o644,
      fingerprint: "f",
      ...over,
    });

    async function mounted(entries: unknown[]) {
      const mount = document.createElement("div");
      document.body.append(mount);
      const api = {
        list: vi.fn(async () => ({ entries, maxEmbeddedDownloadBytes: 0 })),
        mutate: vi.fn(),
        upload: vi.fn(),
        download: vi.fn(),
      } as any;
      const controller = new FileExplorerController(mount, api, vi.fn());
      await controller.load();
      return mount;
    }

    const names = (mount: HTMLElement) =>
      [...mount.querySelectorAll(".files__name")].map((n) => n.textContent);

    const clickSort = (mount: HTMLElement, key: string) =>
      mount
        .querySelector<HTMLButtonElement>(`.files__sort[data-key="${key}"]`)!
        .click();

    it("floats directories above files regardless of sort column", async () => {
      const mount = await mounted([
        entry({ name: "a-file", size: 900 }),
        entry({ name: "z-dir", kind: "directory" }),
      ]);
      expect(names(mount)).toEqual(["z-dir", "a-file"]);

      clickSort(mount, "size");
      expect(names(mount)[0]).toBe("z-dir");
    });

    it("sorts by name ascending by default", async () => {
      const mount = await mounted([
        entry({ name: "charlie" }),
        entry({ name: "alpha" }),
        entry({ name: "bravo" }),
      ]);
      expect(names(mount)).toEqual(["alpha", "bravo", "charlie"]);
    });

    it("reverses direction when the active column is clicked again", async () => {
      const mount = await mounted([
        entry({ name: "alpha" }),
        entry({ name: "bravo" }),
      ]);
      clickSort(mount, "name");
      expect(names(mount)).toEqual(["bravo", "alpha"]);
      clickSort(mount, "name");
      expect(names(mount)).toEqual(["alpha", "bravo"]);
    });

    it("defaults size and modified to largest and newest first", async () => {
      const mount = await mounted([
        entry({ name: "small", size: 1, modified: 1 }),
        entry({ name: "big", size: 999, modified: 999 }),
      ]);
      clickSort(mount, "size");
      expect(names(mount)).toEqual(["big", "small"]);

      clickSort(mount, "modified");
      expect(names(mount)).toEqual(["big", "small"]);
    });

    it("marks the active column for assistive tech", async () => {
      const mount = await mounted([entry({})]);
      const nameHeader = mount.querySelector('.files__sort[data-key="name"]')!;
      expect(nameHeader.getAttribute("aria-sort")).toBe("ascending");
      expect(
        mount
          .querySelector('.files__sort[data-key="size"]')!
          .getAttribute("aria-sort"),
      ).toBe("none");

      clickSort(mount, "size");
      expect(nameHeader.getAttribute("aria-sort")).toBe("none");
    });

    it("keeps the sort button focused across a sort", async () => {
      const mount = await mounted([
        entry({ name: "alpha" }),
        entry({ name: "bravo" }),
      ]);
      const sizeHeader = mount.querySelector<HTMLButtonElement>(
        '.files__sort[data-key="size"]',
      )!;
      sizeHeader.focus();
      sizeHeader.click();

      // Header buttons must be updated in place, not rebuilt, or a keyboard
      // operator loses their place after every sort.
      expect(document.activeElement).toBe(sizeHeader);
      expect(sizeHeader.isConnected).toBe(true);
      expect(sizeHeader.getAttribute("aria-sort")).toBe("descending");
    });

    it("exposes permission bits and an absolute timestamp as tooltips", async () => {
      const mount = await mounted([
        entry({ name: "script.sh", mode: 0o755, modified: 1_700_000_000_000 }),
      ]);
      expect(mount.querySelector(".files__name")!.getAttribute("title")).toBe(
        "script.sh — -rwxr-xr-x",
      );
      expect(
        mount.querySelector(".files__modified")!.getAttribute("title"),
      ).toBeTruthy();
    });

    it("leaves the modified cell blank when the server reports no mtime", async () => {
      const mount = await mounted([entry({ modified: 0 })]);
      const cell = mount.querySelector(".files__modified")!;
      expect(cell.textContent).toBe("");
      expect(cell.getAttribute("title")).toBeNull();
    });
  });
});
