#!/usr/bin/env node
import { main } from "./cli.ts";
import { realIo } from "./io.ts";

const io = realIo();
process.exitCode = await main(process.argv.slice(2), io);
io.close();
