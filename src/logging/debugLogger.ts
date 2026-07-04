export type DebugFields = Record<string, unknown>;

const ANSI_GREEN = "\u001b[32m";
const ANSI_RESET = "\u001b[0m";

/**
 * 将字符串配置解析为布尔值。
 * 支持：1/true/yes/on/debug（大小写不敏感）。
 *
 * @param raw 环境变量原始值
 * @returns 是否视为开启
 */
function toBool(raw: string | undefined): boolean {
  if (raw === undefined) {
    return false;
  }

  const value = raw.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on" || value === "debug";
}

/**
 * 格式化日期为 `YYYY-MM-DD`。
 *
 * @param date 日期对象
 * @returns 日期字符串
 */
function formatDateOnly(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * 判断是否开启 debug 日志。
 * 读取 `APP_DEBUG` 或 `DEBUG`，任一开启即返回 true。
 *
 * @param env 运行环境变量
 * @returns debug 是否开启
 */
export function isDebugEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return toBool(env.APP_DEBUG) || toBool(env.DEBUG);
}

/**
 * 输出结构化 debug 日志。
 * 未开启 debug 时直接静默返回。
 *
 * 输出格式：`绿色 YYYY-MM-DD + JSON payload`。
 *
 * @param event 日志事件名
 * @param fields 附加字段
 */
export function debugLog(event: string, fields: DebugFields = {}): void {
  if (!isDebugEnabled()) {
    return;
  }

  const now = new Date();
  const greenDate = `${ANSI_GREEN}${formatDateOnly(now)}${ANSI_RESET}`;
  const payload = JSON.stringify({
    ts: now.toISOString(),
    level: "debug",
    event,
    ...fields,
  });

  console.log(`${greenDate} ${payload}`);
}
