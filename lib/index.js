/**
 * generate_image —— 用火山方舟（Ark）为 DeepSeek Harness 生成图片。
 *
 * DSH 插件形态：Cordis 插件 + defineTool 注册到 ctx.tools。
 * 纯 ESM、无第三方依赖（Node 18+ 自带 fetch）。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

const DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3'
const DEFAULT_MODEL = 'doubao-seedream-4-5-251128'
const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504])

/** 从环境变量兜底读取配置，preset 行的 config 优先。 */
function resolveConfig(config = {}) {
  const env = process.env
  return {
    apiKey: config.apiKey ?? env.ARK_API_KEY ?? '',
    baseUrl: (config.baseUrl ?? env.ARK_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, ''),
    model: config.model ?? env.ARK_IMAGE_MODEL ?? DEFAULT_MODEL,
    watermark: config.watermark ?? String(env.IMAGE_WATERMARK ?? 'false').toLowerCase() === 'true',
    timeoutMs: Number(config.timeoutMs ?? env.HTTP_TIMEOUT_MS ?? 120000),
    maxRetries: Number(config.maxRetries ?? env.HTTP_MAX_RETRIES ?? 2),
  }
}

class ArkError extends Error {
  constructor(message, { code = 'unknown', status = 0, retryable = false } = {}) {
    super(message)
    this.name = 'ArkError'
    this.code = code
    this.status = status
    this.retryable = retryable
  }
}

function parseError(body, status) {
  let code = `http_${status}`
  let message = body.slice(0, 500)
  try {
    const parsed = JSON.parse(body)
    if (parsed?.error && typeof parsed.error === 'object') {
      code = String(parsed.error.code ?? code)
      message = String(parsed.error.message ?? message)
    }
  } catch {
    /* 非 JSON 错误体，保留原文 */
  }
  return new ArkError(`[${status}] ${message}`, {
    code,
    status,
    retryable: RETRYABLE_STATUS.has(status),
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 一次方舟调用，带 429/5xx 退避重试与取消支持。 */
async function requestOnce(payload, cfg, signal) {
  if (!cfg.apiKey) {
    throw new ArkError('缺少 ARK_API_KEY：请在 preset 行 config.apiKey 或环境变量里配置', {
      code: 'missing_ark_api_key',
    })
  }

  let lastError
  for (let attempt = 0; attempt <= cfg.maxRetries; attempt += 1) {
    const timeout = AbortSignal.timeout(cfg.timeoutMs)
    const composed = signal ? AbortSignal.any([signal, timeout]) : timeout
    try {
      const response = await fetch(`${cfg.baseUrl}/images/generations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: composed,
      })
      const text = await response.text()
      if (!response.ok) {
        const error = parseError(text, response.status)
        if (error.retryable && attempt < cfg.maxRetries) {
          lastError = error
          await sleep(Math.min(2 ** attempt * 1000, 8000))
          continue
        }
        throw error
      }
      return JSON.parse(text)
    } catch (error) {
      if (error instanceof ArkError) throw error
      if (error?.name === 'AbortError') {
        throw new ArkError('请求被取消或超时', { code: 'aborted', retryable: true })
      }
      lastError = new ArkError(`网络请求失败：${error?.message ?? error}`, {
        code: 'network_error',
        retryable: true,
      })
      if (attempt < cfg.maxRetries) {
        await sleep(Math.min(2 ** attempt * 1000, 8000))
        continue
      }
      throw lastError
    }
  }
  throw lastError ?? new ArkError('请求失败', { code: 'unknown' })
}

async function generateImages(args, cfg, signal) {
  const prompt = String(args.prompt ?? '').trim()
  if (!prompt) throw new ArkError('prompt 不能为空', { code: 'empty_prompt' })

  const count = Math.max(1, Math.min(Number(args.count ?? 1) || 1, 4))
  const payloadBase = {
    model: cfg.model,
    prompt,
    size: args.size || '2K',
    output_format: args.output_format || 'png',
    response_format: 'url',
    watermark: args.watermark ?? cfg.watermark,
  }
  if (Array.isArray(args.reference_image_urls) && args.reference_image_urls.length > 0) {
    payloadBase.image = args.reference_image_urls
  }

  const settled = await Promise.allSettled(
    Array.from({ length: count }, () => requestOnce(payloadBase, cfg, signal)),
  )

  const images = []
  const failures = []
  for (const outcome of settled) {
    if (outcome.status === 'rejected') {
      failures.push(outcome.reason?.message ?? String(outcome.reason))
      continue
    }
    for (const item of outcome.value?.data ?? []) {
      if (item?.url) images.push({ url: item.url, ...(item.size ? { size: item.size } : {}) })
    }
  }

  if (images.length === 0) {
    // 全部失败时保留第一个业务错误的 code/status，便于模型和用户判断是配置问题还是参数问题
    const firstError = settled.find((outcome) => outcome.status === 'rejected')?.reason
    if (firstError instanceof ArkError) throw firstError
    throw new ArkError(
      failures.length > 0 ? `生成失败：${failures[0]}` : '接口没有返回任何图片 URL',
      { code: 'empty_result' },
    )
  }

  return {
    images,
    model: cfg.model,
    ...(failures.length > 0 ? { warnings: failures } : {}),
  }
}

export const name = 'tool-image-ark'
export const inject = ['tools']

export function apply(ctx, config = {}) {
  const cfg = resolveConfig(config)

  ctx.tools.register(
    defineTool({
      name: 'generate_image',
      description:
        '根据文字描述生成图片，返回可直接访问的图片 URL（24 小时内有效）。' +
        '当用户要求画图、配图、生成插画/海报/头像/封面/示意图，或需要把描述变成可视化图片时调用。' +
        '只负责生成图片，不要用它查资料或回答文字问题。画面元素写进 prompt：主体、风格、构图、光线、色调、画幅。',
      parameters: {
        prompt: {
          type: 'string',
          required: true,
          description:
            '画面内容的详细描述。写清主体、风格、构图、光线、色调、画幅比例；使用与用户相同的语言；' +
            '不要写“生成图片”这类指令性废话，直接描述画面。',
        },
        size: {
          type: 'string',
          description: '输出尺寸：1K / 2K / 4K 档位，或 WxH（如 1024x1024、1280x720）。竖图用 720x1280。默认 2K。',
          default: '2K',
        },
        count: {
          type: 'integer',
          description: '生成张数 1-4，默认 1。只有用户明确要多张时才大于 1。',
          default: 1,
        },
        output_format: {
          type: 'string',
          enum: ['png', 'jpeg'],
          description: '图片格式，默认 png。',
          default: 'png',
        },
        watermark: {
          type: 'boolean',
          description: '是否加 AI 生成水印，默认跟随插件配置（默认不加）。',
        },
        reference_image_urls: {
          type: 'array',
          items: { type: 'string' },
          description: '可选。参考图的公网 http(s) 链接，用于图生图、风格迁移、角色一致性。没有就省略。',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            images: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  url: { type: 'string', required: true, description: '可直接访问的图片地址。' },
                  size: { type: 'string', description: '实际输出尺寸，如 2048x2048。' },
                },
              },
            },
            model: { type: 'string', required: true, description: '实际使用的方舟模型 ID。' },
            warnings: {
              type: 'array',
              items: { type: 'string' },
              description: '部分图片生成失败时的说明。',
            },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: JSON.stringify(value),
          },
        ],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return generateImages(args, cfg, exec?.signal)
      },
    }),
  )
}
