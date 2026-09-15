import type { ArchiveEntry, ArchiveWriter } from '../../ports/runtime'

/**
 * 最小 ZIP 写入器（纯函数 + `node:zlib` 无关；**STORE 方式不压缩**）。
 * 用最小依赖换取"项目导出 zip"能力：结构符合 PKZIP（本地文件头 + 中央目录 + EOCD），
 * 可用系统解压工具打开；不追求压缩率（会话日志/记忆均为文本，体积可控）。
 */

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc = ((CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8)) >>> 0
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** DOS 时间（zip 头要求；用固定值保证同一输入产出相同字节） */
const DOS_TIME = 0
const DOS_DATE = 0x2821 // 2000-01-01

function utf8(name: string): Buffer {
  return Buffer.from(name, 'utf8')
}

export function createZipWriter(): ArchiveWriter {
  return {
    build(entries: readonly ArchiveEntry[]): Buffer {
      const locals: Buffer[] = []
      const centrals: Buffer[] = []
      let offset = 0

      for (const entry of entries) {
        const name = utf8(entry.path.replace(/\\/g, '/'))
        const data = Buffer.from(entry.content, 'utf8')
        const crc = crc32(data)

        const local = Buffer.alloc(30)
        local.writeUInt32LE(0x04034b50, 0)
        local.writeUInt16LE(20, 4) // version needed
        local.writeUInt16LE(0x0800, 6) // UTF-8 名称
        local.writeUInt16LE(0, 8) // store
        local.writeUInt16LE(DOS_TIME, 10)
        local.writeUInt16LE(DOS_DATE, 12)
        local.writeUInt32LE(crc, 14)
        local.writeUInt32LE(data.length, 18)
        local.writeUInt32LE(data.length, 22)
        local.writeUInt16LE(name.length, 26)
        local.writeUInt16LE(0, 28)
        locals.push(local, name, data)

        const central = Buffer.alloc(46)
        central.writeUInt32LE(0x02014b50, 0)
        central.writeUInt16LE(20, 4) // version made by
        central.writeUInt16LE(20, 6) // version needed
        central.writeUInt16LE(0x0800, 8)
        central.writeUInt16LE(0, 10)
        central.writeUInt16LE(DOS_TIME, 12)
        central.writeUInt16LE(DOS_DATE, 14)
        central.writeUInt32LE(crc, 16)
        central.writeUInt32LE(data.length, 20)
        central.writeUInt32LE(data.length, 24)
        central.writeUInt16LE(name.length, 28)
        central.writeUInt16LE(0, 30)
        central.writeUInt16LE(0, 32)
        central.writeUInt16LE(0, 34)
        central.writeUInt16LE(0, 36)
        central.writeUInt32LE(0, 38)
        central.writeUInt32LE(offset, 42)
        centrals.push(central, name)

        offset += local.length + name.length + data.length
      }

      const centralBuffer = Buffer.concat(centrals)
      const eocd = Buffer.alloc(22)
      eocd.writeUInt32LE(0x06054b50, 0)
      eocd.writeUInt16LE(0, 4)
      eocd.writeUInt16LE(0, 6)
      eocd.writeUInt16LE(entries.length, 8)
      eocd.writeUInt16LE(entries.length, 10)
      eocd.writeUInt32LE(centralBuffer.length, 12)
      eocd.writeUInt32LE(offset, 16)
      eocd.writeUInt16LE(0, 20)

      return Buffer.concat([...locals, centralBuffer, eocd])
    },
  }
}
