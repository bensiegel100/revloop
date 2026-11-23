import { describe, expect, it, vi } from "vitest";

const connect = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock("../src/reviewServer.js", () => ({
  createReviewServer: () => ({ connect }),
}));
vi.mock("@modelcontextprotocol/server/stdio", () => ({
  StdioServerTransport: class {
    public readonly kind = "stdio";
  },
}));

describe("MCP stdio entrypoint", () => {
  it("connects the review server to stdio", async () => {
    await import("../src/server.js");

    await vi.waitFor(() => {
      expect(connect).toHaveBeenCalledOnce();
    });
  });
});
