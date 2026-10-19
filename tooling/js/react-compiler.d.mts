// Types for react-compiler.mjs, for the Vite configs that import it.

export const REPO_ROOT: string;

export interface CompilerLogger {
  logEvent(filename: string | null, event: { kind: string }): void;
}

export function compilerOptions<T extends object>(
  extra?: T,
): { target: "19"; compilationMode: "infer"; panicThreshold: "none" } & T;

export function compilerEnabled(
  env?: Record<string, string | undefined>,
): boolean;

export function isReactSource(file: string): boolean;

export function reactSourceIdFilter(root?: string): {
  include: RegExp[];
  exclude: RegExp[];
};

export function mayHoldReact(file: string, code: string): boolean;

export function compileSource(args: {
  babel: unknown;
  pluginPath: string;
  file: string;
  code: string;
  logger?: CompilerLogger | null;
  sourceMaps?: boolean | "inline";
}): string;

export function createCollector(): {
  logger: CompilerLogger;
  files: Map<
    string,
    {
      compiled: Array<{ fn: string; line: number | null; memoSlots: number }>;
      bailouts: Map<
        string,
        { line: number | null; categories: string[]; reason: string }
      >;
    }
  >;
};

/** `@vitejs/plugin-react`'s `reactCompilerPreset` and
 *  `@rolldown/plugin-babel`'s default export, from the calling app. The
 *  parameter types are loose on purpose: the result goes into Vite's
 *  `plugins`, which takes either. */
export function reactCompiler(deps: {
  reactCompilerPreset: (options: never) => unknown;
  babel: (options: never) => unknown;
  root?: string;
}): any[];
