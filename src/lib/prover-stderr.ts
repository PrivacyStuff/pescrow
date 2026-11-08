const PROVER_NOISE =
  /MODULE_TYPELESS_PACKAGE_JSON|does not parse as CommonJS|Reparsing as ES module|add "type": "module"|using deprecated parameters for the initialization function|\bTRANSACTION_PROGRAM_BUILD\b/;

const PROGRAM_ERROR = /custom program error: 0x[0-9a-fA-F]+/gi;

/** Drop Node's typeless-package warning and the hasher/build deprecation before stderr can become a user-facing error. */
export function stripProverStderr(text: string): string {
  const kept: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!PROVER_NOISE.test(line)) {
      const trimmed = line.trim();
      if (trimmed.length > 0) kept.push(trimmed);
      continue;
    }
    const program = line.match(PROGRAM_ERROR);
    if (program !== null) kept.push(...program);
  }
  return kept.join("\n");
}
