import * as fs from "node:fs";
import * as path from "node:path";

export function logDebug(scope: string, message: string): void {
  try {
    const logPath = process.env.PI_ITERATIVE_GOAL_DEBUG_LOG
      ?? path.join(process.cwd(), ".pi", "iterative-goal", "debug.log");
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] [${scope}] ${message}\n`);
  } catch {}
}
