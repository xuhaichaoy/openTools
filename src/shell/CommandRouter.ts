import type { ResultItem } from "@/components/search/ResultList";

export interface CommandContext {
  pushView: (viewId: string) => void;
}

export interface CommandHandler {
  prefix: string;
  /** Human-readable name shown in docs/debugging */
  name: string;
  /**
   * Return matched results for the given query (the part after the prefix).
   * The full raw input is also provided for edge cases.
   */
  handle: (query: string, ctx: CommandContext, rawInput: string) => ResultItem[];
}

class CommandRouter {
  private handlers: CommandHandler[] = [];

  register(handler: CommandHandler): void {
    this.handlers.push(handler);
    this.handlers.sort((a, b) => b.prefix.length - a.prefix.length);
  }

  /**
   * Try matching input against registered prefix handlers.
   * Returns results from the first matching handler, or `null` if none matched.
   */
  match(input: string, ctx: CommandContext): ResultItem[] | null {
    for (const h of this.handlers) {
      if (
        input.startsWith(h.prefix + " ") ||
        input === h.prefix
      ) {
        const query = input.slice(h.prefix.length).trimStart();
        return h.handle(query, ctx, input);
      }
    }
    return null;
  }
}

export const commandRouter = new CommandRouter();
