export const METAPLEX_METADATA_PROGRAM_ID = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
export const METADATA_KEY_V1 = 4;
export const METADATA_HEADER_LEN = 65;
export const METADATA_NAME_MAX = 32;
export const METADATA_SYMBOL_MAX = 10;
export const METADATA_URI_MAX = 200;
export const TOKEN_2022_ACCOUNT_TYPE_OFFSET = 165;
export const TOKEN_2022_MINT_ACCOUNT_TYPE = 1;
export const TOKEN_2022_METADATA_TYPE = 19;
export const TOKEN_2022_TLV_START = 166;
export const TEXT_MAX = 64;
export const URI_MAX = 500;

export type TokenMetadata = {
  readonly name: string | null;
  readonly symbol: string | null;
  readonly image: string | null;
};

const EMPTY: TokenMetadata = { name: null, symbol: null, image: null };

export function emptyTokenMetadata(): TokenMetadata {
  return EMPTY;
}

export function parseDasAsset(value: unknown): TokenMetadata | null {
  if (typeof value !== "object" || value === null) return null;
  const content = (value as { content?: unknown }).content;
  if (typeof content !== "object" || content === null) return null;
  const metadata = (content as { metadata?: unknown }).metadata;
  const name = textField(metadata, "name");
  const symbol = textField(metadata, "symbol");
  const image = dasImage(content);
  if (name === null && symbol === null && image === null) return null;
  return { name, symbol, image };
}

export function parseMetaplexMetadata(data: Uint8Array): TokenMetadata | null {
  if (data.length < METADATA_HEADER_LEN || data[0] !== METADATA_KEY_V1) return null;
  const name = readBorshString(data, METADATA_HEADER_LEN, METADATA_NAME_MAX);
  if (name === null) return null;
  const symbol = readBorshString(data, name.next, METADATA_SYMBOL_MAX);
  if (symbol === null) return null;
  const uri = readBorshString(data, symbol.next, METADATA_URI_MAX);
  if (uri === null) return null;
  const cleanedName = cleanText(name.value);
  const cleanedSymbol = cleanText(symbol.value);
  const image = imageUri(uri.value);
  if (cleanedName === null && cleanedSymbol === null && image === null) return null;
  return { name: cleanedName, symbol: cleanedSymbol, image };
}

export function parseToken2022Metadata(data: Uint8Array): TokenMetadata | null {
  if (data.length <= TOKEN_2022_TLV_START || data[TOKEN_2022_ACCOUNT_TYPE_OFFSET] !== TOKEN_2022_MINT_ACCOUNT_TYPE) return null;
  let offset = TOKEN_2022_TLV_START;
  while (offset + 4 <= data.length) {
    const type = data[offset]! + (data[offset + 1]! << 8);
    const length = data[offset + 2]! + (data[offset + 3]! << 8);
    offset += 4;
    if (type === 0) return null;
    if (offset + length > data.length) return null;
    if (type === TOKEN_2022_METADATA_TYPE) return parseTokenMetadataBody(data.subarray(offset, offset + length));
    offset += length;
  }
  return null;
}

export function preferMetadata(primary: TokenMetadata | null, fallback: TokenMetadata | null): TokenMetadata {
  return {
    name: primary?.name ?? fallback?.name ?? null,
    symbol: primary?.symbol ?? fallback?.symbol ?? null,
    image: primary?.image ?? fallback?.image ?? null,
  };
}

export function metadataLabel(meta: TokenMetadata | null | undefined): string | null {
  if (meta === undefined || meta === null) return null;
  if (meta.symbol !== null && meta.name !== null && meta.symbol !== meta.name) return `${meta.symbol} · ${meta.name}`;
  return meta.symbol ?? meta.name;
}

function parseTokenMetadataBody(body: Uint8Array): TokenMetadata | null {
  const updateAndMint = 64;
  if (body.length < updateAndMint + 4) return null;
  const name = readBorshString(body, updateAndMint, METADATA_URI_MAX);
  if (name === null) return null;
  const symbol = readBorshString(body, name.next, METADATA_URI_MAX);
  if (symbol === null) return null;
  const uri = readBorshString(body, symbol.next, METADATA_URI_MAX);
  if (uri === null) return null;
  const cleanedName = cleanText(name.value);
  const cleanedSymbol = cleanText(symbol.value);
  const image = imageUri(uri.value);
  if (cleanedName === null && cleanedSymbol === null && image === null) return null;
  return { name: cleanedName, symbol: cleanedSymbol, image };
}

function textField(value: unknown, key: string): string | null {
  if (typeof value !== "object" || value === null) return null;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? cleanText(field) : null;
}

function dasImage(content: object): string | null {
  const links = (content as { links?: unknown }).links;
  if (typeof links === "object" && links !== null) {
    const image = (links as { image?: unknown }).image;
    if (typeof image === "string") {
      const uri = imageUri(image);
      if (uri !== null) return uri;
    }
  }
  const files = (content as { files?: unknown }).files;
  if (!Array.isArray(files)) return null;
  for (const file of files) {
    if (typeof file !== "object" || file === null) continue;
    const mime = (file as { mime?: unknown }).mime;
    const uri = (file as { uri?: unknown }).uri;
    if (typeof mime === "string" && mime.startsWith("image/") && typeof uri === "string") {
      const image = httpUri(uri);
      if (image !== null) return image;
    }
  }
  return null;
}

function readBorshString(data: Uint8Array, offset: number, maxLen: number): { value: string; next: number } | null {
  if (offset + 4 > data.length) return null;
  const length = data[offset]! + (data[offset + 1]! << 8) + (data[offset + 2]! << 16) + ((data[offset + 3]! << 24) >>> 0);
  if (length > maxLen || offset + 4 + length > data.length) return null;
  return { value: new TextDecoder().decode(data.subarray(offset + 4, offset + 4 + length)), next: offset + 4 + length };
}

function cleanText(value: string): string | null {
  const cleaned = value.replaceAll("\0", "").trim();
  if (cleaned.length === 0 || cleaned.length > TEXT_MAX) return null;
  for (let index = 0; index < cleaned.length; index += 1) {
    const code = cleaned.charCodeAt(index);
    if (code < 32) return null;
  }
  return cleaned;
}

function imageUri(value: string): string | null {
  const uri = httpUri(value);
  if (uri === null || /\.json(?:$|\?)/i.test(uri)) return null;
  return uri;
}

function httpUri(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > URI_MAX) return null;
  if (!/^https?:\/\//i.test(trimmed)) return null;
  if (/\s/.test(trimmed)) return null;
  return trimmed;
}
