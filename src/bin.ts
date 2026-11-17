#!/usr/bin/env node
import { main } from "./cli.ts";
import { realIo } from "./io.ts";

// A reader that stops early, as `concern requests | head` does, is not a failure.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});

const io = realIo();
process.exitCode = await main(process.argv.slice(2), io);
io.close();
