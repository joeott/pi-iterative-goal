import { type Phase, type PhaseArtifact } from "../types.js";

function normalizeContentParts(content: unknown): any[] {
  if (Array.isArray(content)) return content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!content || typeof content !== "object") return [];
  if ("type" in (content as Record<string, unknown>)) return [content];
  return [];
}

export function extractTextFromParts(content: unknown): string {
  const parts = normalizeContentParts(content);
  const text: string[] = [];

  for (const part of parts) {
    if (typeof part === "string") {
      text.push(part);
      continue;
    }
    if (!part || typeof part !== "object") continue;
    const record = part as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      text.push(record.text);
      continue;
    }
    if (typeof record.text === "string") {
      text.push(record.text);
    }
  }

  return text.join("").trim();
}

function extractToolCallsFromParts(content: unknown): Array<{ name: string; args: Record<string, unknown> }> {
  const parts = normalizeContentParts(content);
  const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const record = part as Record<string, unknown>;
    if (record.type === "toolCall" && typeof record.name === "string") {
      toolCalls.push({
        name: record.name,
        args: record.arguments && typeof record.arguments === "object"
          ? record.arguments as Record<string, unknown>
          : {},
      });
    }
  }

  return toolCalls;
}

export function synthesizePhaseResultSafe(
  event: any,
  phase: Phase,
  cycle: number,
  runId: string,
  phaseAttemptId: string,
): (PhaseArtifact & { _nonceMatched?: boolean }) | null {
  const messages = event.messages;
  if (!messages || messages.length === 0) return null;

  let lastAssistantText = "";
  let lastAssistantToolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const toolErrors: Array<{ name: string; error: string }> = [];
  let nonceMatched = false;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      const assistantText = extractTextFromParts(msg.content);
      const toolCalls = extractToolCallsFromParts(msg.content);
      for (const toolCall of toolCalls) {
        if (toolCall.args.runId === runId && toolCall.args.phaseAttemptId === phaseAttemptId) {
          nonceMatched = true;
        }
      }
      if (assistantText || toolCalls.length > 0) {
        lastAssistantText = assistantText;
        lastAssistantToolCalls = toolCalls;
        break;
      }
    }
    if (msg.role === "toolResult" && msg.isError) {
      toolErrors.push({
        name: msg.toolName || "unknown",
        error: extractTextFromParts(msg.content) || JSON.stringify(msg.content).slice(0, 500),
      });
    }
  }

  if (!lastAssistantText && lastAssistantToolCalls.length === 0) {
    return {
      phase, cycle,
      status: "failed_recoverable",
      content: `No output detected from model during ${phase} phase. Possible provider/tool incompatibility.`,
      timestamp: new Date().toISOString(), toolCalls: [], toolErrors,
      synthesis: {
        source: "synthetic_failure",
        nonceMatched: false,
        reason: "assistant_output_missing",
      },
      _nonceMatched: false,
    };
  }

  return {
    phase, cycle,
    status: "completed",
    content: lastAssistantText || `${lastAssistantToolCalls.length} tool calls without text output.`,
    timestamp: new Date().toISOString(), toolCalls: lastAssistantToolCalls, toolErrors,
    synthesis: {
      source: lastAssistantText ? "assistant_text" : "assistant_tool_calls",
      nonceMatched,
      reason: nonceMatched ? undefined : "assistant_output_without_matching_harness_nonce",
    },
    _nonceMatched: nonceMatched,
  };
}
