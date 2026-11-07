import { createDevnetClient, noteProofs } from "./client.ts";
import { RING1_NOTE_HASHES, RING1_TREE } from "./notes.ts";

const apiKey = process.env.HELIUS_API_KEY;
if (apiKey === undefined || apiKey.length === 0) {
  console.error("HELIUS_API_KEY is missing");
  process.exit(1);
}

const client = await createDevnetClient(apiKey);
const proofs = await noteProofs(client, RING1_TREE, RING1_NOTE_HASHES);
for (const proof of proofs.proofs) {
  console.log(
    `leaf_index=${proof.leafIndex} path_len=${proof.path.length} root_seq=${proof.rootSeq}`,
  );
}
process.exit(0);
