/**
 * Fase 3: interfaz TUI interactiva (Ink/React) sobre el RagAgent.
 * Transcript persistente con <Static>, respuesta en streaming en la zona
 * dinámica (solo las últimas líneas, para no romper el repintado de Ink),
 * markdown renderizado a ANSI al completar cada respuesta, spinner mientras
 * el agente trabaja, y cola de entrada: lo que escribas mientras responde
 * se procesa como siguiente pregunta.
 */
import React, { useRef, useState } from "react";
import { render, Box, Text, Static, useApp } from "ink";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";
import type Anthropic from "@anthropic-ai/sdk";
import { RagAgent, formatUsage } from "./rag.js";

marked.use(markedTerminal() as Parameters<typeof marked.use>[0]);

/** Markdown -> ANSI para terminal; si algo falla, texto plano. */
function md(text: string): string {
  try {
    return String(marked.parse(text)).trim();
  } catch {
    return text;
  }
}

interface Entry {
  id: number;
  text: string;
  color?: string;
  dim?: boolean;
}

const STREAM_TAIL_LINES = 10; // líneas visibles de la respuesta en curso

export interface TuiOptions {
  dbPath: string;
  model: string;
}

export function App({ dbPath, model }: TuiOptions) {
  const { exit } = useApp();
  const agentRef = useRef<RagAgent | null>(null);
  if (!agentRef.current) agentRef.current = new RagAgent({ dbPath, model });

  const historyRef = useRef<Anthropic.MessageParam[]>([]);
  const totalsRef = useRef({ calls: 0, cost: 0 });
  const queueRef = useRef<string[]>([]);
  const nextId = useRef(0);

  const [entries, setEntries] = useState<Entry[]>([]);
  const [busy, setBusy] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [input, setInput] = useState("");

  const push = (text: string, opts: Partial<Entry> = {}) =>
    setEntries((prev) => [...prev, { id: nextId.current++, text, ...opts }]);

  const totalsLine = () =>
    `Acumulado de la sesión: ${totalsRef.current.calls} llamadas a Claude, ~$${totalsRef.current.cost.toFixed(4)} USD`;

  const processQuestion = async (question: string): Promise<void> => {
    push(`Coco Arquitect › ${question}`, { color: "cyan" });

    if (question === "/salir" || question === "/exit") {
      push(totalsLine(), { dim: true });
      agentRef.current?.close();
      exit();
      return;
    }
    if (question === "/nueva") {
      historyRef.current = [];
      push("Sesión reiniciada.", { dim: true });
      return;
    }
    if (question === "/uso") {
      push(totalsLine(), { dim: true });
      return;
    }

    setBusy(true);
    setStreamText("");
    try {
      const result = await agentRef.current!.ask(question, historyRef.current, {
        onTool: (name, toolInput) => push(`  → ${name} ${JSON.stringify(toolInput)}`, { dim: true }),
        onText: (delta) => setStreamText((t) => t + delta),
      });
      historyRef.current = result.history;
      totalsRef.current.calls += result.usage.claudeCalls;
      totalsRef.current.cost += result.usage.estimatedCostUSD ?? 0;
      push(md(result.answer));
      push(formatUsage(result.usage), { dim: true });
    } catch (e) {
      push(`Error: ${e instanceof Error ? e.message : e}`, { color: "red" });
    }
    setStreamText("");
    setBusy(false);

    const queued = queueRef.current.shift();
    if (queued) return processQuestion(queued);
  };

  const onSubmit = (value: string) => {
    const question = value.trim();
    setInput("");
    if (!question) return;
    if (busy) queueRef.current.push(question);
    else void processQuestion(question);
  };

  const streamTail = streamText.split("\n").slice(-STREAM_TAIL_LINES);
  const streamTruncated = streamText.split("\n").length > STREAM_TAIL_LINES;

  return (
    <Box flexDirection="column">
      <Static items={entries}>
        {(entry) => (
          <Box key={entry.id} marginBottom={entry.dim ? 0 : 1} paddingX={1}>
            <Text color={entry.color} dimColor={entry.dim}>{entry.text}</Text>
          </Box>
        )}
      </Static>

      {busy && (
        <Box flexDirection="column" paddingX={1}>
          {streamText && (
            <Text>
              {streamTruncated ? "…\n" : ""}
              {streamTail.join("\n")}
            </Text>
          )}
          <Box marginTop={1}>
            <Text color="green"><Spinner type="dots" /></Text>
            <Text dimColor> pensando{queueRef.current.length ? `  (${queueRef.current.length} en cola)` : ""}…</Text>
          </Box>
        </Box>
      )}

      <Box borderStyle="round" borderColor="gray" paddingX={1} marginTop={busy ? 0 : 1}>
        <Text color="cyan" bold>tú › </Text>
        <TextInput value={input} onChange={setInput} onSubmit={onSubmit} placeholder="pregunta, o /nueva /uso /salir" />
      </Box>
      <Box paddingX={1}>
        <Text dimColor>{dbPath} · {model} · Enter envía (se encola si está ocupado) · Ctrl+C sale</Text>
      </Box>
    </Box>
  );
}

export function runTui(opts: TuiOptions) {
  if (!process.stdin.isTTY) {
    console.error("El modo TUI necesita una terminal interactiva. Usa `chat` para entrada por pipe.");
    process.exitCode = 1;
    return;
  }
  render(<App {...opts} />);
}
