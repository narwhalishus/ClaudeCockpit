#!/usr/bin/env node
import("../dist/gateway/prod.js")
  .then((m) => m.main())
  .catch((err) => {
    console.error("Failed to start ClaudeCockpit:", err);
    process.exit(1);
  });
