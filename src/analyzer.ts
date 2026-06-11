/**
 * Fase 1 del MVP: extracción estructural determinística.
 * Usa ts-morph (wrapper del compilador de TypeScript) en lugar de tree-sitter
 * porque nos da resolución real de símbolos: cuando `createOrder()` llama a
 * `applyDiscount()`, sabemos exactamente en qué archivo y línea vive el callee.
 */
import { Project, Node, SyntaxKind, SourceFile, FunctionDeclaration, MethodDeclaration, ArrowFunction, FunctionExpression, ClassDeclaration } from "ts-morph";
import * as path from "node:path";
import * as fs from "node:fs";
import { CodeDB } from "./db.js";

type CallableNode = FunctionDeclaration | MethodDeclaration | ArrowFunction | FunctionExpression;

export interface AnalyzeOptions {
  repoPath: string;
  dbPath: string;
  verbose?: boolean;
}

export function analyze(opts: AnalyzeOptions) {
  const repo = path.resolve(opts.repoPath);
  if (!fs.existsSync(repo)) throw new Error(`No existe la ruta: ${repo}`);

  const tsconfig = path.join(repo, "tsconfig.json");
  const project = fs.existsSync(tsconfig)
    ? new Project({ tsConfigFilePath: tsconfig, skipAddingFilesFromTsConfig: false })
    : new Project({
        compilerOptions: {
          allowJs: false,
          target: 99 /* ESNext */,
          module: 199 /* NodeNext */,
          moduleResolution: 99 /* NodeNext */,
        },
      });

  if (!fs.existsSync(tsconfig)) {
    project.addSourceFilesAtPaths([
      path.join(repo, "**/*.ts"),
      path.join(repo, "**/*.tsx"),
      `!${path.join(repo, "**/node_modules/**")}`,
      `!${path.join(repo, "**/dist/**")}`,
      `!${path.join(repo, "**/*.d.ts")}`,
    ]);
  }

  const db = new CodeDB(opts.dbPath);
  db.reset();

  const sourceFiles = project
    .getSourceFiles()
    .filter((sf) => !sf.getFilePath().includes("node_modules") && !sf.isDeclarationFile());

  // ---- Pasada 1: registrar archivos y símbolos ----------------------------
  // Mapa: posición-inicio-de-declaración -> symbol_id (para resolver llamadas en la pasada 2)
  const declToSymbolId = new Map<string, number>();
  const fileIds = new Map<string, number>();

  const declKey = (sf: SourceFile, pos: number) => `${sf.getFilePath()}#${pos}`;

  const getDoc = (node: Node): string | null => {
    if (!Node.isJSDocable(node)) return null;
    const docs = node.getJsDocs().map((d) => d.getDescription().trim()).filter(Boolean);
    return docs.length ? docs.join("\n") : null;
  };

  const registerCallable = (
    node: CallableNode,
    fileId: number,
    sf: SourceFile,
    name: string,
    kind: string,
    parent: string | null,
    exported: boolean,
    docNode?: Node
  ): number => {
    const sig = node.getSignature?.()
      ? safeSignature(node)
      : null;
    const id = db.insertSymbol({
      file_id: fileId,
      name,
      kind,
      parent,
      start_line: node.getStartLineNumber(),
      end_line: node.getEndLineNumber(),
      signature: sig,
      doc: getDoc(docNode ?? node),
      exported: exported ? 1 : 0,
    });
    declToSymbolId.set(declKey(sf, node.getStart()), id);
    return id;
  };

  const safeSignature = (node: CallableNode): string | null => {
    try {
      const params = node.getParameters().map((p) => p.getText()).join(", ");
      const ret = node.getReturnTypeNode()?.getText() ?? "";
      return `(${params})${ret ? ": " + ret : ""}`;
    } catch {
      return null;
    }
  };

  for (const sf of sourceFiles) {
    const rel = path.relative(repo, sf.getFilePath());
    const fileId = db.insertFile(rel, sf.getEndLineNumber());
    fileIds.set(sf.getFilePath(), fileId);

    // Imports
    for (const imp of sf.getImportDeclarations()) {
      const mod = imp.getModuleSpecifierValue();
      const named = imp.getNamedImports().map((n) => n.getName()).join(",") || imp.getDefaultImport()?.getText() || null;
      db.insertImport(fileId, mod, named);
    }

    // Funciones top-level
    for (const fn of sf.getFunctions()) {
      const name = fn.getName() ?? "<anónima>";
      registerCallable(fn, fileId, sf, name, "function", null, fn.isExported());
    }

    // Clases, métodos, interfaces, types, enums
    for (const cls of sf.getClasses()) {
      const clsName = cls.getName() ?? "<anónima>";
      db.insertSymbol({
        file_id: fileId, name: clsName, kind: "class", parent: null,
        start_line: cls.getStartLineNumber(), end_line: cls.getEndLineNumber(),
        signature: null, doc: getDoc(cls), exported: cls.isExported() ? 1 : 0,
      });
      for (const m of cls.getMethods()) {
        registerCallable(m, fileId, sf, m.getName(), "method", clsName, cls.isExported());
      }
    }

    for (const i of sf.getInterfaces()) {
      db.insertSymbol({
        file_id: fileId, name: i.getName(), kind: "interface", parent: null,
        start_line: i.getStartLineNumber(), end_line: i.getEndLineNumber(),
        signature: null, doc: getDoc(i), exported: i.isExported() ? 1 : 0,
      });
    }
    for (const t of sf.getTypeAliases()) {
      db.insertSymbol({
        file_id: fileId, name: t.getName(), kind: "type", parent: null,
        start_line: t.getStartLineNumber(), end_line: t.getEndLineNumber(),
        signature: null, doc: getDoc(t), exported: t.isExported() ? 1 : 0,
      });
    }
    for (const e of sf.getEnums()) {
      db.insertSymbol({
        file_id: fileId, name: e.getName(), kind: "enum", parent: null,
        start_line: e.getStartLineNumber(), end_line: e.getEndLineNumber(),
        signature: null, doc: getDoc(e), exported: e.isExported() ? 1 : 0,
      });
    }

    // Arrow functions / function expressions asignadas a const (patrón muy común en TS)
    for (const vd of sf.getVariableDeclarations()) {
      const init = vd.getInitializer();
      if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
        const stmt = vd.getVariableStatement();
        registerCallable(
          init as CallableNode, fileId, sf, vd.getName(), "arrow", null,
          stmt?.isExported() ?? false, stmt ?? vd
        );
      }
    }
  }

  // ---- Pasada 2: grafo de llamadas ----------------------------------------
  // Para cada símbolo invocable, recorremos sus CallExpression y resolvemos
  // el símbolo del callee con el type-checker de TypeScript.
  let resolved = 0, unresolved = 0;

  for (const sf of sourceFiles) {
    const callables: { node: CallableNode; id: number }[] = [];

    const collect = (node: CallableNode) => {
      const id = declToSymbolId.get(declKey(sf, node.getStart()));
      if (id !== undefined) callables.push({ node, id });
    };
    sf.getFunctions().forEach(collect);
    sf.getClasses().forEach((c) => c.getMethods().forEach(collect));
    sf.getVariableDeclarations().forEach((vd) => {
      const init = vd.getInitializer();
      if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) collect(init as CallableNode);
    });

    for (const { node, id } of callables) {
      for (const call of node.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        // Evitar contar llamadas que pertenecen a una función anidada ya registrada
        const enclosing = call.getFirstAncestor(
          (a) => declToSymbolId.has(declKey(sf, a.getStart())) && a !== node as unknown as Node
        );
        if (enclosing && enclosing.getStart() !== node.getStart()) continue;

        const expr = call.getExpression();
        const calleeName = Node.isPropertyAccessExpression(expr) ? expr.getName() : expr.getText();
        let calleeId: number | null = null;

        try {
          let sym = expr.getSymbol();
          // Si el símbolo es un alias de import, seguirlo hasta la declaración original
          const aliased = sym?.getAliasedSymbol();
          if (aliased) sym = aliased;
          const decl = sym?.getDeclarations()?.[0];
          if (decl) {
            const declSf = decl.getSourceFile();
            // Si la declaración es un VariableDeclaration con arrow, la clave es el inicializador
            let target: Node = decl;
            if (Node.isVariableDeclaration(decl)) {
              const init = decl.getInitializer();
              if (init) target = init;
            }
            calleeId = declToSymbolId.get(declKey(declSf, target.getStart())) ?? null;
          }
        } catch { /* resolución fallida: queda como llamada externa */ }

        calleeId !== null ? resolved++ : unresolved++;
        db.insertCall(id, calleeId, calleeName, call.getStartLineNumber());
      }
    }
  }

  const stats = {
    files: sourceFiles.length,
    symbols: Number((db.db.prepare(`SELECT COUNT(*) c FROM symbols`).get() as any).c),
    calls: resolved + unresolved,
    resolvedCalls: resolved,
  };
  db.close();
  return stats;
}
