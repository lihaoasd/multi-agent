import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import type { ModelCapability, ProviderKind } from '../../ports/model'
import type { ModelPreset, ModelPresetModel, ModelPresetProvider } from '../../ports/model-config'

/** 内置预置目录（随仓库只读） */
export const DEFAULT_PRESET_PATH = 'src/shared/model-presets.yaml'

const KINDS: readonly ProviderKind[] = ['openai-compatible', 'anthropic', 'gemini', 'ollama']
const CAPABILITIES: readonly ModelCapability[] = ['chat', 'stream', 'tools', 'reasoning']

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function parseSuggestedModel(raw: unknown): ModelPresetModel | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const model = asString(record['model'])
  if (model.length === 0) return null
  const capabilities = Array.isArray(record['capabilities'])
    ? record['capabilities'].filter(
        (item): item is ModelCapability => typeof item === 'string' && CAPABILITIES.includes(item as ModelCapability),
      )
    : []
  const displayName = asString(record['displayName'])
  return {
    model,
    ...(displayName.length === 0 ? {} : { displayName }),
    ...(capabilities.length === 0 ? {} : { capabilities }),
  }
}

function parsePreset(raw: unknown): ModelPreset | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const presetId = asString(record['presetId'])
  const kind = asString(record['kind']) as ProviderKind
  if (presetId.length === 0 || !KINDS.includes(kind)) return null
  const docsUrl = asString(record['docsUrl'])
  const suggested = Array.isArray(record['suggestedModels'])
    ? record['suggestedModels'].map(parseSuggestedModel).filter((item): item is ModelPresetModel => item !== null)
    : []
  return {
    presetId,
    name: asString(record['name'], presetId),
    kind,
    baseUrl: asString(record['baseUrl']),
    credentialHint: asString(record['credentialHint'], ''),
    suggestedModels: suggested,
    ...(docsUrl.length === 0 ? {} : { docsUrl }),
    supportsModelDiscovery: record['supportsModelDiscovery'] === true,
  }
}

/**
 * 从 YAML 读取预置目录：进程内读一次并缓存（文件随仓库、运行期不变）。
 * 解析出来的目录**不含任何密钥**，只有 kind / baseUrl / 建议模型 / 提示文案。
 */
export function createYamlModelPresetProvider(path: string = DEFAULT_PRESET_PATH): ModelPresetProvider {
  let cached: readonly ModelPreset[] | null = null
  return {
    list(): readonly ModelPreset[] {
      if (cached !== null) return cached
      const text = readFileSync(path, 'utf8')
      const parsed: unknown = parse(text)
      const raw =
        typeof parsed === 'object' && parsed !== null
          ? (parsed as Record<string, unknown>)['presets']
          : undefined
      cached = Array.isArray(raw)
        ? raw.map(parsePreset).filter((item): item is ModelPreset => item !== null)
        : []
      return cached
    },
  }
}

/** 内存预置目录（测试用） */
export function createInMemoryModelPresetProvider(presets: readonly ModelPreset[]): ModelPresetProvider {
  return { list: () => presets }
}
