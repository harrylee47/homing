/**
 * 帧的编解码与校验。WS 边界上所有入站数据都必须经过这里，
 * 不允许任何地方直接 JSON.parse 后当成可信对象使用。
 */
import { z } from 'zod'
import {
  CLOCK_SKEW_TOLERANCE_MS,
  DownstreamFrame,
  ErrorCode,
  PROTOCOL_VERSION,
  UpstreamFrame,
  type AnyFrame,
} from './protocol.js'

export type ParseOk<T> = { ok: true; frame: T }
export type ParseErr = { ok: false; code: ErrorCode; message: string }
export type ParseResult<T> = ParseOk<T> | ParseErr

/** 生成 uuid-v4。Node 与 Workers 均提供 crypto.randomUUID，不引入依赖。 */
export const uuid = (): string => crypto.randomUUID()
export const newEventId = (): string => `evt_${crypto.randomUUID()}`
export const newCmdId = (): string => `cmd_${crypto.randomUUID()}`

/** 构造一帧。调用方只关心 type 与 payload。 */
export function makeFrame<T extends AnyFrame['type'], P>(
  type: T,
  payload: P,
  now: number = Date.now(),
): { v: number; type: T; msg_id: string; ts: number; payload: P } {
  return { v: PROTOCOL_VERSION, type, msg_id: uuid(), ts: now, payload }
}

export const encodeFrame = (frame: unknown): string => JSON.stringify(frame)

/**
 * 解析并校验一帧上行数据。
 *
 * 校验顺序有意为之：先 JSON、再版本、再结构、最后时钟——
 * 这样版本不兼容时能给出明确错误码，而不是淹没在结构校验的报错里。
 */
export function parseUpstream(raw: string, now: number = Date.now()): ParseResult<UpstreamFrame> {
  return parseWith(UpstreamFrame, raw, now)
}

export function parseDownstream(raw: string, now: number = Date.now()): ParseResult<DownstreamFrame> {
  return parseWith(DownstreamFrame, raw, now)
}

function parseWith<S extends z.ZodType<{ ts: number }>>(
  schema: S,
  raw: string,
  now: number,
): ParseResult<z.infer<S>> {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return { ok: false, code: ErrorCode.PROTOCOL_MALFORMED, message: '非法 JSON' }
  }

  // 版本先判，便于回 PROTOCOL_VERSION_UNSUPPORTED 而非笼统的结构错误
  if (typeof json !== 'object' || json === null) {
    return { ok: false, code: ErrorCode.PROTOCOL_MALFORMED, message: '帧不是对象' }
  }
  const v = (json as { v?: unknown }).v
  if (v !== PROTOCOL_VERSION) {
    return {
      ok: false,
      code: ErrorCode.PROTOCOL_VERSION_UNSUPPORTED,
      message: `不支持的协议版本 ${String(v)}，服务端为 ${PROTOCOL_VERSION}`,
    }
  }

  const parsed = schema.safeParse(json)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    const path = first?.path.join('.') ?? '?'
    return { ok: false, code: ErrorCode.PROTOCOL_MALFORMED, message: `字段 ${path}: ${first?.message ?? '校验失败'}` }
  }

  // 时钟窗口校验，抵御重放（计划 §6.4）
  const skew = Math.abs(now - parsed.data.ts)
  if (skew > CLOCK_SKEW_TOLERANCE_MS) {
    return {
      ok: false,
      code: ErrorCode.CLOCK_SKEW,
      message: `时间戳偏移 ${Math.round(skew / 1000)}s，超出 ${CLOCK_SKEW_TOLERANCE_MS / 1000}s 容忍范围`,
    }
  }

  return { ok: true, frame: parsed.data }
}
