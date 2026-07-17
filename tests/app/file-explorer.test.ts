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
    const rows = [...mount.querySelectorAll(".files__row")];
    expect(rows[0]?.textContent).toContain("Download");
    expect(rows[1]?.textContent).not.toContain("Download");
  });
});
