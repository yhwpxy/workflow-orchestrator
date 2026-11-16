import type { ValidationDetail } from './types.js';

/**
 * 业务错误（规格 6.3 错误码表）。
 * 错误体统一为 { code, message, details? }。
 */
export class ApiError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly details?: ValidationDetail[],
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** 映射到 HTTP 状态码：业务错误返回 4xx/5xx（规格 6.1） */
  get httpStatus(): number {
    switch (this.code) {
      case 40001:
      case 40002:
      case 40003:
        return 400;
      case 40401:
      case 40402:
        return 404;
      case 40901:
        return 409;
      default:
        return 500;
    }
  }
}

export const ERR = {
  /** 请求 JSON 结构非法 */
  BAD_PLAN_STRUCTURE: (msg: string) => new ApiError(40001, msg),
  /** 编排方案校验失败（附 details 定位） */
  VALIDATION_FAILED: (details: ValidationDetail[]) =>
    new ApiError(40002, '编排方案校验失败', details),
  /** 规格解析/分解失败 */
  DECOMPOSE_FAILED: (msg: string) => new ApiError(40003, msg),
  /** 方案不存在 */
  PLAN_NOT_FOUND: (id: string) => new ApiError(40401, `方案不存在: ${id}`),
  /** 运行记录不存在 */
  RUN_NOT_FOUND: (id: string) => new ApiError(40402, `运行记录不存在: ${id}`),
  /** 方案正在执行中 */
  PLAN_BUSY: (id: string) => new ApiError(40901, `方案正在执行中: ${id}`),
  /** 服务器内部错误 */
  INTERNAL: (msg: string) => new ApiError(50000, msg),
};
