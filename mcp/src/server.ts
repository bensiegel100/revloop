import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createReviewServer } from "./reviewServer.js";

void createReviewServer()
  .connect(new StdioServerTransport())
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
