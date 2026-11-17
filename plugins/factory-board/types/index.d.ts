export type BoardLines = readonly string[];

declare module 'claude-code' {
  interface PluginState {
    'factory-board': {
      lines: Shaped<BoardLines>;
      fault: string | null;
      ranAt: string | null;
      columns: number;
      running: boolean;
    };
  }
}
