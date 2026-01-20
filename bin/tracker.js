#!/usr/bin/env node
"use strict";

const { main } = require("../src/main");

main().catch((e) => {
  const msg = e && e.stack ? e.stack : String(e);
  console.error(msg);
  process.exitCode = 1;
});
