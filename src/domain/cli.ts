// Pure CLI argument parsing — no I/O.

/** Parse `--hdmi <n>`, `--hdmi=n`, or `--hdmiN` (n = 1..4) into "HDMI<n>". */
export function parseHdmiFlag(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    let raw: string | undefined;
    if (arg === "--hdmi") raw = args[i + 1];
    else if (arg.startsWith("--hdmi=")) raw = arg.slice("--hdmi=".length);
    else if (/^--hdmi[1-4]$/.test(arg)) raw = arg.slice("--hdmi".length);
    else continue;

    const n = raw?.replace(/^hdmi/i, "").trim();
    if (!n || !/^[1-4]$/.test(n)) {
      throw new Error(`Invalid --hdmi value "${raw ?? ""}". Use --hdmi 1, 2, 3, or 4.`);
    }
    return `HDMI${n}`;
  }
  return undefined;
}
