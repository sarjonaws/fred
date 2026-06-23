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

// Ancho útil: el transcript vive dentro de cajas con paddingX={1} (2 chars),
// así que reservamos un margen para que las reglas (hr, separadores) no se
// desborden y partan a la siguiente línea. Tope a 100 para no estirar prosa.
const COLS = process.stdout.columns || 80;
const CONTENT_WIDTH = Math.min(COLS - 4, 100);

// marked-terminal con ancho explícito + reflow: arregla el desborde del hr y la
// sobre-indentación de listas que se veía con la configuración por defecto.
marked.use(
  markedTerminal({
    width: CONTENT_WIDTH,
    reflowText: true,
    tab: 2,
  }) as Parameters<typeof marked.use>[0]
);

/** Markdown -> ANSI para terminal; si algo falla, texto plano. */
function md(text: string): string {
  try {
    return String(marked.parse(text)).trim();
  } catch {
    return text;
  }
}

type EntryKind = "banner" | "user" | "tool" | "answer" | "usage" | "info" | "error";

interface Entry {
  id: number;
  kind: EntryKind;
  text: string;
}

const STREAM_TAIL_LINES = 10; // líneas visibles de la respuesta en curso
const RULE = "╌".repeat(CONTENT_WIDTH); // separador fino para el bloque de uso

export interface TuiOptions {
  /** Agente ya construido (lo arma cli.ts vía buildAgent, soportando .db y .fdb). */
  agent: RagAgent;
  /** Etiqueta de la base para el pie (ruta del .db/.fdb). */
  label: string;
  model: string;
}

export function App({ agent, label, model }: TuiOptions) {
  const { exit } = useApp();
  const agentRef = useRef<RagAgent | null>(null);
  if (!agentRef.current) agentRef.current = agent;

  const historyRef = useRef<Anthropic.MessageParam[]>([]);
  const totalsRef = useRef({ calls: 0, cost: 0 });
  const queueRef = useRef<string[]>([]);
  const nextId = useRef(0);

  // El banner es el primer item del transcript (Static lo fija arriba del todo).
  const [entries, setEntries] = useState<Entry[]>(() => [
    { id: -1, kind: "banner", text: `${label}\n${model}` },
  ]);
  const [busy, setBusy] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [input, setInput] = useState("");

  const push = (kind: EntryKind, text: string) =>
    setEntries((prev) => [...prev, { id: nextId.current++, kind, text }]);

  const totalsLine = () =>
    `Acumulado de la sesión: ${totalsRef.current.calls} llamadas a Claude, ~$${totalsRef.current.cost.toFixed(4)} USD`;

  const processQuestion = async (question: string): Promise<void> => {
    push("user", question);

    if (question === "/salir" || question === "/exit") {
      push("info", totalsLine());
      agentRef.current?.close();
      exit();
      return;
    }
    if (question === "/nueva") {
      historyRef.current = [];
      push("info", "Sesión reiniciada.");
      return;
    }
    if (question === "/uso") {
      push("info", totalsLine());
      return;
    }

    setBusy(true);
    setStreamText("");
    try {
      const result = await agentRef.current!.ask(question, historyRef.current, {
        onTool: (name, toolInput) => push("tool", `${name} ${JSON.stringify(toolInput)}`),
        onText: (delta) => setStreamText((t) => t + delta),
      });
      historyRef.current = result.history;
      totalsRef.current.calls += result.usage.claudeCalls;
      totalsRef.current.cost += result.usage.estimatedCostUSD ?? 0;
      push("answer", md(result.answer));
      push("usage", formatUsage(result.usage));
    } catch (e) {
      push("error", `Error: ${e instanceof Error ? e.message : e}`);
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
      <Static items={entries}>{(entry) => <EntryView key={entry.id} entry={entry} />}</Static>

      {busy && (
        <Box flexDirection="column" paddingX={1} marginTop={1}>
          {streamText && (
            <Text>
              {streamTruncated ? `${RULE}\n` : ""}
              {streamTail.join("\n")}
            </Text>
          )}
          <Box marginTop={streamText ? 1 : 0}>
            <Text color="green"><Spinner type="dots" /></Text>
            <Text color="green" dimColor> pensando{queueRef.current.length ? `  ·  ${queueRef.current.length} en cola` : ""}…</Text>
          </Box>
        </Box>
      )}

      <Box borderStyle="round" borderColor="cyan" paddingX={1} marginTop={busy ? 0 : 1}>
        <Text color="cyan" bold>❯ </Text>
        <TextInput value={input} onChange={setInput} onSubmit={onSubmit} placeholder="pregunta…  ·  /nueva  /uso  /salir" />
      </Box>
      <Box paddingX={1}>
        <Text dimColor>{label} · {model} · Enter envía (se encola si está ocupado) · Ctrl+C sale</Text>
      </Box>
    </Box>
  );
}

/** Render de una entrada del transcript según su tipo. */
function EntryView({ entry }: { entry: Entry }) {
  switch (entry.kind) {
    case "banner": {
      const [base, model] = entry.text.split("\n");
      return (
        <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginBottom={1}>
          <Text color="cyan" bold>🔍 fred — consulta arquitectónica</Text>
          <Text dimColor>base:   {base}</Text>
          <Text dimColor>modelo: {model}</Text>
          <Text dimColor>Pregunta en lenguaje natural; las respuestas citan archivo:línea.</Text>
        </Box>
      );
    }
    case "user":
      return (
        <Box paddingX={1} marginTop={1}>
          <Text color="cyan" bold>❯ </Text>
          <Text bold>{entry.text}</Text>
        </Box>
      );
    case "tool":
      return (
        <Box paddingX={1}>
          <Text color="magenta" dimColor>  ⚙ {entry.text}</Text>
        </Box>
      );
    case "answer":
      return (
        <Box paddingX={1} marginTop={1}>
          <Text>{entry.text}</Text>
        </Box>
      );
    case "usage":
      return (
        <Box flexDirection="column" paddingX={1} marginTop={1}>
          <Text dimColor>{RULE}</Text>
          <Text dimColor>{entry.text}</Text>
        </Box>
      );
    case "error":
      return (
        <Box paddingX={1} marginTop={1}>
          <Text color="red">{entry.text}</Text>
        </Box>
      );
    case "info":
    default:
      return (
        <Box paddingX={1}>
          <Text dimColor>{entry.text}</Text>
        </Box>
      );
  }
}

export function runTui(opts: TuiOptions) {
  if (!process.stdin.isTTY) {
    console.error("El modo TUI necesita una terminal interactiva. Usa `chat` para entrada por pipe.");
    process.exitCode = 1;
    return;
  }
  render(<App {...opts} />);
}
