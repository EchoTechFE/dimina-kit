import { promisify } from 'node:util'
import { brotliDecompress, gunzip, inflate } from 'node:zlib'

const decompressors = {
  gzip: promisify(gunzip),
  'x-gzip': promisify(gunzip),
  deflate: promisify(inflate),
  br: promisify(brotliDecompress),
}

/** Node http exposes wire bytes; callers and the Network body cache need decoded bytes. */
export async function decodeContent(buffer: Buffer, encoding: string): Promise<Buffer> {
  let decoded = buffer
  for (const name of encoding.toLowerCase().split(',').map((value) => value.trim()).reverse()) {
    const decompress = decompressors[name as keyof typeof decompressors]
    if (decompress && decoded.length > 0) decoded = await decompress(decoded)
  }
  return decoded
}

export function decodeResponseData(buffer: Buffer, dataType = 'json', responseType = 'text'): unknown {
  if (responseType === 'arraybuffer' || dataType === 'arraybuffer') {
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  }
  const text = buffer.toString('utf-8')
  if (dataType !== 'json') return text
  try { return JSON.parse(text) } catch { return text }
}
