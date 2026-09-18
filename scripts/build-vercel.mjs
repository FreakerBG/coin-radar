import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";

// vinext and Next.js both use `.next` for generated metadata, but their
// contents are not interchangeable when developers run both builds locally.
await rm(".next", { recursive: true, force: true });

const child = spawn(
  process.execPath,
  ["./node_modules/next/dist/bin/next", "build"],
  {
    env: { ...process.env, VERCEL: "1" },
    stdio: "inherit",
  },
);

child.on("error", error => {
  console.error(error);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`Vercel build stopped by ${signal}.`);
    process.exitCode = 1;
    return;
  }

  process.exitCode = code ?? 1;
});
